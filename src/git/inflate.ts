// A small zlib inflater (RFC 1950 framing, RFC 1951 deflate) for the many small objects a push carries.
//
// node:zlib's sync API builds a native stream, its buffers and a Duplex per call, which for a 200-byte
// commit or a 1 KiB blob costs more than the decompression itself. This decodes straight into a buffer of
// the size the pack header declares, reports how many input bytes the stream used (a pack entry's end is
// only known by inflating it), and checks the stream's Adler-32. Large objects still go to node:zlib.
//
// Decoding is table driven: every Huffman code of up to FAST_BITS bits resolves with one lookup in a table
// indexed by the next FAST_BITS input bits; a longer code (rare) falls back to walking the canonical code
// bit by bit. The bit buffer lives in local variables and is refilled to at least 24 bits whenever input
// remains, so a literal, or a length with its distance, needs at most two refills.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const FAST_BITS = 9;
const FAST_SIZE = 1 << FAST_BITS;

/** FAST_BITS-bit values bit-reversed: deflate sends a Huffman code's first bit in an input byte's low bit. */
const REVERSED = new Uint16Array(FAST_SIZE);
for (let value = 0; value < FAST_SIZE; value += 1) {
  let reversed = 0;
  for (let bit = 0; bit < FAST_BITS; bit += 1) if (value & (1 << bit)) reversed |= 1 << (FAST_BITS - 1 - bit);
  REVERSED[value] = reversed;
}

/**
 * A canonical Huffman code: how many codes of each length and the symbols in code order (for codes longer
 * than the table), and the fast table: indexed by the next `mask + 1` input bits' worth of codes (the
 * code's longest length, at most FAST_BITS), each slot (symbol << 4) | code length, or 0 when no code that
 * short matches. A table only as wide as its longest code keeps a small code's setup small.
 */
interface Tree {
  readonly counts: Uint16Array;
  readonly symbols: Uint16Array;
  readonly fast: Uint16Array;
  mask: number;
}

function newTree(): Tree {
  return { counts: new Uint16Array(16), symbols: new Uint16Array(320), fast: new Uint16Array(FAST_SIZE), mask: 0 };
}

class InflateError extends Error {}

const OFFSETS = new Uint16Array(16);
const NEXT_CODE = new Uint16Array(16);

function buildTree(tree: Tree, lengths: Uint8Array, offset: number, count: number): void {
  const counts = tree.counts;
  counts.fill(0);
  for (let i = 0; i < count; i += 1) counts[lengths[offset + i] as number] += 1;
  counts[0] = 0;
  let left = 1;
  let longest = 1;
  for (let len = 1; len < 16; len += 1) {
    left = left * 2 - (counts[len] as number);
    if (left < 0) throw new InflateError('over-subscribed Huffman code');
    if ((counts[len] as number) > 0) longest = len;
  }
  const tableBits = longest < FAST_BITS ? longest : FAST_BITS;
  const tableSize = 1 << tableBits;
  tree.mask = tableSize - 1;
  OFFSETS[1] = 0;
  for (let len = 1; len < 15; len += 1) OFFSETS[len + 1] = (OFFSETS[len] as number) + (counts[len] as number);
  let code = 0;
  for (let len = 1; len < 16; len += 1) {
    code = (code + (counts[len - 1] as number)) << 1;
    NEXT_CODE[len] = code;
  }
  const symbols = tree.symbols;
  const fast = tree.fast;
  fast.fill(0, 0, tableSize);
  for (let i = 0; i < count; i += 1) {
    const len = lengths[offset + i] as number;
    if (len === 0) continue;
    symbols[OFFSETS[len]++] = i;
    if (len <= tableBits) {
      // REVERSED over FAST_BITS bits of the code placed at the window's top leaves it reversed in the low
      // `len` bits, which is where the stream's next bits put it.
      const entry = (i << 4) | len;
      const step = 1 << len;
      for (let k = REVERSED[(NEXT_CODE[len]++ as number) << (FAST_BITS - len)] as number; k < tableSize; k += step) fast[k] = entry;
    }
  }
}

/**
 * The canonical walk for a code the fast table does not hold: reads up to 15 bits from `tag` (which holds
 * `bits` valid bits) and returns (symbol << 4) | code length.
 */
function slowDecode(tree: Tree, tag: number, bits: number): number {
  const counts = tree.counts;
  let code = 0;
  let first = 0;
  let index = 0;
  for (let len = 1; len < 16; len += 1) {
    if (len > bits) throw new InflateError('the deflate stream is truncated');
    code |= (tag >>> (len - 1)) & 1;
    const count = counts[len] as number;
    if (code - count < first) return ((tree.symbols[index + code - first] as number) << 4) | len;
    index += count;
    first = (first + count) << 1;
    code <<= 1;
  }
  throw new InflateError('bad Huffman code');
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
  const srcLen = src.length;
  const cmf = src[start];
  const flg = src[start + 1];
  if (cmf === undefined || flg === undefined || (cmf & 0x0f) !== 8 || ((cmf << 8) | flg) % 31 !== 0 || (flg & 0x20) !== 0) {
    throw new InflateError('not a zlib stream');
  }
  const out = Buffer.allocUnsafe(size);
  let pos = start + 2;
  let op = 0;
  // The bit buffer: `bits` valid bits in `tag`, the next input bit lowest. Refills stop below 32 bits.
  let tag = 0;
  let bits = 0;
  const lengths = LENGTHS;
  let final = 0;
  do {
    while (bits < 24 && pos < srcLen) {
      tag |= (src[pos++] as number) << bits;
      bits += 8;
    }
    if (bits < 3) throw new InflateError('the deflate stream is truncated');
    final = tag & 1;
    const type = (tag >>> 1) & 3;
    tag >>>= 3;
    bits -= 3;
    if (type === 0) {
      // A stored block starts at the next byte boundary: hand back the whole bytes the buffer holds.
      pos -= bits >>> 3;
      tag = 0;
      bits = 0;
      if (pos + 4 > srcLen) throw new InflateError('the stored block is truncated');
      const len = (src[pos] as number) | ((src[pos + 1] as number) << 8);
      const nlen = (src[pos + 2] as number) | ((src[pos + 3] as number) << 8);
      if ((len ^ 0xffff) !== nlen) throw new InflateError('bad stored block length');
      pos += 4;
      if (pos + len > srcLen || op + len > size) throw new InflateError('the stored block overruns');
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
      // 14 header bits, then 3 bits per code-length code: refill as it goes.
      if (bits < 14) throw new InflateError('the deflate stream is truncated');
      const hlit = (tag & 0x1f) + 257;
      const hdist = ((tag >>> 5) & 0x1f) + 1;
      const hclen = ((tag >>> 10) & 0x0f) + 4;
      tag >>>= 14;
      bits -= 14;
      lengths.fill(0, 0, 19);
      for (let i = 0; i < hclen; i += 1) {
        while (bits < 24 && pos < srcLen) {
          tag |= (src[pos++] as number) << bits;
          bits += 8;
        }
        if (bits < 3) throw new InflateError('the deflate stream is truncated');
        lengths[CLEN_ORDER[i] as number] = tag & 7;
        tag >>>= 3;
        bits -= 3;
      }
      const codeLengths = CODE_LENGTHS;
      buildTree(codeLengths, lengths, 0, 19);
      const clFast = codeLengths.fast;
      const clMask = codeLengths.mask;
      const total = hlit + hdist;
      for (let i = 0; i < total; ) {
        while (bits < 24 && pos < srcLen) {
          tag |= (src[pos++] as number) << bits;
          bits += 8;
        }
        let entry = clFast[tag & clMask] as number;
        if (entry === 0 || (entry & 15) > bits) entry = slowDecode(codeLengths, tag, bits);
        tag >>>= entry & 15;
        bits -= entry & 15;
        const sym = entry >>> 4;
        if (sym < 16) {
          lengths[i++] = sym;
          continue;
        }
        let repeat: number;
        let value = 0;
        if (sym === 16) {
          if (i === 0) throw new InflateError('a repeat with no previous length');
          if (bits < 2) throw new InflateError('the deflate stream is truncated');
          value = lengths[i - 1] as number;
          repeat = 3 + (tag & 3);
          tag >>>= 2;
          bits -= 2;
        } else if (sym === 17) {
          if (bits < 3) throw new InflateError('the deflate stream is truncated');
          repeat = 3 + (tag & 7);
          tag >>>= 3;
          bits -= 3;
        } else {
          if (bits < 7) throw new InflateError('the deflate stream is truncated');
          repeat = 11 + (tag & 0x7f);
          tag >>>= 7;
          bits -= 7;
        }
        if (i + repeat > total) throw new InflateError('the code lengths overrun');
        lengths.fill(value, i, i + repeat);
        i += repeat;
      }
      if (lengths[256] === 0) throw new InflateError('the block has no end-of-block code');
      buildTree(LITERALS, lengths, 0, hlit);
      buildTree(DISTANCES, lengths, hlit, hdist);
      lt = LITERALS;
      dt = DISTANCES;
    } else {
      throw new InflateError('reserved block type');
    }
    const lfast = lt.fast;
    const lmask = lt.mask;
    const dfast = dt.fast;
    const dmask = dt.mask;
    for (;;) {
      while (bits < 24 && pos < srcLen) {
        tag |= (src[pos++] as number) << bits;
        bits += 8;
      }
      let entry = lfast[tag & lmask] as number;
      if (entry === 0 || (entry & 15) > bits) entry = slowDecode(lt, tag, bits);
      tag >>>= entry & 15;
      bits -= entry & 15;
      const sym = entry >>> 4;
      if (sym < 256) {
        if (op >= size) throw new InflateError('the stream inflates past its declared size');
        out[op++] = sym;
        continue;
      }
      if (sym === 256) break;
      const index = sym - 257;
      if (index >= 29) throw new InflateError('bad length symbol');
      // At least 9 bits remain after a literal/length code read from a 24-bit buffer; the length's extra
      // bits are at most 5. The distance code and its extra bits come after one more refill.
      const lengthExtra = LENGTH_EXTRA[index] as number;
      if (bits < lengthExtra) throw new InflateError('the deflate stream is truncated');
      const length = (LENGTH_BASE[index] as number) + (tag & ((1 << lengthExtra) - 1));
      tag >>>= lengthExtra;
      bits -= lengthExtra;
      while (bits < 24 && pos < srcLen) {
        tag |= (src[pos++] as number) << bits;
        bits += 8;
      }
      let dentry = dfast[tag & dmask] as number;
      if (dentry === 0 || (dentry & 15) > bits) dentry = slowDecode(dt, tag, bits);
      tag >>>= dentry & 15;
      bits -= dentry & 15;
      const dsym = dentry >>> 4;
      if (dsym >= 30) throw new InflateError('bad distance symbol');
      const distExtra = DIST_EXTRA[dsym] as number;
      if (bits < distExtra) {
        while (bits < 24 && pos < srcLen) {
          tag |= (src[pos++] as number) << bits;
          bits += 8;
        }
        if (bits < distExtra) throw new InflateError('the deflate stream is truncated');
      }
      const distance = (DIST_BASE[dsym] as number) + (tag & ((1 << distExtra) - 1));
      tag >>>= distExtra;
      bits -= distExtra;
      if (distance > op || op + length > size) throw new InflateError('a back-reference is out of range');
      // Matches are mostly a few bytes long: a byte loop beats a native copy call there. The loop also
      // gives an overlapping match (distance < length) its repeating meaning.
      if (length > 64 && distance >= length) {
        out.copyWithin(op, op - distance, op - distance + length);
        op += length;
      } else {
        for (let from = op - distance, stop = op + length; op < stop; op += 1, from += 1) out[op] = out[from] as number;
      }
    }
  } while (final === 0);
  if (op !== size) throw new InflateError(`the stream inflated to ${op} bytes, not ${size}`);
  pos -= bits >>> 3;
  if (pos + 4 > srcLen) throw new InflateError('the Adler-32 trailer is missing');
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
