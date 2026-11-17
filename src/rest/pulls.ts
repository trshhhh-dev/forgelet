// REST v3 pull requests.  A pull is a pair of refs plus the two tips it saw when it was opened; the
// head and base SHAs it reports are those snapshots, never the moving refs.  Merging is a real
// commit on the base branch: the changed files from the head tree are applied to the current base
// tree, so the merge commit shows up in /commits, in git smart HTTP and in /contents alike.  A head
// that changed a path the base moved to a third value in the meantime is a 405, which is how the
// suite asks for a conflicted pull.

import type { Router } from '../router.ts';
import { HttpError, asObject, optionalString, requireString, sendJson } from '../http.ts';
import type { Pull, Repo, Store } from '../store.ts';
import {
  buildTreeFromFiles,
  commitTree,
  commitsBetween,
  createCommit,
  diffFiles,
  flattenTree,
  resolveCommit,
  type FileEntry,
} from '../git/repo.ts';
import { commitJson } from './gitdata.ts';
import { originOf, repositoryJson, userJson } from './repos.ts';

function tickEpoch(store: Store): number {
  return Math.floor(Date.parse(store.tick()) / 1000);
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function requireRepo(store: Store, owner: unknown, name: unknown): Repo {
  return store.requireRepo(String(owner), String(name));
}

function requirePull(repo: Repo, raw: unknown): Pull {
  const number = Number.parseInt(String(raw), 10);
  const pull = Number.isSafeInteger(number) ? repo.pulls.find((entry) => entry.number === number) : undefined;
  if (pull === undefined) throw new HttpError(404, 'Not Found');
  return pull;
}

/** Split a blob into lines for the additive/deletion counts (an empty blob is zero lines). */
function lineCount(data: Buffer | undefined): number {
  if (data === undefined || data.length === 0) return 0;
  const lines = data.toString('utf8').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

interface PullCounts {
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
}

function pullCounts(repo: Repo, pull: Pull): PullCounts {
  const baseTree = commitTree(repo, pull.baseSha);
  const headTree = commitTree(repo, pull.headSha);
  const changed = diffFiles(repo, baseTree, headTree);
  let additions = 0;
  let deletions = 0;
  for (const [, entry] of changed) {
    const before = entry.base === undefined ? undefined : repo.objects.get(entry.base.oid)?.data;
    const after = entry.head === undefined ? undefined : repo.objects.get(entry.head.oid)?.data;
    if (entry.base === undefined) additions += Math.max(1, lineCount(after));
    else if (entry.head === undefined) deletions += lineCount(before);
    else {
      additions += Math.max(1, lineCount(after));
      deletions += lineCount(before);
    }
  }
  return {
    additions,
    deletions,
    changedFiles: changed.size,
    commits: commitsBetween(repo, pull.baseSha, pull.headSha).length,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const url = `${origin}/api/v3/repos/${fullName}/pulls/${pull.number}`;
  const counts = pullCounts(repo, pull);
  const headRepo = repositoryJson(store, repo, origin);
  return {
    url,
    id: pull.id,
    node_id: `PR_kgDO${pull.id.toString(16).padStart(6, '0')}`,
    html_url: `${origin}/${fullName}/pull/${pull.number}`,
    diff_url: `${origin}/${fullName}/pull/${pull.number}.diff`,
    patch_url: `${origin}/${fullName}/pull/${pull.number}.patch`,
    issue_url: `${origin}/api/v3/repos/${fullName}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(store.viewer, origin),
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.mergedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: {
      label: `${repo.owner}:${pull.head}`,
      ref: pull.head,
      sha: pull.headSha,
      user: userJson(store.viewer, origin),
      repo: headRepo,
    },
    base: {
      label: `${repo.owner}:${pull.base}`,
      ref: pull.base,
      sha: pull.baseSha,
      user: userJson(store.viewer, origin),
      repo: headRepo,
    },
    _links: {
      self: { href: url },
      html: { href: `${origin}/${fullName}/pull/${pull.number}` },
      issue: { href: `${origin}/api/v3/repos/${fullName}/issues/${pull.number}` },
      comments: { href: `${url}/comments` },
      review_comments: { href: `${url}/comments` },
      review_comment: { href: `${url}/comments{/number}` },
      commits: { href: `${url}/commits` },
      statuses: { href: `${origin}/api/v3/repos/${fullName}/statuses/${pull.headSha}` },
    },
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
    merged: pull.merged,
    mergeable: pull.state === 'open',
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_by: pull.merged ? userJson(store.viewer, origin) : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: counts.commits,
    additions: counts.additions,
    deletions: counts.deletions,
    changed_files: counts.changedFiles,
  };
}

function pullFileJson(repo: Repo, origin: string, repoFullName: string, path: string, entry: { base?: FileEntry; head?: FileEntry }): Record<string, unknown> {
  const before = entry.base === undefined ? undefined : repo.objects.get(entry.base.oid)?.data;
  const after = entry.head === undefined ? undefined : repo.objects.get(entry.head.oid)?.data;
  const status = entry.base === undefined ? 'added' : entry.head === undefined ? 'removed' : 'modified';
  const additions = entry.head === undefined ? 0 : Math.max(1, lineCount(after));
  const deletions = entry.base === undefined ? 0 : lineCount(before);
  const oldLines = lineCount(before);
  const newLines = lineCount(after);
  return {
    sha: entry.head?.oid ?? entry.base?.oid ?? '',
    filename: path,
    status,
    additions,
    deletions,
    changes: additions + deletions,
    blob_url: `${origin}/${repoFullName}/blob/${repo.defaultBranch}/${path}`,
    raw_url: `${origin}/${repoFullName}/raw/${repo.defaultBranch}/${path}`,
    contents_url: `${origin}/api/v3/repos/${repoFullName}/contents/${path}`,
    patch: `@@ -1,${oldLines} +1,${newLines} @@`,
  };
}

/** The plain branch name in a `head`/`base` field, accepting an `owner:branch` label. */
function branchName(repo: Repo, raw: string): string {
  const colon = raw.indexOf(':');
  if (colon === -1) return raw;
  const owner = raw.slice(0, colon);
  if (owner.toLowerCase() !== repo.owner.toLowerCase()) {
    throw new HttpError(422, 'Validation Failed', {
      errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
    });
  }
  return raw.slice(colon + 1);
}

/** Open a pull request from two existing refs; shared by the REST route and the GraphQL mutation. */
export function openPull(
  store: Store,
  repo: Repo,
  input: { head: string; base: string; title: string; body: string },
): Pull {
  const head = branchName(repo, input.head);
  const base = branchName(repo, input.base === '' ? repo.defaultBranch : input.base);
  const headSha = resolveCommit(repo, head);
  const baseSha = resolveCommit(repo, base);
  if (headSha === null || baseSha === null) {
    throw new HttpError(422, 'Validation Failed', {
      errors: [{ resource: 'PullRequest', field: headSha === null ? 'head' : 'base', code: 'invalid' }],
    });
  }
  if (headSha === baseSha) {
    throw new HttpError(422, 'Validation Failed', {
      errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid', message: 'No commits between base and head' }],
    });
  }
  const number = store.nextPull(repo);
  const createdAt = store.tick();
  const pull: Pull = {
    id: repo.id * 1_000_000 + number,
    number,
    title: input.title,
    body: input.body,
    state: 'open',
    head,
    base,
    headSha,
    baseSha,
    createdAt,
    updatedAt: createdAt,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
  };
  repo.pulls.push(pull);
  repo.updatedAt = createdAt;
  return pull;
}

/**
 * Squash (or merge) a pull request onto its base ref.  Shared by REST and GraphQL so both surfaces move
 * the same ref, decide the same conflicts and record the same merge commit.  Throws the REST-shaped
 * HttpError a 405 carries; GraphQL turns it into an errors array.
 */
export function mergePull(store: Store, repo: Repo, pull: Pull, method = 'merge'): string {
  if (pull.state !== 'open' || pull.merged) {
    throw new HttpError(405, 'Pull Request is not mergeable', { documentation_url: 'https://docs.github.com/rest/pulls/pulls#merge-a-pull-request' });
  }

  const headTree = commitTree(repo, pull.headSha);
  const baseTree = commitTree(repo, pull.baseSha);
  const currentTip = resolveCommit(repo, pull.base);
  if (headTree === null || baseTree === null || currentTip === null) {
    throw new HttpError(405, 'Pull Request is not mergeable');
  }
  const currentTree = commitTree(repo, currentTip);
  const currentFiles = flattenTree(repo, currentTree).files;
  const changed = diffFiles(repo, baseTree, headTree);

  // A path changed by the pull is clean when the branch still has the pull's base value, or
  // already has the pull's head value.  Anything else is a third edit: a conflict.
  for (const [path, entry] of changed) {
    const current = currentFiles.get(path);
    const sameAsBase = (current?.oid ?? null) === (entry.base?.oid ?? null) && (current?.mode ?? null) === (entry.base?.mode ?? null);
    const sameAsHead = (current?.oid ?? null) === (entry.head?.oid ?? null) && (current?.mode ?? null) === (entry.head?.mode ?? null);
    if (!sameAsBase && !sameAsHead) {
      throw new HttpError(405, 'Pull Request is not mergeable', { message: 'Pull Request has conflicts' });
    }
  }

  const mergedFiles = new Map(currentFiles);
  for (const [path, entry] of changed) {
    if (entry.head === undefined) mergedFiles.delete(path);
    else mergedFiles.set(path, entry.head);
  }
  const tree = buildTreeFromFiles(store, repo, mergedFiles);
  const parents = method === 'merge' && pull.headSha !== currentTip ? [currentTip, pull.headSha] : [currentTip];
  const commit = createCommit(store, repo, {
    tree,
    parents,
    message: `${pull.title} (#${pull.number})`,
    epochSeconds: tickEpoch(store),
  });
  repo.refs.set(`refs/heads/${pull.base}`, commit);
  const stamp = store.tick();
  repo.updatedAt = stamp;
  repo.pushedAt = stamp;
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = stamp;
  pull.mergeCommitSha = commit;
  pull.updatedAt = stamp;
  return commit;
}

export function registerPullRoutes(router: Router, store: Store): void {
  router.post('/api/v3/repos/:owner/:repo/pulls', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const body = asObject(ctx.body);
    const rawHead = requireString(body, 'head');
    const rawBase = typeof body.base === 'string' && body.base.length > 0 ? body.base : repo.defaultBranch;
    const pull = openPull(store, repo, {
      head: rawHead,
      base: rawBase,
      title: optionalString(body, 'title') ?? '',
      body: optionalString(body, 'body') ?? '',
    });
    sendJson(ctx.res, 201, pullJson(store, repo, pull, originOf(ctx)), {
      location: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    });
  });

  router.get('/api/v3/repos/:owner/:repo/pulls', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const origin = originOf(ctx);
    const state = ctx.url.searchParams.get('state') ?? 'open';
    const sort = ctx.url.searchParams.get('sort') ?? 'created';
    const direction = ctx.url.searchParams.get('direction') ?? 'desc';
    const perPage = intParam(ctx.url.searchParams.get('per_page'), 30, 1, 100);
    const page = intParam(ctx.url.searchParams.get('page'), 1, 1, 1_000_000_000);
    const sign = direction === 'asc' ? 1 : -1;
    const filtered = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
    const ordered = filtered.sort((a, b) => {
      const order = sort === 'updated' ? (a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number) : a.number - b.number;
      return order * sign;
    });
    const start = (page - 1) * perPage;
    const slice = ordered.slice(start, start + perPage);
    const headers: Record<string, string | number> = {};
    if (start + perPage < ordered.length) {
      const link = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls?state=${state}&per_page=${perPage}&page=${page + 1}`;
      headers.link = `<${link}>; rel="next"`;
    }
    sendJson(ctx.res, 200, slice.map((pull) => pullJson(store, repo, pull, origin)), headers);
  });

  router.get('/api/v3/repos/:owner/:repo/pulls/:number', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const pull = requirePull(repo, ctx.params.number);
    sendJson(ctx.res, 200, pullJson(store, repo, pull, originOf(ctx)));
  });

  router.patch('/api/v3/repos/:owner/:repo/pulls/:number', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const pull = requirePull(repo, ctx.params.number);
    const body = asObject(ctx.body);
    const title = optionalString(body, 'title');
    const text = optionalString(body, 'body');
    const state = optionalString(body, 'state');
    if (state !== undefined && state !== null && state !== 'open' && state !== 'closed') {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'PullRequest', field: 'state', code: 'invalid' }],
      });
    }
    if (title !== undefined && title !== null) pull.title = title;
    if (text !== undefined && text !== null) pull.body = text;
    if (state === 'closed' && pull.state !== 'closed') {
      pull.state = 'closed';
      pull.updatedAt = store.tick();
    } else if (state === 'open' && pull.state !== 'open') {
      pull.state = 'open';
      pull.updatedAt = store.tick();
    }
    pull.updatedAt = store.tick();
    repo.updatedAt = pull.updatedAt;
    sendJson(ctx.res, 200, pullJson(store, repo, pull, originOf(ctx)));
  });

  router.get('/api/v3/repos/:owner/:repo/pulls/:number/files', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const pull = requirePull(repo, ctx.params.number);
    const baseTree = commitTree(repo, pull.baseSha);
    const headTree = commitTree(repo, pull.headSha);
    const changed = diffFiles(repo, baseTree, headTree);
    const origin = originOf(ctx);
    const fullName = `${repo.owner}/${repo.name}`;
    const files = [...changed.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, entry]) => pullFileJson(repo, origin, fullName, path, entry));
    sendJson(ctx.res, 200, files);
  });

  router.get('/api/v3/repos/:owner/:repo/pulls/:number/commits', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const pull = requirePull(repo, ctx.params.number);
    const origin = originOf(ctx);
    const commits = commitsBetween(repo, pull.baseSha, pull.headSha).map((sha) => commitJson(store, repo, sha, origin));
    sendJson(ctx.res, 200, commits);
  });

  router.put('/api/v3/repos/:owner/:repo/pulls/:number/merge', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const pull = requirePull(repo, ctx.params.number);
    const body = asObject(ctx.body);
    const method = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    const commit = mergePull(store, repo, pull, method);
    sendJson(ctx.res, 200, {
      sha: commit,
      merged: true,
      message: 'Pull Request successfully merged',
    });
  });
}
