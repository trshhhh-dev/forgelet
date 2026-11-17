// Git smart HTTP: the two info/refs advertisements, protocol v2 upload-pack (ls-refs and fetch),
// the v0 upload-pack fallback, and v0 receive-pack with a per-ref report.  Every handler resolves
// the repository first, so a missing repo is a 404 on every git route and never a half-open stream.
//
// The object graph lives in the repository record.  Fetch computes a closure, subtracts what the
// client says it has, and writes whole objects into a checksummed pack; push reads the pack (whole
// objects or deltas), stores every object, then applies each ref command independently.

import type { IncomingMessage } from 'node:http';
import { HttpError, readBody, sendBuffer } from '../http.ts';
import type { Router } from '../router.ts';
import type { Repo, Store } from '../store.ts';
import {
  ZERO_OID,
  MissingObjectError,
  collectReachable,
  isAncestor,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  peelToTarget,
  type GitObject,
  type GitObjectType,
  type ObjectLookup,
} from './objects.ts';
import { PackError, readPack, writePack } from './pack.ts';
import {
  PktLineError,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  flushPacket,
  packetLines,
  readPktLineSection,
  sidebandPackets,
  type PktLinePacket,
} from './pktline.ts';

const UPLOAD_PACK = 'git-upload-pack';
const RECEIVE_PACK = 'git-receive-pack';
const AGENT = 'forge/0.1';
const MAX_GIT_BODY_BYTES = 64 * 1024 * 1024;

function serviceOf(value: unknown): typeof UPLOAD_PACK | typeof RECEIVE_PACK {
  if (value === UPLOAD_PACK || value === RECEIVE_PACK) return value;
  throw new HttpError(400, 'Unsupported service');
}

/** `GET /{owner}/{repo}.git/...`: strip the suffix and require a repository this token can see. */
function repoFrom(store: Store, owner: string, repoWithSuffix: string): Repo {
  if (!repoWithSuffix.endsWith('.git')) throw new HttpError(404, 'Not Found');
  return store.requireRepo(owner, repoWithSuffix.slice(0, -4));
}

function headerText(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.join(',');
  return '';
}

function repoLookup(repo: Repo): ObjectLookup {
  return (oid) => repo.objects.get(oid);
}

function defaultBranchRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

interface AdvertisedRef {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
}

/** HEAD first (when born), then every ref in name order, with peeled annotated tags. */
function advertisementRefs(repo: Repo): AdvertisedRef[] {
  const tip = repo.refs.get(defaultBranchRef(repo)) ?? null;
  const refs: AdvertisedRef[] = [];
  if (tip !== null) refs.push({ oid: tip, name: 'HEAD' });
  for (const name of [...repo.refs.keys()].sort()) {
    const oid = repo.refs.get(name) as string;
    if (name.startsWith('refs/tags/')) {
      const peeled = peelToTarget(oid, repoLookup(repo));
      if (peeled !== oid) refs.push({ oid, name, peeled });
      else refs.push({ oid, name });
    } else {
      refs.push({ oid, name });
    }
  }
  return refs;
}

function v0Caps(service: typeof UPLOAD_PACK | typeof RECEIVE_PACK, repo: Repo): string {
  if (service === UPLOAD_PACK) {
    return [
      'multi_ack_detailed',
      'thin-pack',
      'side-band-64k',
      'ofs-delta',
      'shallow',
      'no-progress',
      `symref=HEAD:${defaultBranchRef(repo)}`,
      `agent=${AGENT}`,
    ].join(' ');
  }
  return [
    'report-status',
    'report-status-v2',
    'side-band-64k',
    'delete-refs',
    'ofs-delta',
    `agent=${AGENT}`,
  ].join(' ');
}

/** The v0 ref advertisement: service preamble, then `<oid> <ref>` lines with caps on the first. */
function v0Advertisement(service: typeof UPLOAD_PACK | typeof RECEIVE_PACK, repo: Repo): Buffer {
  const refs = advertisementRefs(repo);
  const caps = v0Caps(service, repo);
  const items: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    refs.forEach((ref, index) => {
      const prefix = index === 0 ? `\u0000${caps}` : '';
      items.push(`${ref.oid} ${ref.name}${prefix}\n`);
      if (ref.peeled !== undefined) items.push(`${ref.peeled} ${ref.name}^{}\n`);
    });
  }
  items.push('flush');
  return encodePktLines(items);
}

function v2Advertisement(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

// ---------------------------------------------------------------------------------------------
// fetch selection
// ---------------------------------------------------------------------------------------------

interface FetchSelection {
  readonly objects: Map<string, GitObject>;
  readonly shallow: string[];
  readonly unshallow: string[];
}

function addTreeClosure(oid: string, lookup: ObjectLookup, out: Map<string, GitObject>): void {
  const stack = [oid];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = lookup(current);
    if (object === undefined) throw new MissingObjectError(current);
    out.set(current, object);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    }
  }
}

/**
 * A depth-limited fetch: commits at generation 0..depth-1 plus the full tree of each, with the
 * commits at the last generation named as the new shallow boundary.  A tag want contributes its
 * tag objects and then its target commit as generation 0.
 */
function selectDepth(
  lookup: ObjectLookup,
  wants: readonly string[],
  depth: number,
  clientShallow: readonly string[],
): FetchSelection {
  if (!Number.isFinite(depth) || depth < 1) throw new HttpError(400, 'Invalid deepen value');
  const objects = new Map<string, GitObject>();
  const startCommits: string[] = [];
  for (const want of wants) {
    let current = want;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = lookup(current);
      if (object === undefined) throw new MissingObjectError(current);
      if (object.type !== 'tag') {
        if (object.type === 'commit') startCommits.push(current);
        else addTreeClosure(current, lookup, objects);
        break;
      }
      objects.set(current, object);
      current = parseTag(object.data).object;
    }
  }

  const generation = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = startCommits.map((oid) => ({ oid, depth: 0 }));
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; depth: number };
    const seen = generation.get(item.oid);
    if (seen !== undefined && seen <= item.depth) continue;
    generation.set(item.oid, item.depth);
    const object = lookup(item.oid);
    if (object === undefined) throw new MissingObjectError(item.oid);
    if (object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (item.depth + 1 < depth) {
      for (const parent of commit.parents) queue.push({ oid: parent, depth: item.depth + 1 });
    }
  }

  const shallow = new Set<string>();
  for (const [oid, at] of generation) {
    const object = lookup(oid);
    if (object === undefined) continue;
    objects.set(oid, object);
    if (object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    addTreeClosure(commit.tree, lookup, objects);
    if (at === depth - 1 && commit.parents.length > 0) shallow.add(oid);
  }

  const unshallow = new Set<string>();
  for (const boundary of clientShallow) {
    if (!generation.has(boundary)) continue;
    const object = lookup(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (commit.parents.some((parent) => generation.has(parent))) unshallow.add(boundary);
  }

  return { objects, shallow: [...shallow].sort(), unshallow: [...unshallow].sort() };
}

function selectFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
): FetchSelection {
  if (wants.length === 0) return { objects: new Map(), shallow: [], unshallow: [] };
  const lookup = repoLookup(repo);
  if (depth !== undefined) return selectDepth(lookup, wants, depth, clientShallow);

  const wanted = collectReachable(wants, lookup);
  const onClient = collectReachable(haves, lookup, { allowMissing: true });
  const objects = new Map<string, GitObject>();
  for (const oid of wanted) {
    if (onClient.has(oid)) continue;
    const object = lookup(oid);
    if (object !== undefined) objects.set(oid, object);
  }
  return { objects, shallow: [], unshallow: [] };
}

// ---------------------------------------------------------------------------------------------
// v2 request parsing
// ---------------------------------------------------------------------------------------------

function requestLines(body: Buffer): string[] {
  const packets = decodePktLines(body);
  return packetLines(packets).map((line) => line.replace(/\r?\n$/, ''));
}

function commandOf(lines: readonly string[]): string {
  const first = lines[0] ?? '';
  if (!first.startsWith('command=')) throw new HttpError(400, 'Expected a command request');
  return first.slice('command='.length);
}

// ---------------------------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------------------------

function uploadPackV2Advertisement(): Buffer {
  return v2Advertisement();
}

function handleLsRefs(repo: Repo, lines: readonly string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const line of lines.slice(1)) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));

  const out: Array<string | 'flush'> = [];
  const tip = repo.refs.get(defaultBranchRef(repo)) ?? null;
  if (matches('HEAD')) {
    const symref = symrefs ? ` symref-target:${defaultBranchRef(repo)}` : '';
    if (tip !== null) out.push(`${tip} HEAD${symref}\n`);
    else if (unborn) out.push(`unborn HEAD${symref}\n`);
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let extra = '';
    if (peel && name.startsWith('refs/tags/')) {
      const target = peelToTarget(oid, repoLookup(repo));
      if (target !== oid) extra = ` peeled:${target}`;
    }
    out.push(`${oid} ${name}${extra}\n`);
  }
  out.push('flush');
  return encodePktLines(out);
}

interface FetchRequest {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly depth?: number;
}

function parseFetchRequest(lines: readonly string[]): FetchRequest {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines.slice(1)) {
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  for (const oid of [...wants, ...haves, ...shallow]) {
    if (!isObjectId(oid)) throw new HttpError(400, `Invalid object id ${JSON.stringify(oid)}`);
  }
  return { wants, haves, shallow, depth };
}

function handleFetchV2(repo: Repo, lines: readonly string[]): Buffer {
  const request = parseFetchRequest(lines);
  const selection = selectFetch(repo, request.wants, request.haves, request.shallow, request.depth);
  const pack = writePack(selection.objects.values());
  const parts: Buffer[] = [];

  // Acknowledgments are only meaningful when the client offered haves; the client's parser accepts
  // NAK and then a packfile section.  A clone (no haves) goes straight to the packfile.
  if (request.haves.length > 0) {
    parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    const shallowItems: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of selection.unshallow) shallowItems.push(`unshallow ${oid}\n`);
    for (const oid of selection.shallow) shallowItems.push(`shallow ${oid}\n`);
    shallowItems.push('flush');
    parts.push(encodePktLines(shallowItems));
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPackets(1, pack));
  parts.push(flushPacket());
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, packets: readonly PktLinePacket[]): Buffer {
  const lines = packetLines(packets).map((line) => line.replace(/\r?\n$/, ''));
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | undefined;
  for (const line of lines) {
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim().split(/\s+/);
      wants.push(rest[0] as string);
    } else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
  }
  for (const oid of [...wants, ...haves, ...shallow]) {
    if (!isObjectId(oid)) throw new HttpError(400, `Invalid object id ${JSON.stringify(oid)}`);
  }
  const selection = selectFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(selection.objects.values());
  const parts: Buffer[] = [];
  for (const oid of selection.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  for (const oid of selection.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  parts.push(encodePktLine('NAK\n'));
  parts.push(sidebandPackets(1, pack));
  parts.push(flushPacket());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parsePushCommands(lines: readonly string[]): { commands: PushCommand[]; caps: Set<string> } {
  const commands: PushCommand[] = [];
  const caps = new Set<string>();
  lines.forEach((raw, index) => {
    let line = raw.replace(/\r?\n$/, '');
    if (line === '') return;
    const nul = line.indexOf('\u0000');
    if (nul >= 0) {
      if (index === 0) {
        for (const token of line.slice(nul + 1).split(' ')) if (token) caps.add(token);
      }
      line = line.slice(0, nul);
    }
    const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/\S+)$/.exec(line);
    if (match === null) throw new HttpError(400, 'Malformed receive-pack command');
    commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
  });
  return { commands, caps };
}

function applyPushCommands(
  repo: Repo,
  store: Store,
  commands: readonly PushCommand[],
  unpackError: string | null,
): Buffer {
  const lookup = repoLookup(repo);
  const report: string[] = [unpackError === null ? 'unpack ok\n' : `unpack ${unpackError}\n`];
  let changed = false;

  for (const command of commands) {
    const { oldOid, newOid, ref } = command;
    const reject = (reason: string): void => {
      report.push(`ng ${ref} ${reason}\n`);
    };
    if (unpackError !== null) {
      reject('unpacker error');
      continue;
    }
    const current = repo.refs.get(ref);
    if (oldOid === ZERO_OID) {
      if (current !== undefined) {
        reject('stale info');
        continue;
      }
    } else if (current !== oldOid) {
      reject('stale info');
      continue;
    }

    if (newOid === ZERO_OID) {
      if (current === undefined) {
        reject('ref does not exist');
        continue;
      }
      repo.refs.delete(ref);
      report.push(`ok ${ref}\n`);
      changed = true;
      continue;
    }

    const target = repo.objects.get(newOid);
    if (target === undefined) {
      reject('missing necessary objects');
      continue;
    }
    if (ref.startsWith('refs/heads/')) {
      if (target.type !== 'commit') {
        reject('not a commit');
        continue;
      }
      if (oldOid !== ZERO_OID && !isAncestor(oldOid, newOid, lookup)) {
        reject('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(ref, newOid);
    report.push(`ok ${ref}\n`);
    changed = true;
  }

  if (changed) {
    const stamp = store.tick();
    repo.updatedAt = stamp;
    repo.pushedAt = stamp;
  }
  return encodePktLines([...report, 'flush']);
}

function handleReceivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const section = readPktLineSection(body);
  if (section.control !== 'flush') throw new HttpError(400, 'receive-pack command list has no flush');
  const lines = packetLines(section.packets).map((line) => line.replace(/\r?\n$/, ''));
  const { commands, caps } = parsePushCommands(lines);
  if (commands.length === 0) throw new HttpError(400, 'receive-pack has no commands');

  const packBytes = body.subarray(section.next);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const pack = readPack(packBytes, { resolveBase: repoLookup(repo) });
      for (const [oid, object] of pack.objects) {
        store.putObject(repo, object.type as GitObjectType, object.data, oid);
      }
    } catch (err) {
      unpackError = err instanceof PackError ? err.message : err instanceof Error ? err.message : String(err);
    }
  }

  const inner = applyPushCommands(repo, store, commands, unpackError);
  if (caps.has('side-band-64k')) {
    return Buffer.concat([sidebandPackets(1, inner), flushPacket()]);
  }
  return inner;
}

// ---------------------------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------------------------

export function registerGitRoutes(router: Router, store: Store): void {
  router.get('/:owner/:repo/info/refs', async ({ req, res, url, params }) => {
    const repo = repoFrom(store, params.owner as string, params.repo as string);
    const service = serviceOf(url.searchParams.get('service'));
    const wantsV2 = service === UPLOAD_PACK && /(?:^|[\s:])version=2(?:$|[\s:])/.test(headerText(req, 'git-protocol'));
    const contentType = `application/x-${service}-advertisement`;
    const body = wantsV2 ? uploadPackV2Advertisement() : v0Advertisement(service, repo);
    sendBuffer(res, 200, body, { 'content-type': contentType, 'cache-control': 'no-cache' });
  });

  router.post('/:owner/:repo/git-upload-pack', async ({ req, res, params }) => {
    const repo = repoFrom(store, params.owner as string, params.repo as string);
    const body = await readBody(req, MAX_GIT_BODY_BYTES);
    let response: Buffer;
    try {
      if (headerText(req, 'git-protocol').includes('version=2')) {
        const lines = requestLines(body);
        const command = commandOf(lines);
        if (command === 'ls-refs') response = handleLsRefs(repo, lines);
        else if (command === 'fetch') response = handleFetchV2(repo, lines);
        else throw new HttpError(400, `Unsupported command ${JSON.stringify(command)}`);
      } else {
        response = handleFetchV0(repo, decodePktLines(body));
      }
    } catch (err) {
      if (err instanceof PktLineError) throw new HttpError(400, err.message);
      throw err;
    }
    sendBuffer(res, 200, response, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache' });
  });

  router.post('/:owner/:repo/git-receive-pack', async ({ req, res, params }) => {
    const repo = repoFrom(store, params.owner as string, params.repo as string);
    const body = await readBody(req, MAX_GIT_BODY_BYTES);
    let response: Buffer;
    try {
      response = handleReceivePack(repo, store, body);
    } catch (err) {
      if (err instanceof PktLineError || err instanceof PackError) throw new HttpError(400, err.message);
      throw err;
    }
    sendBuffer(res, 200, response, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache' });
  });
}
