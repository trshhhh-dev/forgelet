// Repository-level git operations shared by the REST content, branch, commit and pull-request
// surfaces.  Trees are flattened to a path map and rebuilt from one, so one file write produces a
// new tree chain and then a real commit object; nothing here re-implements the object model.

import {
  buildCommit,
  buildTree,
  hashObject,
  identityLine,
  isObjectId,
  parseCommit,
  parseTree,
  peelToCommit,
  type ObjectLookup,
  type TreeEntry,
} from './objects.ts';
import type { Repo, Store } from '../store.ts';

export interface FileEntry {
  readonly oid: string;
  readonly mode: string;
}

export interface TreeView {
  /** Every file, keyed by repository-relative path with `/` separators. */
  readonly files: Map<string, FileEntry>;
  /** Every tree, keyed by its directory path; the root tree is stored under ''. */
  readonly dirs: Map<string, string>;
}

export function lookupOf(repo: Repo): ObjectLookup {
  return (oid) => repo.objects.get(oid);
}

/** A ref name, a short branch/tag name, or a full object id. */
export function resolveTip(repo: Repo, name?: string | null): string | null {
  const wanted = name?.trim();
  if (wanted === undefined || wanted === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const exact = repo.refs.get(wanted);
  if (exact !== undefined) return exact;
  for (const ref of [`refs/heads/${wanted}`, `refs/tags/${wanted}`]) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined) return oid;
  }
  if (isObjectId(wanted) && repo.objects.has(wanted)) return wanted;
  return null;
}

/** The commit a ref/sha names, peeling annotated tags; null for an unborn ref or a non-commit. */
export function resolveCommit(repo: Repo, name?: string | null): string | null {
  const tip = resolveTip(repo, name);
  if (tip === null) return null;
  const object = repo.objects.get(tip);
  if (object === undefined) return null;
  if (object.type === 'commit') return tip;
  if (object.type === 'tag') return peelToCommit(tip, lookupOf(repo));
  return null;
}

export function commitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Flatten a tree into paths.  A missing or malformed tree yields an empty view. */
export function flattenTree(repo: Repo, treeOid: string | null | undefined): TreeView {
  const files = new Map<string, FileEntry>();
  const dirs = new Map<string, string>();
  if (treeOid === null || treeOid === undefined) return { files, dirs };
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    dirs.set(prefix, oid);
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else files.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return { files, dirs };
}

interface TreeNode {
  readonly files: Map<string, FileEntry>;
  readonly dirs: Map<string, TreeNode>;
}

function emptyNode(): TreeNode {
  return { files: new Map(), dirs: new Map() };
}

/** Rebuild a tree chain from a flat file map, writing every tree object it creates. */
export function buildTreeFromFiles(store: Store, repo: Repo, files: ReadonlyMap<string, FileEntry>): string {
  const root = emptyNode();
  for (const [path, entry] of files) {
    const segments = path.split('/').filter((segment) => segment !== '');
    if (segments.length === 0) continue;
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index] as string;
      let child = node.dirs.get(name);
      if (child === undefined) {
        child = emptyNode();
        node.dirs.set(name, child);
      }
      node = child;
    }
    node.files.set(segments[segments.length - 1] as string, entry);
  }

  const write = (node: TreeNode): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: write(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    store.putObject(repo, 'tree', data, oid);
    return oid;
  };
  return write(root);
}

/** Paths whose blob or mode differs between two trees; absent entries are undefined. */
export function diffFiles(
  repo: Repo,
  baseTree: string | null | undefined,
  headTree: string | null | undefined,
): Map<string, { base?: FileEntry; head?: FileEntry }> {
  const base = flattenTree(repo, baseTree).files;
  const head = flattenTree(repo, headTree).files;
  const paths = new Set([...base.keys(), ...head.keys()]);
  const changed = new Map<string, { base?: FileEntry; head?: FileEntry }>();
  for (const path of paths) {
    const before = base.get(path);
    const after = head.get(path);
    if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
    changed.set(path, { base: before, head: after });
  }
  return changed;
}

export interface CreateCommitOptions {
  readonly tree: string;
  readonly parents?: readonly string[];
  readonly message: string;
  readonly epochSeconds: number;
}

/** Build and store a commit authored by the token's viewer. */
export function createCommit(store: Store, repo: Repo, options: CreateCommitOptions): string {
  const identity = identityLine(store.viewer.name, store.viewer.email, options.epochSeconds, '+0000');
  const data = buildCommit({
    tree: options.tree,
    parents: options.parents ?? [],
    message: options.message,
    author: identity,
    committer: identity,
  });
  const oid = hashObject('commit', data);
  store.putObject(repo, 'commit', data, oid);
  return oid;
}

export interface Identity {
  readonly name: string;
  readonly email: string;
  readonly epochSeconds: number;
  readonly timezone: string;
}

const IDENTITY = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/;

export function parseIdentity(value: string): Identity | null {
  const match = IDENTITY.exec(value.trim());
  if (match === null) return null;
  return {
    name: match[1] as string,
    email: match[2] as string,
    epochSeconds: Number.parseInt(match[3] as string, 10),
    timezone: match[4] as string,
  };
}

export function isoFromEpoch(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

/** The commit's message with build artifacts (a trailing newline) removed, as the API renders it. */
export function apiMessage(message: string): string {
  return message.replace(/\n+$/, '');
}

/** All commits reachable from `tip`, newest first, stopping at the limit. */
export function ancestorCommits(repo: Repo, tip: string, limit = 100): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return out;
}

/** Commits on `head` that are not reachable from `base`, newest first. */
export function commitsBetween(repo: Repo, base: string | null, head: string, limit = 250): string[] {
  const onBase = new Set<string>();
  if (base !== null) {
    const stack = [base];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (onBase.has(oid)) continue;
      onBase.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
  }
  return ancestorCommits(repo, head, limit).filter((oid) => !onBase.has(oid));
}
