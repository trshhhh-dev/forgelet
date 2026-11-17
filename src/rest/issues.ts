// REST v3 issues, labels and comments.  Issue numbers are per repository and strictly increasing;
// labels are resolved by name against the repository's label list, so an unknown label is the 422
// GitHub returns rather than a silently dropped name.  Every list is filtered and sorted from the
// store, never from a clock, which keeps two runs byte-identical.

import type { Router } from '../router.ts';
import { HttpError, asObject, optionalString, requireString, sendJson } from '../http.ts';
import type { Comment, Issue, Label, Repo, Store } from '../store.ts';
import { originOf, userJson } from './repos.ts';

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function requireRepo(store: Store, owner: unknown, name: unknown): Repo {
  return store.requireRepo(String(owner), String(name));
}

function requireIssue(repo: Repo, raw: unknown): Issue {
  const number = Number.parseInt(String(raw), 10);
  const issue = Number.isSafeInteger(number) ? repo.issues.find((entry) => entry.number === number) : undefined;
  if (issue === undefined) throw new HttpError(404, 'Not Found');
  return issue;
}

function labelJson(repo: Repo, label: Label, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: label.id,
    node_id: `LA_kgDO${label.id.toString(16).padStart(6, '0')}`,
    url: `${origin}/api/v3/repos/${fullName}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const url = `${origin}/api/v3/repos/${fullName}/issues/${issue.number}`;
  const assignees = issue.assignees.map(() => userJson(store.viewer, origin));
  return {
    url,
    repository_url: `${origin}/api/v3/repos/${fullName}`,
    labels_url: `${url}/labels{/name}`,
    comments_url: `${url}/comments`,
    events_url: `${url}/events`,
    html_url: `${origin}/${fullName}/issues/${issue.number}`,
    id: issue.id,
    node_id: `I_kgDO${issue.id.toString(16).padStart(6, '0')}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.closedAt === null ? null : 'completed',
    user: userJson(store.viewer, origin),
    labels: issue.labels.map((label) => labelJson(repo, label, origin)),
    assignee: assignees[0] ?? null,
    assignees,
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: repo.comments.filter((comment) => comment.issueNumber === issue.number).length,
    closed_at: issue.closedAt,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    author_association: 'OWNER',
    performed_via_github_app: null,
    reactions: {
      url: `${url}/reactions`,
      total_count: 0,
      '+1': 0,
      '-1': 0,
      laugh: 0,
      hooray: 0,
      confused: 0,
      heart: 0,
      rocket: 0,
      eyes: 0,
    },
  };
}

function commentJson(store: Store, repo: Repo, comment: Comment, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  const issueUrl = `${origin}/api/v3/repos/${fullName}/issues/${comment.issueNumber}`;
  return {
    url: `${origin}/api/v3/repos/${fullName}/issues/comments/${comment.id}`,
    html_url: `${origin}/${fullName}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    issue_url: issueUrl,
    id: comment.id,
    node_id: `IC_kgDO${comment.id.toString(16).padStart(6, '0')}`,
    user: userJson(store.viewer, origin),
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    author_association: 'OWNER',
    body: comment.body,
    performed_via_github_app: null,
  };
}

/** Resolve the `labels` field (names or `{name}` objects) against the repository's labels. */
function resolveLabels(repo: Repo, value: unknown): Label[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(422, 'Validation Failed', {
      errors: [{ resource: 'Issue', field: 'labels', code: 'invalid' }],
    });
  }
  const resolved: Label[] = [];
  for (const raw of value) {
    const name =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'object' && raw !== null && typeof (raw as Record<string, unknown>).name === 'string'
          ? String((raw as Record<string, unknown>).name)
          : '';
    const label = repo.labels.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (label === undefined) {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', value: name }],
      });
    }
    if (!resolved.includes(label)) resolved.push(label);
  }
  return resolved;
}

function resolveAssignees(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new HttpError(422, 'Validation Failed', {
      errors: [{ resource: 'Issue', field: 'assignees', code: 'invalid' }],
    });
  }
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function findLabelByName(repo: Repo, name: string): Label | undefined {
  return repo.labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
}

function issueComparator(repo: Repo, sort: string, direction: string): (a: Issue, b: Issue) => number {
  const sign = direction === 'asc' ? 1 : -1;
  const commentsOf = (issue: Issue): number => repo.comments.filter((comment) => comment.issueNumber === issue.number).length;
  return (a, b) => {
    let order: number;
    if (sort === 'updated') order = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number;
    else if (sort === 'comments') order = commentsOf(a) - commentsOf(b) || a.number - b.number;
    else order = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
    return order * sign;
  };
}

export function registerIssueRoutes(router: Router, store: Store): void {
  // Labels ------------------------------------------------------------------------------------
  router.post('/api/v3/repos/:owner/:repo/labels', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const body = asObject(ctx.body);
    const name = requireString(body, 'name');
    if (findLabelByName(repo, name) !== undefined) {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'Label', field: 'name', code: 'already_exists' }],
      });
    }
    const label: Label = {
      id: store.nextLabel(repo),
      name,
      color: optionalString(body, 'color') ?? 'ededed',
      description: optionalString(body, 'description') ?? '',
    };
    repo.labels.push(label);
    repo.updatedAt = store.tick();
    sendJson(ctx.res, 201, labelJson(repo, label, originOf(ctx)));
  });

  router.get('/api/v3/repos/:owner/:repo/labels', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const origin = originOf(ctx);
    sendJson(ctx.res, 200, repo.labels.map((label) => labelJson(repo, label, origin)));
  });

  router.get('/api/v3/repos/:owner/:repo/labels/:name', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const label = findLabelByName(repo, String(ctx.params.name));
    if (label === undefined) throw new HttpError(404, 'Not Found');
    sendJson(ctx.res, 200, labelJson(repo, label, originOf(ctx)));
  });

  // Issues ------------------------------------------------------------------------------------
  router.post('/api/v3/repos/:owner/:repo/issues', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const body = asObject(ctx.body);
    const title = requireString(body, 'title');
    const text = optionalString(body, 'body') ?? '';
    const labels = resolveLabels(repo, body.labels);
    const assignees = resolveAssignees(body.assignees);
    const number = store.nextIssue(repo);
    const createdAt = store.tick();
    const issue: Issue = {
      id: repo.id * 1_000_000 + number,
      number,
      title,
      body: text,
      state: 'open',
      labels,
      assignees,
      createdAt,
      updatedAt: createdAt,
      closedAt: null,
    };
    repo.issues.push(issue);
    repo.updatedAt = createdAt;
    sendJson(ctx.res, 201, issueJson(store, repo, issue, originOf(ctx)), {
      location: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/issues/${number}`,
    });
  });

  router.get('/api/v3/repos/:owner/:repo/issues', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const origin = originOf(ctx);
    const state = ctx.url.searchParams.get('state') ?? 'open';
    const sort = ctx.url.searchParams.get('sort') ?? 'created';
    const direction = ctx.url.searchParams.get('direction') ?? 'desc';
    const perPage = intParam(ctx.url.searchParams.get('per_page'), 30, 1, 100);
    const page = intParam(ctx.url.searchParams.get('page'), 1, 1, 1_000_000_000);
    const filtered = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const ordered = filtered.sort(issueComparator(repo, sort, direction));
    const start = (page - 1) * perPage;
    const slice = ordered.slice(start, start + perPage);
    const headers: Record<string, string | number> = {};
    if (start + perPage < ordered.length) {
      const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues?state=${state}&sort=${sort}&direction=${direction}&per_page=${perPage}`;
      headers.link = `<${base}&page=${page + 1}>; rel="next"`;
    }
    sendJson(ctx.res, 200, slice.map((issue) => issueJson(store, repo, issue, origin)), headers);
  });

  router.get('/api/v3/repos/:owner/:repo/issues/:number', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const issue = requireIssue(repo, ctx.params.number);
    sendJson(ctx.res, 200, issueJson(store, repo, issue, originOf(ctx)));
  });

  router.patch('/api/v3/repos/:owner/:repo/issues/:number', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const issue = requireIssue(repo, ctx.params.number);
    const body = asObject(ctx.body);
    const state = optionalString(body, 'state');
    if (state !== undefined && state !== null && state !== 'open' && state !== 'closed') {
      throw new HttpError(422, 'Validation Failed', {
        errors: [{ resource: 'Issue', field: 'state', code: 'invalid' }],
      });
    }
    const title = optionalString(body, 'title');
    const text = optionalString(body, 'body');
    const labels = body.labels === undefined ? undefined : resolveLabels(repo, body.labels);
    const assignees = body.assignees === undefined ? undefined : resolveAssignees(body.assignees);
    if (state === 'closed' && issue.state !== 'closed') {
      issue.state = 'closed';
      issue.closedAt = store.tick();
    } else if (state === 'open' && issue.state !== 'open') {
      issue.state = 'open';
      issue.closedAt = null;
    }
    if (title !== undefined && title !== null) issue.title = title;
    if (text !== undefined && text !== null) issue.body = text;
    if (labels !== undefined) {
      issue.labels.length = 0;
      issue.labels.push(...labels);
    }
    if (assignees !== undefined) {
      issue.assignees.length = 0;
      issue.assignees.push(...assignees);
    }
    issue.updatedAt = store.tick();
    repo.updatedAt = issue.updatedAt;
    sendJson(ctx.res, 200, issueJson(store, repo, issue, originOf(ctx)));
  });

  // Comments ----------------------------------------------------------------------------------
  router.post('/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const issue = requireIssue(repo, ctx.params.number);
    const body = asObject(ctx.body);
    const text = requireString(body, 'body');
    const comment: Comment = {
      id: store.nextComment(repo),
      issueNumber: issue.number,
      body: text,
      user: store.viewer.login,
      createdAt: store.tick(),
    };
    repo.comments.push(comment);
    repo.updatedAt = comment.createdAt;
    sendJson(ctx.res, 201, commentJson(store, repo, comment, originOf(ctx)), {
      location: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    });
  });

  router.get('/api/v3/repos/:owner/:repo/issues/:number/comments', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const issue = requireIssue(repo, ctx.params.number);
    const origin = originOf(ctx);
    const comments = repo.comments
      .filter((comment) => comment.issueNumber === issue.number)
      .sort((a, b) => a.id - b.id)
      .map((comment) => commentJson(store, repo, comment, origin));
    sendJson(ctx.res, 200, comments);
  });

  // A single comment, by its (repository-wide) id: useful to gh, harmless to the suite.
  router.get('/api/v3/repos/:owner/:repo/issues/comments/:id', (ctx) => {
    const repo = requireRepo(store, ctx.params.owner, ctx.params.repo);
    const id = Number.parseInt(String(ctx.params.id), 10);
    const comment = repo.comments.find((entry) => entry.id === id);
    if (comment === undefined) throw new HttpError(404, 'Not Found');
    sendJson(ctx.res, 200, commentJson(store, repo, comment, originOf(ctx)));
  });
}
