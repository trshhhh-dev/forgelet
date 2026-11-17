// REST v3 git data: refs, branches and commits.  These routes are what the contents and pull
// request checks build on; every ref they create is a real ref in the store and every commit they
// list is a real commit object, so git smart HTTP and the REST view agree.

import type { Router } from '../router.ts';
import { HttpError, asObject, requireString, sendJson } from '../http.ts';
import type { Repo, Store } from '../store.ts';
import { isObjectId, parseCommit, parseTree, type GitObjectType } from '../git/objects.ts';
import {
  ancestorCommits,
  apiMessage,
  isoFromEpoch,
  parseIdentity,
  resolveCommit,
} from '../git/repo.ts';
import { originOf, userJson } from './repos.ts';

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** The GitHub commit object used by /commits, /branches and the pull request APIs. */
export function commitJson(store: Store, repo: Repo, sha: string, origin: string): Record<string, unknown> {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') {
    throw new HttpError(404, 'Not Found');
  }
  const parsed = parseCommit(object.data);
  const authorLine = parseIdentity(parsed.author);
  const committerLine = parseIdentity(parsed.committer);
  const author = {
    name: authorLine?.name ?? '',
    email: authorLine?.email ?? '',
    date: authorLine === null ? null : isoFromEpoch(authorLine.epochSeconds),
  };
  const committer = {
    name: committerLine?.name ?? author.name,
    email: committerLine?.email ?? author.email,
    date: committerLine === null ? author.date : isoFromEpoch(committerLine.epochSeconds),
  };
  const fullName = `${repo.owner}/${repo.name}`;
  const url = `${origin}/api/v3/repos/${fullName}/commits/${sha}`;
  return {
    sha,
    node_id: `C_kgDO${sha.slice(0, 12)}`,
    url,
    html_url: `${origin}/${fullName}/commit/${sha}`,
    comments_url: `${origin}/api/v3/repos/${fullName}/commits/${sha}/comments`,
    commit: {
      author,
      committer,
      message: apiMessage(parsed.message),
      tree: {
        sha: parsed.tree,
        url: `${origin}/api/v3/repos/${fullName}/git/trees/${parsed.tree}`,
      },
      url,
      comment_count: 0,
      verification: {
        verified: false,
        reason: 'unsigned',
        signature: null,
        payload: null,
        verified_at: null,
      },
    },
    author: userJson(store.viewer, origin),
    committer: userJson(store.viewer, origin),
    parents: parsed.parents.map((parent) => ({
      sha: parent,
      url: `${origin}/api/v3/repos/${fullName}/commits/${parent}`,
      html_url: `${origin}/${fullName}/commit/${parent}`,
    })),
  };
}

function refJson(repo: Repo, origin: string, ref: string, objectSha: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const object = repo.objects.get(objectSha);
  const type: GitObjectType | 'unknown' = object?.type ?? 'unknown';
  return {
    ref,
    node_id: `R_kgDO${objectSha.slice(0, 12)}`,
    url: `${origin}/api/v3/repos/${fullName}/git/refs/${ref}`,
    object: {
      sha: objectSha,
      type,
      url: `${origin}/api/v3/repos/${fullName}/git/${type === 'commit' ? 'commits' : type === 'tag' ? 'tags' : 'blobs'}/${objectSha}`,
    },
  };
}

function branchJson(repo: Repo, origin: string, name: string, sha: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    name,
    commit: {
      sha,
      url: `${origin}/api/v3/repos/${fullName}/commits/${sha}`,
    },
    _links: {
      self: `${origin}/api/v3/repos/${fullName}/branches/${name}`,
      html: `${origin}/${fullName}/tree/${name}`,
    },
    protected: false,
    protection: {
      enabled: false,
      required_status_checks: { enforcement_level: 'off', contexts: [], checks: [] },
    },
    protection_url: `${origin}/api/v3/repos/${fullName}/branches/${name}/protection`,
  };
}

function requireRepo(store: Store, owner: unknown, name: unknown): Repo {
  return store.requireRepo(String(owner), String(name));
}

export function registerGitDataRoutes(router: Router, store: Store): void {
  router.post('/api/v3/repos/:owner/:repo/git/refs', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const body = asObject(ctx.body);
    const ref = requireString(body, 'ref');
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (!/^refs\/(?:heads|tags)\/[^\s]+$/.test(ref)) {
      throw new HttpError(422, 'Reference name is not valid', {
        errors: [{ resource: 'Reference', field: 'ref', code: 'invalid' }],
      });
    }
    if (!isObjectId(sha) || !repo.objects.has(sha)) {
      throw new HttpError(422, 'Object does not exist', {
        errors: [{ resource: 'Reference', field: 'sha', code: 'invalid' }],
      });
    }
    const object = repo.objects.get(sha);
    if (ref.startsWith('refs/heads/') && object?.type !== 'commit') {
      throw new HttpError(422, 'Object does not exist or is not a commit', {
        errors: [{ resource: 'Reference', field: 'sha', code: 'invalid' }],
      });
    }
    if (repo.refs.has(ref)) {
      throw new HttpError(422, 'Reference already exists', {
        errors: [{ resource: 'Reference', field: 'ref', code: 'already_exists' }],
      });
    }
    repo.refs.set(ref, sha);
    const stamp = store.tick();
    repo.updatedAt = stamp;
    repo.pushedAt = stamp;
    sendJson(ctx.res, 201, refJson(repo, originOf(ctx), ref, sha), {
      location: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`,
    });
  });

  router.get('/api/v3/repos/:owner/:repo/git/refs', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const origin = originOf(ctx);
    const prefix = ctx.url.searchParams.get('ref');
    const refs = [...repo.refs.keys()]
      .filter((ref) => prefix === null || ref === prefix || ref.startsWith(`${prefix}/`))
      .sort()
      .map((ref) => refJson(repo, origin, ref, repo.refs.get(ref) as string));
    sendJson(ctx.res, 200, refs);
  });

  router.get('/api/v3/repos/:owner/:repo/git/refs/*ref', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const raw = String(ctx.params.ref);
    const ref = raw.startsWith('refs/') ? raw : `refs/${raw}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) throw new HttpError(404, 'Not Found');
    sendJson(ctx.res, 200, refJson(repo, originOf(ctx), ref, sha));
  });

  router.get('/api/v3/repos/:owner/:repo/branches', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const origin = originOf(ctx);
    const branches = [...repo.refs.keys()]
      .filter((ref) => ref.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        sha: repo.refs.get(ref) as string,
      }))
      .filter((branch) => repo.objects.get(branch.sha)?.type === 'commit')
      .map((branch) => branchJson(repo, origin, branch.name, branch.sha));
    sendJson(ctx.res, 200, branches);
  });

  router.get('/api/v3/repos/:owner/:repo/branches/:branch', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const ref = `refs/heads/${String(ctx.params.branch)}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) throw new HttpError(404, 'Branch not found');
    sendJson(ctx.res, 200, branchJson(repo, originOf(ctx), String(ctx.params.branch), sha));
  });

  router.get('/api/v3/repos/:owner/:repo/commits', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const origin = originOf(ctx);
    const requested = ctx.url.searchParams.get('sha');
    const limit = intParam(ctx.url.searchParams.get('per_page'), 30, 1, 100);
    let tip: string | null;
    if (requested === null || requested === '') {
      tip = resolveCommit(repo, null);
    } else {
      tip = resolveCommit(repo, requested);
      if (tip === null) throw new HttpError(404, `No commit found for SHA: ${requested}`);
    }
    if (tip === null) {
      sendJson(ctx.res, 200, []);
      return;
    }
    const commits = ancestorCommits(repo, tip, limit).map((sha) => commitJson(store, repo, sha, origin));
    sendJson(ctx.res, 200, commits);
  });

  router.get('/api/v3/repos/:owner/:repo/git/commits/:sha', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const sha = String(ctx.params.sha);
    if (!isObjectId(sha) || repo.objects.get(sha)?.type !== 'commit') throw new HttpError(404, 'Not Found');
    sendJson(ctx.res, 200, commitJson(store, repo, sha, originOf(ctx)));
  });

  router.get('/api/v3/repos/:owner/:repo/git/trees/:sha', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const sha = String(ctx.params.sha);
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'tree') throw new HttpError(404, 'Not Found');
    const origin = originOf(ctx);
    const fullName = `${repo.owner}/${repo.name}`;
    const recursive = ctx.url.searchParams.get('recursive') === '1';
    const tree: Array<Record<string, unknown>> = [];
    const walk = (treeOid: string, prefix: string): void => {
      const treeObject = repo.objects.get(treeOid);
      if (treeObject === undefined || treeObject.type !== 'tree') return;
      for (const entry of parseTree(treeObject.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const isTree = entry.mode === '40000';
        const entryObject = repo.objects.get(entry.oid);
        tree.push({
          path,
          mode: entry.mode,
          type: isTree ? 'tree' : 'blob',
          sha: entry.oid,
          size: isTree ? undefined : entryObject?.data.length,
          url: `${origin}/api/v3/repos/${fullName}/git/${isTree ? 'trees' : 'blobs'}/${entry.oid}`,
        });
        if (isTree && recursive) walk(entry.oid, path);
      }
    };
    walk(sha, '');
    sendJson(ctx.res, 200, {
      sha,
      url: `${origin}/api/v3/repos/${fullName}/git/trees/${sha}`,
      truncated: false,
      tree,
    });
  });
}
