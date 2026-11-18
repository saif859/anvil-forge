// A small zlib inflater (RFC 1950 framing, RFC 1951 deflate) for the many small objects a push carries.
//
// node:zlib's sync API builds a native stream, its buffers and a Duplex per call, which for a 200-byte
// commit or a 1 KiB blob costs more than the decompression itself. This decodes straight into a buffer of
// the size the pack header declares, reports how many input bytes the stream used (a pack entry's end is
// only known by inflating it), and checks the stream's Adler-32. Large objects still go to node:zlib.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A canonical Huffman code: how many codes of each length, and the symbols in code order. */
interface Tree {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
}

function newTree(): Tree {
  return { counts: new Uint16Array(16), symbols: new Uint16Array(320) };
}

const NEXT = new Uint16Array(16);

function buildTree(tree: Tree, lengths: Uint8Array, offset: number, count: number): void {
  const counts = tree.counts;
  counts.fill(0);
  for (let i = 0; i < count; i += 1) counts[lengths[offset + i] as number] += 1;
  counts[0] = 0;
  const next = NEXT;
  for (let len = 1, sum = 0; len < 16; len += 1) {
    next[len] = sum;
    sum += counts[len] as number;
  }
  for (let i = 0; i < count; i += 1) {
    const len = lengths[offset + i] as number;
    if (len !== 0) tree.symbols[next[len]++] = i;
  }
}

const FIXED_LITERALS = newTree();
const FIXED_DISTANCES = newTree();
{
  const lengths = new Uint8Array(320);
  lengths.fill(8, 0, 144);
  lengths.fill(9, 144, 256);
  lengths.fill(7, 256, 280);
  lengths.fill(8, 280, 288);
  buildTree(FIXED_LITERALS, lengths, 0, 288);
  lengths.fill(5, 0, 30);
  buildTree(FIXED_DISTANCES, lengths, 0, 30);
}

class InflateError extends Error {}

// Scratch tables for dynamic blocks, allocated once: inflateZlib runs synchronously and never re-enters.
const LITERALS = newTree();
const DISTANCES = newTree();
const CODE_LENGTHS = newTree();
const LENGTHS = new Uint8Array(320);

/**
 * Inflate the zlib stream at `start` in `src` into exactly `size` bytes. Returns the bytes and the offset
 * just past the stream's Adler-32 trailer. Throws on any malformed stream or a size mismatch.
 */
export function inflateZlib(src: Buffer, start: number, size: number): { data: Buffer; next: number } {
  let pos = start;
  const cmf = src[pos++];
  const flg = src[pos++];
  if (cmf === undefined || flg === undefined || (cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20) !== 0) {
    throw new InflateError('not a zlib stream');
  }
  const out = Buffer.allocUnsafe(size);
  let op = 0;
  let tag = 0;
  let bits = 0;

  const need = (n: number): void => {
    while (bits < n) {
      const byte = src[pos++];
      if (byte === undefined) throw new InflateError('the deflate stream is truncated');
      tag |= byte << bits;
      bits += 8;
    }
  };
  const take = (n: number): number => {
    if (n === 0) return 0;
    need(n);
    const value = tag & ((1 << n) - 1);
    tag >>>= n;
    bits -= n;
    return value;
  };
  const decode = (tree: Tree): number => {
    let sum = 0;
    let cur = 0;
    let len = 0;
    const counts = tree.counts;
    do {
      if (bits === 0) need(1);
      cur = 2 * cur + (tag & 1);
      tag >>>= 1;
      bits -= 1;
      len += 1;
      if (len > 15) throw new InflateError('bad Huffman code');
      const count = counts[len] as number;
      sum += count;
      cur -= count;
    } while (cur >= 0);
    return tree.symbols[sum + cur] as number;
  };

  const literals = LITERALS;
  const distances = DISTANCES;
  const lengths = LENGTHS;
  let final = 0;
  do {
    final = take(1);
    const type = take(2);
    if (type === 0) {
      pos -= bits >>> 3;
      tag = 0;
      bits = 0;
      if (pos + 4 > src.length) throw new InflateError('the stored block is truncated');
      const len = (src[pos] as number) | ((src[pos + 1] as number) << 8);
      const nlen = (src[pos + 2] as number) | ((src[pos + 3] as number) << 8);
      if ((len ^ 0xffff) !== nlen) throw new InflateError('bad stored block length');
      pos += 4;
      if (pos + len > src.length || op + len > size) throw new InflateError('the stored block overruns');
      src.copy(out, op, pos, pos + len);
      pos += len;
      op += len;
      continue;
    }
    let lt: Tree;
    let dt: Tree;
    if (type === 1) {
      lt = FIXED_LITERALS;
      dt = FIXED_DISTANCES;
    } else if (type === 2) {
      const hlit = take(5) + 257;
      const hdist = take(5) + 1;
      const hclen = take(4) + 4;
      lengths.fill(0, 0, 19);
      for (let i = 0; i < hclen; i += 1) lengths[CLEN_ORDER[i] as number] = take(3);
      const codeLengths = CODE_LENGTHS;
      buildTree(codeLengths, lengths, 0, 19);
      for (let i = 0; i < hlit + hdist; ) {
        const sym = decode(codeLengths);
        if (sym < 16) {
          lengths[i++] = sym;
          continue;
        }
        let repeat: number;
        let value = 0;
        if (sym === 16) {
          if (i === 0) throw new InflateError('a repeat with no previous length');
          value = lengths[i - 1] as number;
          repeat = 3 + take(2);
        } else if (sym === 17) {
          repeat = 3 + take(3);
        } else {
          repeat = 11 + take(7);
        }
        if (i + repeat > hlit + hdist) throw new InflateError('the code lengths overrun');
        lengths.fill(value, i, i + repeat);
        i += repeat;
      }
      buildTree(literals, lengths, 0, hlit);
      buildTree(distances, lengths, hlit, hdist);
      lt = literals;
      dt = distances;
    } else {
      throw new InflateError('reserved block type');
    }
    for (;;) {
      const sym = decode(lt);
      if (sym < 256) {
        if (op >= size) throw new InflateError('the stream inflates past its declared size');
        out[op++] = sym;
        continue;
      }
      if (sym === 256) break;
      const index = sym - 257;
      if (index >= 29) throw new InflateError('bad length symbol');
      const length = (LENGTH_BASE[index] as number) + take(LENGTH_EXTRA[index] as number);
      const dsym = decode(dt);
      if (dsym >= 30) throw new InflateError('bad distance symbol');
      const distance = (DIST_BASE[dsym] as number) + take(DIST_EXTRA[dsym] as number);
      if (distance > op || op + length > size) throw new InflateError('a back-reference is out of range');
      if (distance >= length) {
        out.copy(out, op, op - distance, op - distance + length);
        op += length;
      } else {
        for (let i = 0; i < length; i += 1, op += 1) out[op] = out[op - distance] as number;
      }
    }
  } while (final === 0);
  if (op !== size) throw new InflateError(`the stream inflated to ${op} bytes, not ${size}`);
  pos -= bits >>> 3;
  if (pos + 4 > src.length) throw new InflateError('the Adler-32 trailer is missing');
  let a = 1;
  let b = 0;
  for (let i = 0; i < size; i += 1) {
    a += out[i] as number;
    b += a;
    if ((i & 4095) === 4095) {
      a %= 65521;
      b %= 65521;
    }
  }
  a %= 65521;
  b %= 65521;
  const expected = src.readUInt32BE(pos);
  if (((b << 16) | a) >>> 0 !== expected) throw new InflateError('Adler-32 mismatch');
  return { data: out, next: pos + 4 };
}
