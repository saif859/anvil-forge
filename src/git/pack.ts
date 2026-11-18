// Packfile version 2: read (plain objects, OFS_DELTA and REF_DELTA, thin-pack bases from the store) and write
// (plain objects, or an OFS_DELTA against an earlier entry when that is clearly smaller). Every delta the
// writer makes is applied back and compared before it is used, so a delta bug can cost bytes, never data.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { CODE_TYPE, TYPE_CODE, hashObject, sha1Hex, type GitObject, type ObjectType } from './objects.ts';
import { inflateZlib } from './inflate.ts';

export interface UnpackedObject {
  readonly oid: string;
  readonly type: ObjectType;
  readonly data: Buffer;
}

/** Objects up to this size inflate in TypeScript; larger ones go to node:zlib. */
const SMALL_OBJECT = 16 * 1024;

function inflateAt(pack: Buffer, offset: number, end: number, size: number): { data: Buffer; next: number } {
  if (size <= SMALL_OBJECT) {
    const inflated = inflateZlib(pack, offset, size);
    if (inflated.next > end) throw new Error(`zlib stream at ${offset} runs into the pack trailer`);
    return inflated;
  }
  const result = inflateSync(pack.subarray(offset, end), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const used = result.engine.bytesWritten;
  if (!(used > 0)) throw new Error(`zlib stream at ${offset} consumed nothing`);
  return { data: result.buffer, next: offset + used };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const size = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at++];
      if (byte === undefined) throw new Error('truncated delta header');
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const baseSize = size();
  const targetSize = size();
  if (baseSize !== base.length) throw new Error(`delta base is ${base.length} bytes, expected ${baseSize}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at++] as number;
    if (op & 0x80) {
      let offset = 0;
      let length = 0;
      if (op & 0x01) offset |= delta[at++] as number;
      if (op & 0x02) offset |= (delta[at++] as number) << 8;
      if (op & 0x04) offset |= (delta[at++] as number) << 16;
      if (op & 0x08) offset += (delta[at++] as number) * 0x1000000;
      if (op & 0x10) length |= delta[at++] as number;
      if (op & 0x20) length |= (delta[at++] as number) << 8;
      if (op & 0x40) length |= (delta[at++] as number) << 16;
      if (length === 0) length = 0x10000;
      if (offset + length > base.length || written + length > targetSize) throw new Error('delta copy out of range');
      base.copy(out, written, offset, offset + length);
      written += length;
    } else if (op !== 0) {
      if (at + op > delta.length || written + op > targetSize) throw new Error('delta insert out of range');
      delta.copy(out, written, at, at + op);
      at += op;
      written += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Parse a pack. `lookup` resolves a REF_DELTA base the pack leaves out (a thin pack). Each object's id is
 * computed here from its resolved bytes.
 */
export function readPack(pack: Buffer, lookup: (oid: string) => GitObject | undefined): UnpackedObject[] {
  if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version} is not supported`);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const trailer = pack.toString('hex', end);
  if (sha1Hex(pack.subarray(0, end)) !== trailer) throw new Error('pack checksum mismatch');

  interface Entry {
    offset: number;
    code: number;
    data: Buffer;
    baseOffset: number;
    baseOid: string;
    resolved: UnpackedObject | null;
  }
  const entries: Entry[] = [];
  const byOffset = new Map<number, Entry>();
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const offset = at;
    let byte = pack[at++] as number;
    const code = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at++] as number;
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    let baseOffset = -1;
    let baseOid = '';
    if (code === 6) {
      byte = pack[at++] as number;
      let rel = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[at++] as number;
        rel = (rel + 1) * 128 + (byte & 0x7f);
      }
      baseOffset = offset - rel;
    } else if (code === 7) {
      baseOid = pack.toString('hex', at, at + 20);
      at += 20;
    } else if (CODE_TYPE[code] === undefined) {
      throw new Error(`pack entry ${index} has type ${code}`);
    }
    const inflated = inflateAt(pack, at, end, size);
    if (inflated.data.length !== size) throw new Error(`pack entry ${index} inflated to ${inflated.data.length}, not ${size}`);
    at = inflated.next;
    const entry: Entry = { offset, code, data: inflated.data, baseOffset, baseOid, resolved: null };
    entries.push(entry);
    byOffset.set(offset, entry);
  }
  if (at !== end) throw new Error('pack has bytes after its last entry');

  const byOid = new Map<string, UnpackedObject>();
  const deferred = new Error('base not resolved yet');
  const resolve = (entry: Entry, depth: number): UnpackedObject => {
    if (entry.resolved !== null) return entry.resolved;
    if (depth > 10_000) throw new Error('delta chain too deep');
    let type: ObjectType;
    let data: Buffer;
    if (entry.code === 6) {
      const base = byOffset.get(entry.baseOffset);
      if (base === undefined) throw new Error('ofs-delta base is not in the pack');
      const resolvedBase = resolve(base, depth + 1);
      type = resolvedBase.type;
      data = applyDelta(resolvedBase.data, entry.data);
    } else if (entry.code === 7) {
      const base: GitObject | undefined = byOid.get(entry.baseOid) ?? lookup(entry.baseOid);
      if (base === undefined) throw deferred;
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else {
      type = CODE_TYPE[entry.code] as ObjectType;
      data = entry.data;
    }
    const resolved: UnpackedObject = { oid: hashObject(type, data), type, data };
    entry.resolved = resolved;
    byOid.set(resolved.oid, resolved);
    return resolved;
  };
  // Plain objects first; then deltas, pass after pass, since a REF_DELTA may name a base that is itself a
  // delta later in the pack. A pass that resolves nothing new means a base is truly missing.
  for (const entry of entries) if (entry.code < 6) resolve(entry, 0);
  let open = entries.filter((entry) => entry.resolved === null);
  while (open.length > 0) {
    const before = open.length;
    for (const entry of open) {
      try {
        resolve(entry, 0);
      } catch (err) {
        if (err !== deferred) throw err;
      }
    }
    open = open.filter((entry) => entry.resolved === null);
    if (open.length === before) throw new Error(`ref-delta base ${open[0]?.baseOid ?? ''} is missing`);
  }
  return entries.map((entry) => entry.resolved as UnpackedObject);
}

// ---------------------------------------------------------------- writing

function entryHeader(code: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function ofsBytes(distance: number): Buffer {
  const bytes = [distance & 0x7f];
  let rest = Math.floor(distance / 128);
  while (rest > 0) {
    rest -= 1;
    bytes.unshift(0x80 | (rest & 0x7f));
    rest = Math.floor(rest / 128);
  }
  return Buffer.from(bytes);
}

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    out.push(byte);
  } while (rest > 0);
  return out;
}

const BLOCK = 16;

/**
 * A git delta turning `base` into `target`: every 16-byte block of the base is indexed, the target is scanned
 * for matching blocks, and each match is extended both ways into one copy. Null when the delta would not be
 * well under the target's own size.
 */
export function makeDelta(base: Buffer, target: Buffer): Buffer | null {
  if (base.length < BLOCK * 2 || target.length < BLOCK * 2) return null;
  const index = new Map<string, number>();
  for (let at = 0; at + BLOCK <= base.length; at += BLOCK) {
    const key = base.toString('latin1', at, at + BLOCK);
    if (!index.has(key)) index.set(key, at);
  }
  const out: number[] = [...varint(base.length), ...varint(target.length)];
  let literalStart = 0;
  const flushLiteral = (upTo: number): void => {
    let from = literalStart;
    while (from < upTo) {
      const length = Math.min(127, upTo - from);
      out.push(length);
      for (let i = 0; i < length; i += 1) out.push(target[from + i] as number);
      from += length;
    }
  };
  const emitCopy = (offset: number, length: number): void => {
    let rest = length;
    let from = offset;
    while (rest > 0) {
      const chunk = Math.min(rest, 0xffffff);
      let op = 0x80;
      const args: number[] = [];
      for (let byte = 0; byte < 4; byte += 1) {
        const value = Math.floor(from / 2 ** (8 * byte)) & 0xff;
        if (value !== 0) {
          op |= 1 << byte;
          args.push(value);
        }
      }
      for (let byte = 0; byte < 3; byte += 1) {
        const value = (chunk >> (8 * byte)) & 0xff;
        if (value !== 0) {
          op |= 0x10 << byte;
          args.push(value);
        }
      }
      out.push(op, ...args);
      from += chunk;
      rest -= chunk;
    }
  };
  let at = 0;
  while (at + BLOCK <= target.length) {
    const hit = index.get(target.toString('latin1', at, at + BLOCK));
    if (hit === undefined) {
      at += 1;
      continue;
    }
    let start = at;
    let baseStart = hit;
    while (start > literalStart && baseStart > 0 && target[start - 1] === base[baseStart - 1]) {
      start -= 1;
      baseStart -= 1;
    }
    let end = at + BLOCK;
    let baseEnd = hit + BLOCK;
    while (end < target.length && baseEnd < base.length && target[end] === base[baseEnd]) {
      end += 1;
      baseEnd += 1;
    }
    flushLiteral(start);
    emitCopy(baseStart, end - start);
    literalStart = end;
    at = end;
    if (out.length > target.length) return null;
  }
  flushLiteral(target.length);
  if (out.length * 2 > target.length) return null;
  const delta = Buffer.from(out);
  return applyDelta(base, delta).equals(target) ? delta : null;
}

export interface PackInput {
  readonly oid: string;
  readonly object: GitObject;
  /** An earlier entry's oid to try a delta against. */
  readonly deltaBase?: string;
}

/** A pack's bytes as parts (header, entries, trailer), ready for side-band framing without one big join. */
export function writePack(inputs: readonly PackInput[], deflated: (oid: string, object: GitObject) => Buffer): Buffer[] {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(inputs.length, 8);
  const parts: Buffer[] = [header];
  const hash = createHash('sha1').update(header);
  const offsets = new Map<string, number>();
  const sources = new Map<string, GitObject>();
  let offset = 12;
  for (const input of inputs) {
    let entry: Buffer[] | null = null;
    if (input.deltaBase !== undefined) {
      const baseOffset = offsets.get(input.deltaBase);
      const base = sources.get(input.deltaBase);
      if (baseOffset !== undefined && base !== undefined && base.type === input.object.type) {
        const delta = makeDelta(base.data, input.object.data);
        if (delta !== null) entry = [entryHeader(6, delta.length), ofsBytes(offset - baseOffset), deflateSync(delta)];
      }
    }
    if (entry === null) entry = [entryHeader(TYPE_CODE[input.object.type], input.object.data.length), deflated(input.oid, input.object)];
    offsets.set(input.oid, offset);
    sources.set(input.oid, input.object);
    for (const part of entry) {
      parts.push(part);
      hash.update(part);
      offset += part.length;
    }
  }
  parts.push(hash.digest());
  return parts;
}
