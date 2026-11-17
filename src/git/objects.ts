// Git's object model: the four object types, their byte-exact encodings, SHA-1 object ids, tree
// ordering, and reachability.  Everything here is pure data - the object store itself lives in the
// repository record - so the pack codec, REST contents API, commits view and GraphQL can share it.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export type ObjectLookup = (oid: string) => GitObject | undefined;

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && HEX40.test(value);
}

export const ZERO_OID = '0'.repeat(40);

function asBuffer(value: string | Uint8Array): Buffer {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (Buffer.isBuffer(value)) return value;
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

/** `<type> <size>\0`, the bytes git hashes before the object content. */
export function objectHeader(type: GitObjectType, size: number): Buffer {
  return Buffer.from(`${type} ${size}\u0000`, 'utf8');
}

/** The full loose-object bytes: header plus content. */
export function encodeLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  const body = asBuffer(data);
  return Buffer.concat([objectHeader(type, body.length), body]);
}

/** git's object id: SHA-1 of the loose-object encoding. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = asBuffer(data);
  return createHash('sha1').update(objectHeader(type, body.length)).update(body).digest('hex');
}

/** The zlib-compressed loose-object bytes, as they sit under `.git/objects/xx/yyyy...`. */
export function deflateLooseObject(type: GitObjectType, data: Uint8Array): Buffer {
  return deflateSync(encodeLooseObject(type, data));
}

const LOOSE_HEADER = /^(blob|tree|commit|tag) ([0-9]+)\u0000$/;

/** Inflate loose-object bytes and split the `<type> <size>\0` header from the content. */
export function inflateLooseObject(bytes: Uint8Array): GitObject {
  const inflated = inflateSync(asBuffer(bytes));
  const nul = inflated.indexOf(0x00);
  if (nul < 0) throw new Error('loose object has no header terminator');
  const header = inflated.subarray(0, nul + 1).toString('utf8');
  const match = LOOSE_HEADER.exec(header);
  if (match === null) throw new Error(`loose object header ${JSON.stringify(header)} is malformed`);
  const type = match[1] as GitObjectType;
  const size = Number.parseInt(match[2] as string, 10);
  const data = inflated.subarray(nul + 1);
  if (data.length !== size) throw new Error(`loose object declares ${size} bytes but carries ${data.length}`);
  return { type, data };
}

// ---------------------------------------------------------------------------------------------
// trees
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

/** Parse a tree in its stored order.  A malformed entry is an error, never silently skipped. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = asBuffer(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    const mode = buffer.subarray(offset, space).toString('ascii');
    if (!/^[0-7]+$/.test(mode)) throw new Error(`tree entry mode ${JSON.stringify(mode)} is not octal`);
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's byte ordering: a directory sorts as if its name ended in '/'. */
export function compareTreeEntries(
  a: { name: string; mode: string },
  b: { name: string; mode: string },
): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree; entries are sorted in git's order and each oid must be a 40-hex id. */
export function buildTree(entries: ReadonlyArray<TreeEntry>): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    if (!isObjectId(entry.oid)) throw new Error(`tree entry ${entry.name} has an invalid object id`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly extraHeaders: ReadonlyArray<readonly [string, string]>;
}

export function parseCommit(data: Uint8Array): CommitView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: Array<[string, string]> = [];
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
    else extra.push([key, value]);
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  for (const parent of parents) if (!isObjectId(parent)) throw new Error('commit has an invalid parent id');
  return { tree, parents, author, committer, message, extraHeaders: extra };
}

/** `Name <email> <seconds> <tz>`, the identity line git stores in author/committer headers. */
export function identityLine(name: string, email: string, epochSeconds: number, timezone = '+0000'): string {
  const safeName = name.replace(/[<>\n]/g, '');
  const safeEmail = email.replace(/[<>\n]/g, '');
  return `${safeName} <${safeEmail}> ${Math.trunc(epochSeconds)} ${timezone}`;
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly author: string;
  readonly committer?: string;
  readonly extraHeaders?: ReadonlyArray<readonly [string, string]>;
}

/** Serialize a commit; the message always ends in a newline, as git writes it. */
export function buildCommit(fields: BuildCommitFields): Buffer {
  if (!isObjectId(fields.tree)) throw new Error('cannot build a commit without a valid tree id');
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) {
    if (!isObjectId(parent)) throw new Error('cannot build a commit with an invalid parent id');
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer ?? fields.author}`);
  for (const [key, value] of fields.extraHeaders ?? []) lines.push(`${key} ${value}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

// ---------------------------------------------------------------------------------------------
// annotated tags
// ---------------------------------------------------------------------------------------------

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const buffer = asBuffer(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headers = new Map<string, string>();
  for (const line of buffer.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (line === '') continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error(`tag header ${JSON.stringify(line)} has no value`);
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') {
    throw new Error(`tag has an invalid type ${JSON.stringify(type)}`);
  }
  return {
    object,
    type,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8'),
  };
}

export interface BuildTagFields {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function buildTag(fields: BuildTagFields): Buffer {
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger}\n\n${message}`,
    'utf8',
  );
}

/** Follow tag objects to the object they ultimately name. */
export function peelToTarget(oid: string, lookup: ObjectLookup): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = lookup(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

/** Follow tag objects to a commit id, or return null when the chain does not end at a commit. */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  const target = peelToTarget(oid, lookup);
  return lookup(target)?.type === 'commit' ? target : null;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

export class MissingObjectError extends Error {
  readonly oid: string;

  constructor(oid: string) {
    super(`object ${oid} is missing from the repository`);
    this.name = 'MissingObjectError';
    this.oid = oid;
  }
}

export interface ReachOptions {
  /** Skip missing objects instead of throwing (used when subtracting a client's `have` set). */
  readonly allowMissing?: boolean;
}

/**
 * Every object reachable from `tips`: commits through parents and trees, trees through entries,
 * tags through their target.  Deterministic order is not promised; callers that need one sort.
 */
export function collectReachable(tips: Iterable<string>, lookup: ObjectLookup, options: ReachOptions = {}): Set<string> {
  const seen = new Set<string>();
  const stack: string[] = [];
  for (const tip of tips) if (isObjectId(tip)) stack.push(tip);
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = lookup(oid);
    if (object === undefined) {
      if (options.allowMissing === true) continue;
      throw new MissingObjectError(oid);
    }
    switch (object.type) {
      case 'commit': {
        const commit = parseCommit(object.data);
        stack.push(commit.tree);
        for (const parent of commit.parents) stack.push(parent);
        break;
      }
      case 'tree': {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
        break;
      }
      case 'tag': {
        stack.push(parseTag(object.data).object);
        break;
      }
      default:
        break;
    }
  }
  return seen;
}

/** Whether `ancestor` appears in the parent chain of `descendant` (fast-forward test for a branch). */
export function isAncestor(ancestor: string, descendant: string, lookup: ObjectLookup): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}
