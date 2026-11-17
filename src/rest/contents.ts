// REST v3 contents: read a file or directory at a ref, and create/update/delete a file as a real
// commit on a branch.  The blob, tree and commit objects written here are the same objects git
// smart HTTP serves, so a pushed commit and a REST commit are indistinguishable to a clone.

import type { RequestContext, Router } from '../router.ts';
import { HttpError, asObject, optionalString, requireString, sendJson } from '../http.ts';
import type { Repo, Store } from '../store.ts';
import { hashObject, type GitObject } from '../git/objects.ts';
import {
  buildTreeFromFiles,
  commitTree,
  createCommit,
  flattenTree,
  resolveCommit,
  type FileEntry,
  type TreeView,
} from '../git/repo.ts';
import { commitJson } from './gitdata.ts';
import { originOf } from './repos.ts';

function tickEpoch(store: Store): number {
  return Math.floor(Date.parse(store.tick()) / 1000);
}

function requireRepo(store: Store, owner: unknown, name: unknown): Repo {
  return store.requireRepo(String(owner), String(name));
}

function blobOf(repo: Repo, entry: FileEntry): GitObject | undefined {
  return repo.objects.get(entry.oid);
}

function fileJson(repo: Repo, origin: string, path: string, entry: FileEntry): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const blob = blobOf(repo, entry);
  const data = blob?.data ?? Buffer.alloc(0);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: data.length,
    name,
    path,
    content: data.toString('base64'),
    sha: entry.oid,
    url: `${origin}/api/v3/repos/${fullName}/contents/${path}`,
    html_url: `${origin}/${fullName}/blob/${repo.defaultBranch}/${path}`,
    git_url: `${origin}/api/v3/repos/${fullName}/git/blobs/${entry.oid}`,
    download_url: `${origin}/${fullName}/raw/${repo.defaultBranch}/${path}`,
    _links: {
      self: `${origin}/api/v3/repos/${fullName}/contents/${path}`,
      git: `${origin}/api/v3/repos/${fullName}/git/blobs/${entry.oid}`,
      html: `${origin}/${fullName}/blob/${repo.defaultBranch}/${path}`,
    },
  };
}

function directoryJson(repo: Repo, origin: string, view: TreeView, path: string): Record<string, unknown>[] {
  const prefix = path === '' ? '' : `${path}/`;
  const entries: Array<{ name: string; json: Record<string, unknown> }> = [];
  const seen = new Set<string>();
  const fullName = `${repo.owner}/${repo.name}`;
  for (const [filePath, entry] of view.files) {
    if (!filePath.startsWith(prefix)) continue;
    const rest = filePath.slice(prefix.length);
    if (rest === '' || rest.includes('/')) continue;
    if (seen.has(rest)) continue;
    seen.add(rest);
    const blob = blobOf(repo, entry);
    entries.push({
      name: rest,
      json: {
        type: 'file',
        size: blob?.data.length ?? 0,
        name: rest,
        path: filePath,
        sha: entry.oid,
        url: `${origin}/api/v3/repos/${fullName}/contents/${filePath}`,
        html_url: `${origin}/${fullName}/blob/${repo.defaultBranch}/${filePath}`,
        git_url: `${origin}/api/v3/repos/${fullName}/git/blobs/${entry.oid}`,
        download_url: `${origin}/${fullName}/raw/${repo.defaultBranch}/${filePath}`,
      },
    });
  }
  for (const [dirPath, oid] of view.dirs) {
    if (dirPath === path || !dirPath.startsWith(prefix)) continue;
    const rest = dirPath.slice(prefix.length);
    if (rest === '' || rest.includes('/')) continue;
    if (seen.has(rest)) continue;
    seen.add(rest);
    entries.push({
      name: rest,
      json: {
        type: 'dir',
        size: 0,
        name: rest,
        path: dirPath,
        sha: oid,
        url: `${origin}/api/v3/repos/${fullName}/contents/${dirPath}`,
        html_url: `${origin}/${fullName}/tree/${repo.defaultBranch}/${dirPath}`,
        git_url: `${origin}/api/v3/repos/${fullName}/git/trees/${oid}`,
        download_url: null,
      },
    });
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return entries.map((entry) => entry.json);
}

function checkPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/g, '');
  const segments = normalized.split('/');
  if (normalized === '' || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new HttpError(404, 'Not Found');
  }
  return normalized;
}

function commitForBranch(repo: Repo, branch: string): string | null {
  return resolveCommit(repo, branch);
}

function commitAndMoveBranch(
  store: Store,
  repo: Repo,
  branch: string,
  parent: string | null,
  files: ReadonlyMap<string, FileEntry>,
  message: string,
): string {
  const tree = buildTreeFromFiles(store, repo, files);
  const commit = createCommit(store, repo, {
    tree,
    parents: parent === null ? [] : [parent],
    message,
    epochSeconds: tickEpoch(store),
  });
  repo.refs.set(`refs/heads/${branch}`, commit);
  const stamp = store.tick();
  repo.updatedAt = stamp;
  repo.pushedAt = stamp;
  return commit;
}

export function registerContentsRoutes(router: Router, store: Store): void {
  const readContents = (ctx: RequestContext, explicitPath: string | null): void => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const ref = ctx.url.searchParams.get('ref');
    const commit = resolveCommit(repo, ref);
    if (commit === null) throw new HttpError(404, 'Not Found');
    const tree = commitTree(repo, commit);
    if (tree === null) throw new HttpError(404, 'Not Found');
    const view = flattenTree(repo, tree);
    const path = explicitPath === null ? '' : checkPath(explicitPath);
    const origin = originOf(ctx);

    if (path !== '') {
      const file = view.files.get(path);
      if (file !== undefined) {
        sendJson(ctx.res, 200, fileJson(repo, origin, path, file));
        return;
      }
    }
    if (path === '' || view.dirs.has(path)) {
      sendJson(ctx.res, 200, directoryJson(repo, origin, view, path));
      return;
    }
    throw new HttpError(404, 'Not Found');
  };

  router.get('/api/v3/repos/:owner/:repo/contents', (ctx) => readContents(ctx, null));
  router.get('/api/v3/repos/:owner/:repo/contents/*path', (ctx) => readContents(ctx, String(ctx.params.path)));

  router.put('/api/v3/repos/:owner/:repo/contents/*path', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const body = asObject(ctx.body);
    const path = checkPath(String(ctx.params.path));
    const message = requireString(body, 'message');
    const content = typeof body.content === 'string' ? body.content : null;
    if (content === null) {
      throw new HttpError(422, 'Validation Failed: content is required', {
        errors: [{ resource: 'Contents', field: 'content', code: 'missing_field' }],
      });
    }
    const branch = optionalString(body, 'branch') ?? repo.defaultBranch;
    const suppliedSha = optionalString(body, 'sha') ?? undefined;
    const parent = commitForBranch(repo, branch);
    const hasRef = repo.refs.has(`refs/heads/${branch}`);
    if (parent === null && hasRef) throw new HttpError(404, 'Branch not found');
    if (parent === null && branch !== repo.defaultBranch) throw new HttpError(404, 'Branch not found');

    const tree = parent === null ? null : commitTree(repo, parent);
    const files = new Map(flattenTree(repo, tree).files);
    const existing = files.get(path);
    if (suppliedSha !== undefined && existing?.oid !== suppliedSha) {
      throw new HttpError(409, 'sha does not match the current file');
    }
    if (suppliedSha === undefined && existing !== undefined) {
      throw new HttpError(422, 'Validation Failed: sha is required when updating a file', {
        errors: [{ resource: 'Contents', field: 'sha', code: 'missing_field' }],
      });
    }

    const data = Buffer.from(content, 'base64');
    const oid = hashObject('blob', data);
    store.putObject(repo, 'blob', data, oid);
    files.set(path, { oid, mode: existing?.mode ?? '100644' });
    const commit = commitAndMoveBranch(store, repo, branch, parent, files, message);
    const origin = originOf(ctx);
    const created = existing === undefined;
    sendJson(
      ctx.res,
      created ? 201 : 200,
      {
        content: fileJson(repo, origin, path, { oid, mode: existing?.mode ?? '100644' }),
        commit: commitJson(store, repo, commit, origin),
      },
      { location: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}` },
    );
  });

  router.delete('/api/v3/repos/:owner/:repo/contents/*path', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const body = asObject(ctx.body);
    const path = checkPath(String(ctx.params.path));
    const message = requireString(body, 'message');
    const branch = optionalString(body, 'branch') ?? repo.defaultBranch;
    const suppliedSha = optionalString(body, 'sha') ?? undefined;
    const parent = commitForBranch(repo, branch);
    if (parent === null) throw new HttpError(404, 'Not Found');
    const tree = commitTree(repo, parent);
    const files = new Map(flattenTree(repo, tree).files);
    const existing = files.get(path);
    if (existing === undefined) throw new HttpError(404, 'Not Found');
    if (suppliedSha !== undefined && existing.oid !== suppliedSha) {
      throw new HttpError(409, 'sha does not match the current file');
    }
    files.delete(path);
    const commit = commitAndMoveBranch(store, repo, branch, parent, files, message);
    sendJson(ctx.res, 200, {
      content: null,
      commit: commitJson(store, repo, commit, originOf(ctx)),
    });
  });

}
