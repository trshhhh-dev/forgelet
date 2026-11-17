// A small GraphQL v4 executor over the same in-memory store as REST and git smart HTTP.  The parser
// hands it operations; this file owns the schema surface the suite's gh/github-mcp-server documents
// read: viewer, repository, Relay node ids, issue/pull-request connections and the issue/PR mutations.
// Unknown fields are a GraphQL error in a 200 body, never an HTTP error.

import type { DocumentNode, FieldNode, OperationNode, SelectionNode } from './parser.ts';
import { GraphQLSyntaxError, parseGraphQL, valueOf } from './parser.ts';
import type { Comment, Issue, Pull, Repo, Store } from '../store.ts';
import { HttpError } from '../http.ts';
import {
  commitTree,
  commitsBetween,
  diffFiles,
  flattenTree,
  resolveCommit,
  resolveTip,
  type FileEntry,
} from '../git/repo.ts';
import { parseCommit, parseTree, type GitObject } from '../git/objects.ts';
import { mergePull, openPull } from '../rest/pulls.ts';

interface Box {
  readonly $type: string;
  readonly $value: unknown;
}

interface ExecContext {
  readonly store: Store;
  readonly document: DocumentNode;
  readonly variables: Readonly<Record<string, unknown>>;
  readonly errors: Array<{ message: string; path?: Array<string | number> }>;
}

interface IssueSource {
  readonly repo: Repo;
  readonly issue: Issue;
}

interface PullSource {
  readonly repo: Repo;
  readonly pull: Pull;
}

interface CommentSource {
  readonly repo: Repo;
  readonly comment: Comment;
}

function box(type: string, value: unknown): Box {
  return { $type: type, $value: value };
}

function listBox(items: readonly Box[]): Box {
  return box('__list', items);
}

function isBox(value: unknown): value is Box {
  return typeof value === 'object' && value !== null && typeof (value as Box).$type === 'string' && '$value' in (value as object);
}

/** A deterministic, opaque Relay-style global id. */
export function encodeGlobalId(type: string, id: string): string {
  return Buffer.from(`forge:${type}:${id}`, 'utf8').toString('base64');
}

function decodeGlobalId(value: unknown): { type: string; id: string } | null {
  if (typeof value !== 'string') return null;
  try {
    const text = Buffer.from(value, 'base64').toString('utf8');
    const match = /^forge:([A-Za-z]+):(.+)$/.exec(text);
    return match === null ? null : { type: match[1] as string, id: match[2] as string };
  } catch {
    return null;
  }
}

function repoById(store: Store, id: number): Repo | null {
  return store.listRepos(store.viewer.login).find((repo) => repo.id === id) ?? null;
}

function repoByGlobalId(store: Store, value: unknown): Repo | null {
  const decoded = decodeGlobalId(value);
  if (decoded === null) return null;
  const [repoId] = decoded.id.split('/');
  return repoById(store, Number(repoId));
}

function issueByGlobalId(store: Store, value: unknown): IssueSource | null {
  const decoded = decodeGlobalId(value);
  if (decoded === null || decoded.type !== 'Issue') return null;
  const [repoId, number] = decoded.id.split('/');
  const repo = repoById(store, Number(repoId));
  const issue = repo?.issues.find((entry) => entry.number === Number(number));
  return repo === undefined || issue === undefined ? null : { repo, issue };
}

function pullByGlobalId(store: Store, value: unknown): PullSource | null {
  const decoded = decodeGlobalId(value);
  if (decoded === null || decoded.type !== 'PullRequest') return null;
  const [repoId, number] = decoded.id.split('/');
  const repo = repoById(store, Number(repoId));
  const pull = repo?.pulls.find((entry) => entry.number === Number(number));
  return repo === undefined || pull === undefined ? null : { repo, pull };
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('Repository', String(repo.id));
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', `${repo.id}/${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('PullRequest', `${repo.id}/${pull.number}`);
}

function commentGlobalId(repo: Repo, comment: Comment): string {
  return encodeGlobalId('Comment', `${repo.id}/${comment.id}`);
}

/** The schema names gh's feature probes and the executor both understand. */
const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  Issue: ['id', 'number', 'title', 'body', 'state', 'stateReason', 'author', 'createdAt', 'updatedAt', 'closedAt', 'repository', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit', 'commits', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'object', 'refs', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  Viewer: ['id', 'login', 'name', 'email', 'avatarUrl', 'url'],
  SearchType: [],
});

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
});

function typeMatches(condition: string | null, type: string): boolean {
  if (condition === null) return true;
  if (condition === type) return true;
  if (condition === 'Node' && ['Repository', 'Issue', 'PullRequest', 'Comment'].includes(type)) return true;
  if (condition === 'UniformResourceLocatable' && ['Repository', 'Issue', 'PullRequest', 'User'].includes(type)) return true;
  if (condition === 'Actor' && ['User', 'Viewer'].includes(type)) return true;
  return false;
}

function expandSelection(selection: readonly SelectionNode[], document: DocumentNode, type: string, depth = 0): FieldNode[] {
  if (depth > 20) return [];
  const fields: FieldNode[] = [];
  for (const node of selection) {
    if (node.kind === 'field') fields.push(node);
    else if (node.kind === 'spread') {
      const fragment = document.fragments.get(node.name);
      if (fragment !== undefined && typeMatches(fragment.typeCondition, type)) {
        fields.push(...expandSelection(fragment.selection, document, type, depth + 1));
      }
    } else if (typeMatches(node.typeCondition, type)) {
      fields.push(...expandSelection(node.selection, document, type, depth + 1));
    }
  }
  return fields;
}

function arg(node: FieldNode, name: string): unknown {
  const value = node.args[name];
  return value === undefined ? undefined : value;
}

function argValue(ctx: ExecContext, node: FieldNode, name: string): unknown {
  const value = arg(node, name);
  return value === undefined ? undefined : valueOf(value, ctx.variables);
}

function numberArg(ctx: ExecContext, node: FieldNode, name: string, fallback: number): number {
  const value = argValue(ctx, node, name);
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value);
  return fallback;
}

function stringArg(ctx: ExecContext, node: FieldNode, name: string): string | undefined {
  const value = argValue(ctx, node, name);
  return typeof value === 'string' ? value : undefined;
}

function issueOrder(repo: Repo, orderBy: unknown): (a: Issue, b: Issue) => number {
  const object = typeof orderBy === 'object' && orderBy !== null ? (orderBy as Record<string, unknown>) : {};
  const field = typeof object.field === 'string' ? object.field : 'CREATED_AT';
  const direction = typeof object.direction === 'string' ? object.direction : 'DESC';
  const sign = direction === 'ASC' ? 1 : -1;
  const comments = (issue: Issue): number => repo.comments.filter((comment) => comment.issueNumber === issue.number).length;
  return (a, b) => {
    let order: number;
    if (field === 'UPDATED_AT') order = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : a.number - b.number;
    else if (field === 'COMMENTS') order = comments(a) - comments(b) || a.number - b.number;
    else order = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.number - b.number;
    return order * sign;
  };
}

function connectionNodes<T>(items: readonly T[], first: number, after: string | null): { items: readonly T[]; hasNextPage: boolean; endCursor: string | null; startCursor: string | null } {
  let start = 0;
  if (after !== null && after !== '') {
    const match = /^offset:(\d+)$/.exec(Buffer.from(after, 'base64').toString('utf8'));
    if (match !== null) start = Math.max(0, Math.min(items.length, Number(match[1])));
  }
  const end = Math.min(items.length, start + Math.max(1, first));
  return {
    items: items.slice(start, end),
    hasNextPage: end < items.length,
    endCursor: items.length === 0 ? null : Buffer.from(`offset:${end}`, 'utf8').toString('base64'),
    startCursor: items.length === 0 ? null : Buffer.from(`offset:${start}`, 'utf8').toString('base64'),
  };
}

function issueConnection(ctx: ExecContext, node: FieldNode, repo: Repo): Box {
  const states = argValue(ctx, node, 'states');
  const wanted = Array.isArray(states) ? states.map((state) => String(state).toUpperCase()) : ['OPEN'];
  const order = issueOrder(repo, argValue(ctx, node, 'orderBy'));
  const issues = repo.issues.filter((issue) => wanted.includes(issue.state.toUpperCase())).sort(order);
  const first = numberArg(ctx, node, 'first', 30);
  const after = stringArg(ctx, node, 'after') ?? null;
  const page = connectionNodes(issues, first, after);
  return box('IssueConnection', {
    nodes: listBox(page.items.map((issue) => box('Issue', { repo, issue } satisfies IssueSource))),
    totalCount: issues.length,
    pageInfo: box('PageInfo', page),
  });
}

function pullConnection(ctx: ExecContext, node: FieldNode, repo: Repo): Box {
  const states = argValue(ctx, node, 'states');
  const wanted = Array.isArray(states) ? states.map((state) => String(state).toUpperCase()) : ['OPEN'];
  const pulls = [...repo.pulls]
    .filter((pull) => {
      const state = pull.merged ? 'MERGED' : pull.state.toUpperCase();
      return wanted.includes(state);
    })
    .sort((a, b) => b.number - a.number);
  const first = numberArg(ctx, node, 'first', 30);
  const after = stringArg(ctx, node, 'after') ?? null;
  const page = connectionNodes(pulls, first, after);
  return box('PullRequestConnection', {
    nodes: listBox(page.items.map((pull) => box('PullRequest', { repo, pull } satisfies PullSource))),
    totalCount: pulls.length,
    pageInfo: box('PageInfo', page),
  });
}

function pullFiles(repo: Repo, pull: Pull): Array<{ path: string; entry: { base?: FileEntry; head?: FileEntry } }> {
  const changed = diffFiles(repo, commitTree(repo, pull.baseSha), commitTree(repo, pull.headSha));
  return [...changed.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, entry]) => ({ path, entry }));
}

function mutationPayload(type: string, source: Record<string, unknown>): Box {
  return box(type, source);
}

function createIssueMutation(ctx: ExecContext, node: FieldNode): Box {
  const input = (argValue(ctx, node, 'input') as Record<string, unknown> | undefined) ?? {};
  const repo = repoByGlobalId(ctx.store, input.repositoryId);
  if (repo === null) throw new Error('Could not resolve to a Repository with the global id supplied');
  const title = typeof input.title === 'string' ? input.title : '';
  if (title === '') throw new Error('Title can\'t be blank');
  const body = typeof input.body === 'string' ? input.body : '';
  const number = ctx.store.nextIssue(repo);
  const createdAt = ctx.store.tick();
  const issue: Issue = {
    id: repo.id * 1_000_000 + number,
    number,
    title,
    body,
    state: 'open',
    labels: [],
    assignees: [],
    createdAt,
    updatedAt: createdAt,
    closedAt: null,
  };
  repo.issues.push(issue);
  repo.updatedAt = createdAt;
  return mutationPayload('CreateIssuePayload', { issue: box('Issue', { repo, issue } satisfies IssueSource) });
}

function closeIssueMutation(ctx: ExecContext, node: FieldNode): Box {
  const input = (argValue(ctx, node, 'input') as Record<string, unknown> | undefined) ?? {};
  const source = issueByGlobalId(ctx.store, input.issueId);
  if (source === null) throw new Error('Could not resolve to an Issue with the global id supplied');
  if (source.issue.state !== 'closed') {
    source.issue.state = 'closed';
    source.issue.closedAt = ctx.store.tick();
  }
  source.issue.updatedAt = ctx.store.tick();
  source.repo.updatedAt = source.issue.updatedAt;
  return mutationPayload('CloseIssuePayload', { issue: box('Issue', source) });
}

function createPullMutation(ctx: ExecContext, node: FieldNode): Box {
  const input = (argValue(ctx, node, 'input') as Record<string, unknown> | undefined) ?? {};
  const repo = repoByGlobalId(ctx.store, input.repositoryId);
  if (repo === null) throw new Error('Could not resolve to a Repository with the global id supplied');
  const pull = openPull(ctx.store, repo, {
    head: typeof input.headRefName === 'string' ? input.headRefName : '',
    base: typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch,
    title: typeof input.title === 'string' ? input.title : '',
    body: typeof input.body === 'string' ? input.body : '',
  });
  return mutationPayload('CreatePullRequestPayload', { pullRequest: box('PullRequest', { repo, pull } satisfies PullSource) });
}

function mergePullMutation(ctx: ExecContext, node: FieldNode): Box {
  const input = (argValue(ctx, node, 'input') as Record<string, unknown> | undefined) ?? {};
  const source = pullByGlobalId(ctx.store, input.pullRequestId);
  if (source === null) throw new Error('Could not resolve to a PullRequest with the global id supplied');
  const method = typeof input.mergeMethod === 'string' ? input.mergeMethod.toLowerCase() : 'merge';
  mergePull(ctx.store, source.repo, source.pull, method);
  return mutationPayload('MergePullRequestPayload', { pullRequest: box('PullRequest', source) });
}

function addCommentMutation(ctx: ExecContext, node: FieldNode): Box {
  const input = (argValue(ctx, node, 'input') as Record<string, unknown> | undefined) ?? {};
  const subject = decodeGlobalId(input.subjectId);
  if (subject === null) throw new Error('Could not resolve to a node with the global id supplied');
  const repo = repoById(ctx.store, Number(subject.id.split('/')[0]));
  if (repo === null) throw new Error('Could not resolve to a node with the global id supplied');
  let issueNumber: number;
  if (subject.type === 'Issue') {
    issueNumber = Number(subject.id.split('/')[1]);
  } else if (subject.type === 'PullRequest') {
    issueNumber = Number(subject.id.split('/')[1]);
  } else {
    throw new Error('Could not resolve to an Issue or PullRequest with the global id supplied');
  }
  const comment: Comment = {
    id: ctx.store.nextComment(repo),
    issueNumber,
    body: typeof input.body === 'string' ? input.body : '',
    user: ctx.store.viewer.login,
    createdAt: ctx.store.tick(),
  };
  repo.comments.push(comment);
  repo.updatedAt = comment.createdAt;
  return mutationPayload('AddCommentPayload', {
    commentEdge: box('CommentEdge', { node: box('Comment', { repo, comment } satisfies CommentSource) }),
  });
}

function objectExpression(ctx: ExecContext, node: FieldNode, repo: Repo): Box | null {
  const expression = stringArg(ctx, node, 'expression') ?? '';
  const colon = expression.indexOf(':');
  const ref = colon === -1 ? expression : expression.slice(0, colon);
  const path = colon === -1 ? '' : expression.slice(colon + 1);
  const commit = resolveCommit(repo, ref === '' ? null : ref);
  if (commit === null) return null;
  if (path === '') return box('Commit', { repo, sha: commit });
  const tree = commitTree(repo, commit);
  const view = flattenTree(repo, tree);
  const file = view.files.get(path);
  if (file !== undefined) return box('Blob', { repo, oid: file.oid, entry: file });
  if (view.dirs.has(path)) return box('Tree', { repo, oid: view.dirs.get(path) as string, path });
  return null;
}

function refField(ctx: ExecContext, node: FieldNode, repo: Repo): Box {
  const prefix = stringArg(ctx, node, 'refPrefix') ?? 'refs/';
  const refs = [...repo.refs.entries()]
    .filter(([name]) => name.startsWith(prefix))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, sha]) => box('Ref', { repo, name, sha }));
  const first = numberArg(ctx, node, 'first', 30);
  const page = connectionNodes(refs, first, null);
  return box('RefConnection', {
    nodes: listBox(page.items),
    totalCount: refs.length,
    pageInfo: box('PageInfo', page),
  });
}

/** The field resolver: scalar values, Box nodes, lists of Boxes, or null. */
function fieldValue(type: string, source: unknown, node: FieldNode, ctx: ExecContext): unknown {
  const name = node.name;
  if (name === '__typename') return type;

  if (type === 'Query') {
    switch (name) {
      case 'viewer':
        return box('Viewer', ctx.store.viewer);
      case 'repository': {
        const owner = stringArg(ctx, node, 'owner') ?? '';
        const repoName = stringArg(ctx, node, 'name') ?? '';
        const repo = ctx.store.findRepo(owner, repoName);
        return repo === undefined ? null : box('Repository', repo);
      }
      case 'node': {
        const decoded = decodeGlobalId(argValue(ctx, node, 'id'));
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = repoByGlobalId(ctx.store, argValue(ctx, node, 'id'));
          return repo === null ? null : box('Repository', repo);
        }
        if (decoded.type === 'Issue') {
          const found = issueByGlobalId(ctx.store, argValue(ctx, node, 'id'));
          return found === null ? null : box('Issue', found);
        }
        if (decoded.type === 'PullRequest') {
          const found = pullByGlobalId(ctx.store, argValue(ctx, node, 'id'));
          return found === null ? null : box('PullRequest', found);
        }
        return null;
      }
      case '__type': {
        const wanted = stringArg(ctx, node, 'name') ?? '';
        const fields = TYPE_FIELDS[wanted];
        const enums = ENUM_VALUES[wanted];
        if (fields === undefined && enums === undefined) return null;
        return box('__Type', {
          name: wanted,
          fields: fields ?? [],
          enumValues: enums ?? [],
        });
      }
      default:
        return undefined;
    }
  }

  if (type === 'Mutation') {
    switch (name) {
      case 'createIssue':
        return createIssueMutation(ctx, node);
      case 'closeIssue':
        return closeIssueMutation(ctx, node);
      case 'createPullRequest':
        return createPullMutation(ctx, node);
      case 'mergePullRequest':
        return mergePullMutation(ctx, node);
      case 'addComment':
        return addCommentMutation(ctx, node);
      default:
        return undefined;
    }
  }

  if (type === 'Viewer' || type === 'User') {
    const user = source as { id: number; login: string; name: string; email: string };
    switch (name) {
      case 'id':
        return encodeGlobalId('User', String(user.id));
      case 'login':
        return user.login;
      case 'name':
        return user.name;
      case 'email':
        return user.email;
      case 'avatarUrl':
        return `http://avatar.invalid/u/${user.id}`;
      case 'url':
        return `http://forge.invalid/users/${user.login}`;
      default:
        return undefined;
    }
  }

  if (type === 'Repository') {
    const repo = source as Repo;
    switch (name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return box('User', ctx.store.viewer);
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.private;
      case 'defaultBranchRef': {
        const sha = resolveCommit(repo, null);
        return sha === null ? null : box('Ref', { repo, name: repo.defaultBranch, sha });
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'issue': {
        const number = numberArg(ctx, node, 'number', 0);
        const issue = repo.issues.find((entry) => entry.number === number);
        return issue === undefined ? null : box('Issue', { repo, issue } satisfies IssueSource);
      }
      case 'issues':
        return issueConnection(ctx, node, repo);
      case 'pullRequests':
        return pullConnection(ctx, node, repo);
      case 'pullRequest': {
        const number = numberArg(ctx, node, 'number', 0);
        const pull = repo.pulls.find((entry) => entry.number === number);
        return pull === undefined ? null : box('PullRequest', { repo, pull } satisfies PullSource);
      }
      case 'object':
        return objectExpression(ctx, node, repo);
      case 'refs':
        return refField(ctx, node, repo);
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'url':
        return `http://forge.invalid/${repo.owner}/${repo.name}`;
      default:
        return undefined;
    }
  }

  if (type === 'Issue') {
    const { repo, issue } = source as IssueSource;
    switch (name) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state.toUpperCase();
      case 'stateReason':
        return issue.closedAt === null ? null : 'COMPLETED';
      case 'author':
        return box('User', ctx.store.viewer);
      case 'repository':
        return box('Repository', repo);
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'closedAt':
        return issue.closedAt;
      case 'url':
        return `http://forge.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'labels': {
        const labels = issue.labels.map((label) => box('Label', { repo, label }));
        return box('LabelConnection', { nodes: listBox(labels), totalCount: labels.length, pageInfo: box('PageInfo', { hasNextPage: false, endCursor: null, startCursor: null }) });
      }
      case 'comments': {
        const comments = repo.comments
          .filter((comment) => comment.issueNumber === issue.number)
          .sort((a, b) => a.id - b.id)
          .map((comment) => box('Comment', { repo, comment } satisfies CommentSource));
        return box('CommentConnection', { nodes: listBox(comments), totalCount: comments.length, pageInfo: box('PageInfo', { hasNextPage: false, endCursor: null, startCursor: null }) });
      }
      default:
        return undefined;
    }
  }

  if (type === 'PullRequest') {
    const { repo, pull } = source as PullSource;
    switch (name) {
      case 'id':
        return pullGlobalId(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      case 'merged':
        return pull.merged;
      case 'mergeable':
        return pull.state === 'open' ? 'MERGEABLE' : 'UNKNOWN';
      case 'headRefName':
        return pull.head;
      case 'baseRefName':
        return pull.base;
      case 'headRefOid':
        return pull.headSha;
      case 'baseRefOid':
        return pull.baseSha;
      case 'files': {
        const files = pullFiles(repo, pull);
        const first = numberArg(ctx, node, 'first', 30);
        const page = connectionNodes(files, first, null);
        return box('PullRequestChangedFileConnection', {
          nodes: listBox(page.items.map((file) => box('PullRequestChangedFile', file))),
          totalCount: files.length,
          pageInfo: box('PageInfo', page),
        });
      }
      case 'commits': {
        const commits = commitsBetween(repo, pull.baseSha, pull.headSha).map((sha) => box('Commit', { repo, sha }));
        return box('CommitConnection', { nodes: listBox(commits), totalCount: commits.length, pageInfo: box('PageInfo', { hasNextPage: false, endCursor: null, startCursor: null }) });
      }
      case 'author':
        return box('User', ctx.store.viewer);
      case 'repository':
        return box('Repository', repo);
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'mergedAt':
        return pull.mergedAt;
      case 'mergeCommit':
        return pull.mergeCommitSha === null ? null : box('Commit', { repo, sha: pull.mergeCommitSha });
      case 'url':
        return `http://forge.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      default:
        return undefined;
    }
  }

  if (type === 'PullRequestChangedFile') {
    const file = source as { path: string; entry: { base?: FileEntry; head?: FileEntry } };
    switch (name) {
      case 'path':
        return file.path;
      case 'additions':
        return 1;
      case 'deletions':
        return 0;
      case 'changeType':
        return file.entry.base === undefined ? 'ADDED' : file.entry.head === undefined ? 'DELETED' : 'MODIFIED';
      default:
        return undefined;
    }
  }

  if (type === 'Ref') {
    const ref = source as { repo: Repo; name: string; sha: string };
    switch (name) {
      case 'name':
        return ref.name;
      case 'prefix':
        return ref.name.split('/').slice(0, -1).join('/');
      case 'target':
        return box('Commit', { repo: ref.repo, sha: ref.sha });
      default:
        return undefined;
    }
  }

  if (type === 'Commit') {
    const commit = source as { repo: Repo; sha: string };
    const object = commit.repo.objects.get(commit.sha);
    const parsed = object?.type === 'commit' ? parseCommit(object.data) : null;
    switch (name) {
      case 'oid':
      case 'id':
        return commit.sha;
      case 'abbreviatedOid':
        return commit.sha.slice(0, 7);
      case 'message':
        return parsed?.message.replace(/\n+$/, '') ?? '';
      case 'messageHeadline':
        return (parsed?.message ?? '').split('\n')[0] ?? '';
      case 'committedDate':
        return commit.repo.updatedAt;
      case 'author':
        return box('User', ctx.store.viewer);
      case 'tree':
        return parsed === null ? null : box('Tree', { repo: commit.repo, oid: parsed.tree, path: '' });
      default:
        return undefined;
    }
  }

  if (type === 'Blob') {
    const blob = source as { repo: Repo; oid: string };
    const object = blob.repo.objects.get(blob.oid);
    const data = object?.type === 'blob' ? object.data : Buffer.alloc(0);
    switch (name) {
      case 'oid':
      case 'id':
        return blob.oid;
      case 'abbreviatedOid':
        return blob.oid.slice(0, 7);
      case 'text':
        return data.toString('utf8');
      case 'byteSize':
        return data.length;
      case 'isBinary':
        return data.includes(0);
      default:
        return undefined;
    }
  }

  if (type === 'Tree') {
    const tree = source as { repo: Repo; oid: string; path: string };
    const object = tree.repo.objects.get(tree.oid);
    switch (name) {
      case 'oid':
      case 'id':
        return tree.oid;
      case 'abbreviatedOid':
        return tree.oid.slice(0, 7);
      case 'entries':
        return object?.type === 'tree'
          ? listBox(parseTree(object.data).map((entry) => box('TreeEntry', { repo: tree.repo, entry, prefix: tree.path })))
          : listBox([]);
      default:
        return undefined;
    }
  }

  if (type === 'TreeEntry') {
    const entry = source as { repo: Repo; entry: { name: string; oid: string; mode: string }; prefix: string };
    switch (name) {
      case 'name':
        return entry.entry.name;
      case 'path':
        return entry.prefix === '' ? entry.entry.name : `${entry.prefix}/${entry.entry.name}`;
      case 'type':
        return entry.entry.mode === '40000' ? 'tree' : 'blob';
      case 'oid':
        return entry.entry.oid;
      default:
        return undefined;
    }
  }

  if (type === 'Comment') {
    const { repo, comment } = source as CommentSource;
    switch (name) {
      case 'id':
        return commentGlobalId(repo, comment);
      case 'body':
        return comment.body;
      case 'author':
        return box('User', ctx.store.viewer);
      case 'createdAt':
        return comment.createdAt;
      case 'updatedAt':
        return comment.createdAt;
      case 'url':
        return `http://forge.invalid/${repo.owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`;
      default:
        return undefined;
    }
  }

  if (type === '__Type') {
    const info = source as { name: string; fields: readonly string[]; enumValues: readonly string[] };
    switch (name) {
      case 'name':
        return info.name;
      case 'kind':
        return info.enumValues.length > 0 ? 'ENUM' : 'OBJECT';
      case 'fields':
        return listBox(info.fields.map((field) => box('__Field', { name: field })));
      case 'enumValues':
        return listBox(info.enumValues.map((value) => box('__EnumValue', { name: value })));
      default:
        return undefined;
    }
  }

  if (type === '__Field') {
    const field = source as { name: string };
    switch (name) {
      case 'name':
        return field.name;
      case 'description':
        return '';
      case 'isDeprecated':
        return false;
      case 'deprecationReason':
        return null;
      default:
        return undefined;
    }
  }

  if (type === '__EnumValue') {
    const value = source as { name: string };
    switch (name) {
      case 'name':
        return value.name;
      case 'description':
        return '';
      case 'isDeprecated':
        return false;
      case 'deprecationReason':
        return null;
      default:
        return undefined;
    }
  }

  // Connection / payload / edge / page-info / label wrappers: the values are prepared by the caller.
  if (
    type.endsWith('Connection') ||
    type === 'PageInfo' ||
    type === 'CommentEdge' ||
    type === 'LabelConnection' ||
    type.endsWith('Payload')
  ) {
    const record = source as Record<string, unknown>;
    return Object.prototype.hasOwnProperty.call(record, name) ? record[name] : undefined;
  }

  if (type === 'Label') {
    const label = source as { label: { name: string; color: string } };
    if (name === 'name') return label.label.name;
    if (name === 'color') return label.label.color;
    return undefined;
  }

  return undefined;
}

function renderSelection(type: string, source: unknown, selection: readonly SelectionNode[], ctx: ExecContext, path: Array<string | number>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of expandSelection(selection, ctx.document, type)) {
    const key = node.alias ?? node.name;
    let value: unknown;
    try {
      value = fieldValue(type, source, node, ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: [...path, key] });
      out[key] = null;
      continue;
    }
    if (value === undefined) {
      ctx.errors.push({ message: `Field "${node.name}" doesn't exist on type "${type}"`, path: [...path, key] });
      out[key] = null;
      continue;
    }
    out[key] = renderBox(value, node.selection, ctx, [...path, key]);
  }
  return out;
}

function renderBox(value: unknown, selection: readonly SelectionNode[], ctx: ExecContext, path: Array<string | number>): unknown {
  if (value === null || value === undefined) return null;
  if (isBox(value)) {
    if (value.$type === '__list') {
      return (value.$value as unknown[]).map((item, index) => renderBox(item, selection, ctx, [...path, index]));
    }
    return renderSelection(value.$type, value.$value, selection, ctx, path);
  }
  if (Array.isArray(value)) return value.map((item, index) => renderBox(item, selection, ctx, [...path, index]));
  return value;
}

function selectOperation(document: DocumentNode, operationName: string | undefined): OperationNode {
  if (operationName !== undefined) {
    const named = document.operations.find((operation) => operation.name === operationName);
    if (named !== undefined) return named;
    throw new GraphQLSyntaxError(`Unknown operation named "${operationName}"`);
  }
  const operation = document.operations[0];
  if (operation === undefined) throw new GraphQLSyntaxError('the document has no operations');
  return operation;
}

function variablesFor(operation: OperationNode, given: unknown): Record<string, unknown> {
  const variables: Record<string, unknown> = typeof given === 'object' && given !== null ? { ...(given as Record<string, unknown>) } : {};
  for (const definition of operation.variables) {
    if (variables[definition.name] === undefined && definition.defaultValue !== null) {
      variables[definition.name] = valueOf(definition.defaultValue, variables);
    }
  }
  return variables;
}

export interface GraphQLExecution {
  data: unknown;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

/** Execute one {query, variables, operationName} operation. */
export function executeOperation(store: Store, input: unknown): GraphQLExecution {
  const operationInput = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const query = typeof operationInput.query === 'string' ? operationInput.query : '';
  let document: DocumentNode;
  try {
    document = parseGraphQL(query);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation: OperationNode;
  try {
    operation = selectOperation(document, typeof operationInput.operationName === 'string' ? operationInput.operationName : undefined);
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operation.type === 'subscription') {
    return { data: null, errors: [{ message: 'Subscriptions are not supported' }] };
  }
  const ctx: ExecContext = {
    store,
    document,
    variables: variablesFor(operation, operationInput.variables),
    errors: [],
  };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  try {
    const data = renderSelection(rootType, store, operation.selection, ctx, [rootType.toLowerCase()]);
    return ctx.errors.length === 0 ? { data } : { data, errors: ctx.errors };
  } catch (err) {
    if (err instanceof HttpError) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

/** Execute a single operation or a batched JSON array, answering the same shape the request used. */
export function executeGraphQL(store: Store, body: unknown): unknown {
  if (Array.isArray(body)) return body.map((operation) => executeOperation(store, operation));
  return executeOperation(store, body);
}
