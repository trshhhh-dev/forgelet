// The packfile format: one header, N compressed entries, and a SHA-1 trailer over everything before
// it.  The reader accepts all four base types plus both delta encodings (OFS_DELTA names its base by
// distance in this pack; REF_DELTA names it by object id, possibly one the receiver already holds, as
// a thin pack does).  The writer emits whole objects only: valid packs do not need deltas, and the
// conformance client accepts whole-object packs for both directions.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { type GitObject, type GitObjectType, type ObjectLookup } from './objects.ts';

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TYPE: Readonly<Record<number, GitObjectType>> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

const OFS_DELTA = 6;
const REF_DELTA = 7;

/** Object id from the loose-object header and content, without allocating a separate header Buffer. */
function hashObjectFast(type: GitObjectType, data: Uint8Array): string {
  return createHash('sha1').update(`${type} ${data.length}\u0000`).update(data).digest('hex');
}

export class PackError extends Error {
  readonly code: string;

  constructor(message: string, code = 'pack') {
    super(message);
    this.name = 'PackError';
    this.code = code;
  }
}

export interface ReadPackOptions {
  /** A base object the pack leaves out; used to resolve a thin pack's REF_DELTA entries. */
  readonly resolveBase?: ObjectLookup;
}

export interface PackReadResult {
  readonly version: number;
  readonly declaredCount: number;
  /** Every resolved object, keyed by its recomputed SHA-1. */
  readonly objects: Map<string, GitObject>;
  /** Number of OFS_DELTA or REF_DELTA entries. */
  readonly deltaCount: number;
  /** True when the 20-byte trailer matches the SHA-1 of the preceding bytes. */
  readonly checksumOk: boolean;
}

/** `inflateSync` with `info: true` reports how many input bytes the stream consumed. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    // The stream ends at its own zlib trailer, so it never reads into the pack trailer or the next
    // entry.  One subarray instead of slicing the whole body and then slicing again at `offset`.
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new PackError(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`, 'pack-zlib');
  }
  const written = result.engine.bytesWritten;
  if (typeof written !== 'number' || written <= 0) {
    throw new PackError(`zlib stream at offset ${offset} consumed no input`, 'pack-zlib');
  }
  return { data: result.buffer, next: offset + written };
}

/** The type/size header of a pack entry. */
function readEntryHeader(buffer: Buffer, offset: number): { typeCode: number; size: number; next: number } {
  if (offset >= buffer.length) throw new PackError('pack entry header is truncated', 'pack-truncated');
  let byte = buffer[offset] as number;
  let cursor = offset + 1;
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    if (cursor >= buffer.length) throw new PackError('pack entry size varint is truncated', 'pack-truncated');
    byte = buffer[cursor] as number;
    cursor += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 60) throw new PackError('pack entry size varint is too long', 'pack-header');
  }
  return { typeCode, size, next: cursor };
}

/** The big-endian offset delta used by OFS_DELTA. */
function readOfsDistance(buffer: Buffer, offset: number): { distance: number; next: number } {
  if (offset >= buffer.length) throw new PackError('ofs-delta has no base distance', 'pack-truncated');
  let byte = buffer[offset] as number;
  let cursor = offset + 1;
  let distance = byte & 0x7f;
  while (byte & 0x80) {
    if (cursor >= buffer.length) throw new PackError('ofs-delta base distance is truncated', 'pack-truncated');
    byte = buffer[cursor] as number;
    cursor += 1;
    distance = ((distance + 1) * 128) + (byte & 0x7f);
  }
  return { distance, next: cursor };
}

/** Apply a git delta instruction stream to a base object. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.from(base);
  const buffer = Buffer.from(delta);
  let offset = 0;

  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= buffer.length) throw new PackError('delta size varint is truncated', 'delta-corrupt');
      const byte = buffer[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) break;
      shift += 7;
      if (shift > 63) throw new PackError('delta size varint is too long', 'delta-corrupt');
    }
    return value;
  };

  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) {
    throw new PackError(`delta expects a ${sourceSize}-byte base, got ${baseBuffer.length}`, 'delta-base-size');
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < buffer.length) {
    const op = buffer[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= buffer.length) throw new PackError('delta copy offset is truncated', 'delta-corrupt');
          copyOffset += (buffer[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= buffer.length) throw new PackError('delta copy size is truncated', 'delta-corrupt');
          copySize += (buffer[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuffer.length) throw new PackError('delta copy runs past its base', 'delta-corrupt');
      if (written + copySize > targetSize) throw new PackError('delta copy writes past its target size', 'delta-corrupt');
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > buffer.length) throw new PackError('delta insert is truncated', 'delta-corrupt');
      if (written + literal > targetSize) throw new PackError('delta insert writes past its target size', 'delta-corrupt');
      buffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new PackError('delta opcode 0 is invalid', 'delta-corrupt');
    }
  }
  if (written !== targetSize) {
    throw new PackError(`delta produced ${written} of ${targetSize} bytes`, 'delta-size');
  }
  return out;
}

interface RawEntry {
  readonly offset: number;
  readonly typeCode: number;
  readonly size: number;
  readonly deltaData: Buffer;
  readonly baseOffset?: number;
  readonly baseOid?: string;
  resolvedType?: GitObjectType;
  resolvedData?: Buffer;
  resolvedOid?: string;
}

/** Parse and resolve a packfile; every object's SHA-1 is recomputed, never trusted from the input. */
export function readPack(pack: Uint8Array, options: ReadPackOptions = {}): PackReadResult {
  const buffer = Buffer.from(pack);
  if (buffer.length < 32) throw new PackError(`pack is ${buffer.length} bytes, too short`, 'pack-truncated');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new PackError('pack does not start with PACK', 'pack-header');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new PackError(`unsupported pack version ${version}`, 'pack-version');
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  const checksumOk = trailer === computedTrailer;
  if (!checksumOk) {
    throw new PackError(`pack trailer ${trailer} does not match the bytes ${computedTrailer}`, 'pack-checksum');
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readEntryHeader(buffer, offset);
    offset = header.next;
    const typeCode = header.typeCode;
    if (typeCode !== OFS_DELTA && typeCode !== REF_DELTA && CODE_TYPE[typeCode] === undefined) {
      throw new PackError(`pack entry ${index} has unknown type code ${typeCode}`, 'pack-type');
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeCode === OFS_DELTA) {
      const base = readOfsDistance(buffer, offset);
      offset = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) {
        throw new PackError(`ofs-delta at ${entryOffset} names an invalid base distance ${base.distance}`, 'pack-delta');
      }
      baseOffset = entryOffset - base.distance;
    } else if (typeCode === REF_DELTA) {
      if (offset + 20 > trailerStart) throw new PackError('ref-delta base id is truncated', 'pack-truncated');
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(buffer, offset);
    if (inflated.data.length !== header.size) {
      throw new PackError(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
        'pack-size',
      );
    }
    if (inflated.next > trailerStart) throw new PackError('pack entry runs into the trailer', 'pack-truncated');
    const entry: RawEntry = {
      offset: entryOffset,
      typeCode,
      size: header.size,
      deltaData: inflated.data,
      baseOffset,
      baseOid,
    };
    raw.push(entry);
    byOffset.set(entryOffset, entry);
    offset = inflated.next;
  }
  if (offset !== trailerStart) {
    throw new PackError(`pack has ${trailerStart - offset} stray bytes before its trailer`, 'pack-trailing');
  }

  const resolvedByOid = new Map<string, RawEntry>();
  const settle = (entry: RawEntry, type: GitObjectType, data: Buffer): void => {
    entry.resolvedType = type;
    entry.resolvedData = data;
    entry.resolvedOid = hashObjectFast(type, data);
    resolvedByOid.set(entry.resolvedOid, entry);
  };

  // Whole objects first: a delta can then resolve against them by offset or id.
  for (const entry of raw) {
    const type = CODE_TYPE[entry.typeCode];
    if (type !== undefined) settle(entry, type, entry.deltaData);
  }

  // Resolve deltas in passes; a REF_DELTA may name a base that appears later in the same pack.
  let remaining = raw.filter((entry) => entry.resolvedOid === undefined);
  while (remaining.length > 0) {
    let progress = false;
    const still: RawEntry[] = [];
    for (const entry of remaining) {
      let base: { type: GitObjectType; data: Buffer } | null = null;
      if (entry.typeCode === OFS_DELTA) {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry === undefined) {
          throw new PackError(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`, 'pack-delta-base');
        }
        if (baseEntry.resolvedType !== undefined && baseEntry.resolvedData !== undefined) {
          base = { type: baseEntry.resolvedType, data: baseEntry.resolvedData };
        }
      } else {
        const wanted = entry.baseOid as string;
        const inPack = resolvedByOid.get(wanted);
        if (inPack !== undefined && inPack.resolvedType !== undefined && inPack.resolvedData !== undefined) {
          base = { type: inPack.resolvedType, data: inPack.resolvedData };
        } else {
          const external = options.resolveBase?.(wanted);
          if (external !== undefined) base = { type: external.type, data: external.data };
        }
      }
      if (base === null) {
        still.push(entry);
        continue;
      }
      const data = applyDelta(base.data, entry.deltaData);
      settle(entry, base.type, data);
      progress = true;
    }
    if (!progress) {
      const stuck = still[0] as RawEntry;
      throw new PackError(
        stuck.typeCode === OFS_DELTA
          ? `ofs-delta base at offset ${stuck.baseOffset} could not be resolved`
          : `ref-delta base ${stuck.baseOid} is neither in the pack nor supplied by the receiver`,
        'pack-delta-base',
      );
    }
    remaining = still;
  }

  const objects = new Map<string, GitObject>();
  let deltaCount = 0;
  for (const entry of raw) {
    if (entry.typeCode === OFS_DELTA || entry.typeCode === REF_DELTA) deltaCount += 1;
    const oid = entry.resolvedOid as string;
    if (!objects.has(oid)) {
      objects.set(oid, { type: entry.resolvedType as GitObjectType, data: entry.resolvedData as Buffer });
    }
  }
  return { version, declaredCount, objects, deltaCount, checksumOk };
}

export interface PackObjectInput {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

function writeEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

interface PackedEntry {
  readonly type: GitObjectType;
  readonly data: Buffer;
  readonly oid: string;
}

function packFromList(list: PackedEntry[]): Buffer {
  list.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));

  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  for (const object of list) {
    const code = TYPE_CODE[object.type];
    parts.push(writeEntryHeader(code, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/**
 * Build a valid packfile from whole objects.  Entries are ordered by their object id so the same
 * object set always produces the same bytes; the trailer is the SHA-1 of every preceding byte.
 */
export function writePack(objects: Iterable<PackObjectInput>): Buffer {
  return packFromList(
    [...objects].map((object) => {
      const data = Buffer.from(object.data);
      return { type: object.type, data, oid: hashObjectFast(object.type, data) };
    }),
  );
}

export interface PackObjectWithOid extends PackObjectInput {
  readonly oid: string;
}

/** Same bytes as `writePack`, for callers whose object ids are already known (the store's keys). */
export function writePackWithOids(objects: Iterable<PackObjectWithOid>): Buffer {
  return packFromList(
    [...objects].map((object) => ({ type: object.type, data: Buffer.from(object.data), oid: object.oid })),
  );
}
