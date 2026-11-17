// The Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP.  It speaks the
// modern (2026-07-28) revision with server/discover, and still answers initialize for older clients.
// Every tool delegates to the same store as REST and git, so an issue created by an agent is the
// issue the REST surface lists.

import type { ServerResponse } from 'node:http';
import { INSTALLED_VERSION } from '../config.ts';
import { HttpError, sendEmpty, sendJson } from '../http.ts';
import type { Repo, Store } from '../store.ts';
import { mergePull, openPull } from '../rest/pulls.ts';

const PREFERRED_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = [PREFERRED_VERSION, '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone-forge', version: INSTALLED_VERSION };

interface JsonRpcId {
  readonly value: string | number | null;
  readonly present: boolean;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type ToolHandler = (store: Store, args: Record<string, unknown>) => unknown;

class ToolFailure extends Error {}

function objectBody(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArg(args: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function requireStringArg(args: Record<string, unknown>, names: string[], label: string): string {
  const value = stringArg(args, ...names);
  if (value === undefined) throw new ToolFailure(`Missing required argument: ${label}`);
  return value;
}

function numberArg(args: Record<string, unknown>, names: string[], label: string): number {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  throw new ToolFailure(`Missing required argument: ${label}`);
}

/** The repository a tool addresses, accepting owner/repo or a single full_name. */
function resolveRepo(store: Store, args: Record<string, unknown>): Repo {
  const fullName = stringArg(args, 'full_name', 'repo_full_name', 'repository_full_name');
  let owner = stringArg(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login') ?? store.viewer.login;
  let name = stringArg(args, 'repo', 'repository', 'repository_name', 'repo_name', 'name');
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) {
      owner = fullName.slice(0, slash);
      name = fullName.slice(slash + 1);
    } else {
      name = fullName;
    }
  }
  if (name === undefined) throw new ToolFailure('Missing required argument: repo');
  const repo = store.findRepo(owner, name);
  if (repo === undefined) throw new ToolFailure(`Repository not found: ${owner}/${name}`);
  return repo;
}

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    clone_url: `/${repo.owner}/${repo.name}.git`,
    html_url: `/${repo.owner}/${repo.name}`,
  };
}

function issueSummary(store: Store, repo: Repo, issue: { number: number; id: number; title: string; body: string; state: string; createdAt: string; updatedAt: string; closedAt: string | null; labels: Array<{ name: string; color: string }> }): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: { login: store.viewer.login },
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullSummary(repo: Repo, pull: { number: number; id: number; title: string; body: string; state: string; merged: boolean; head: string; headSha: string; base: string; baseSha: string; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'merged' : pull.state,
    merged: pull.merged,
    head: { ref: pull.head, sha: pull.headSha },
    base: { ref: pull.base, sha: pull.baseSha },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    url: `/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

function createIssueTool(store: Store, args: Record<string, unknown>): unknown {
  const repo = resolveRepo(store, args);
  const title = requireStringArg(args, ['title', 'issue_title', 'subject'], 'title');
  const body = stringArg(args, 'body', 'issue_body', 'description', 'content', 'text') ?? '';
  const number = store.nextIssue(repo);
  const createdAt = store.tick();
  const issue = {
    id: repo.id * 1_000_000 + number,
    number,
    title,
    body,
    state: 'open' as const,
    labels: [],
    assignees: [],
    createdAt,
    updatedAt: createdAt,
    closedAt: null,
  };
  repo.issues.push(issue);
  repo.updatedAt = createdAt;
  return issueSummary(store, repo, issue);
}

function listIssuesTool(store: Store, args: Record<string, unknown>): unknown {
  const repo = resolveRepo(store, args);
  const state = stringArg(args, 'state', 'status') ?? 'open';
  const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
  return issues.map((issue) => issueSummary(store, repo, issue));
}

const TOOL_HANDLERS: Readonly<Record<string, ToolHandler>> = Object.freeze({
  create_repo: (store, args) => {
    const name = requireStringArg(args, ['name', 'repo', 'repository', 'repository_name', 'repo_name'], 'name');
    const description = stringArg(args, 'description', 'about', 'summary') ?? null;
    const isPrivate = typeof args.private === 'boolean' ? args.private : typeof args.is_private === 'boolean' ? args.is_private : false;
    const repo = store.createRepo({ name, description, private: isPrivate });
    return repoSummary(repo);
  },
  get_repo: (store, args) => repoSummary(resolveRepo(store, args)),
  create_issue: createIssueTool,
  list_issues: listIssuesTool,
  get_issue: (store, args) => {
    const repo = resolveRepo(store, args);
    const number = numberArg(args, ['issue_number', 'number', 'index'], 'issue_number');
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue === undefined) throw new ToolFailure(`Issue not found: #${number}`);
    return issueSummary(store, repo, issue);
  },
  create_pull_request: (store, args) => {
    const repo = resolveRepo(store, args);
    const title = requireStringArg(args, ['title', 'pr_title', 'pull_request_title', 'subject'], 'title');
    const head = requireStringArg(args, ['head', 'head_ref', 'head_branch', 'source', 'from'], 'head');
    const base = requireStringArg(args, ['base', 'base_ref', 'base_branch', 'target', 'into'], 'base');
    const body = stringArg(args, 'body', 'description', 'content', 'text') ?? '';
    const pull = openPull(store, repo, { head, base, title, body });
    return pullSummary(repo, pull);
  },
  list_pull_requests: (store, args) => {
    const repo = resolveRepo(store, args);
    const state = stringArg(args, 'state', 'status') ?? 'open';
    return repo.pulls
      .filter((pull) => state === 'all' || (state === 'merged' ? pull.merged : pull.state === state))
      .map((pull) => pullSummary(repo, pull));
  },
  get_pull_request: (store, args) => {
    const repo = resolveRepo(store, args);
    const number = numberArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'index'], 'pull_number');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) throw new ToolFailure(`Pull request not found: #${number}`);
    return pullSummary(repo, pull);
  },
  merge_pull_request: (store, args) => {
    const repo = resolveRepo(store, args);
    const number = numberArg(args, ['pull_number', 'pull_request_number', 'pr_number', 'number', 'index'], 'pull_number');
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) throw new ToolFailure(`Pull request not found: #${number}`);
    const method = stringArg(args, 'merge_method', 'method') ?? 'squash';
    const commit = mergePull(store, repo, pull, method.toLowerCase());
    return { ...pullSummary(repo, pull), merged: true, merge_commit_sha: commit };
  },
  add_issue_comment: (store, args) => {
    const repo = resolveRepo(store, args);
    const number = numberArg(args, ['issue_number', 'number', 'index'], 'issue_number');
    const body = requireStringArg(args, ['body', 'comment', 'text'], 'body');
    const issue = repo.issues.find((entry) => entry.number === number);
    if (issue === undefined) throw new ToolFailure(`Issue not found: #${number}`);
    const comment = {
      id: store.nextComment(repo),
      issueNumber: issue.number,
      body,
      user: store.viewer.login,
      createdAt: store.tick(),
    };
    repo.comments.push(comment);
    repo.updatedAt = comment.createdAt;
    return { id: comment.id, body: comment.body, user: { login: comment.user }, created_at: comment.createdAt };
  },
});

interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDefinition {
  return { name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false } };
}

const COMMON = {
  owner: { type: 'string', description: 'Repository owner (defaults to the token owner)' },
  repo: { type: 'string', description: 'Repository name' },
};

const TOOLS: readonly ToolDefinition[] = Object.freeze([
  tool('create_repo', 'Create a repository for the token owner', {
    ...COMMON,
    name: { type: 'string', description: 'Repository name' },
    description: { type: 'string', description: 'Repository description' },
    private: { type: 'boolean', description: 'Whether the repository is private' },
  }, ['name']),
  tool('get_repo', 'Read a repository by owner and name', { ...COMMON }, ['repo']),
  tool('create_issue', 'Create an issue in a repository', {
    ...COMMON,
    title: { type: 'string', description: 'Issue title' },
    body: { type: 'string', description: 'Issue body' },
  }, ['repo', 'title']),
  tool('list_issues', 'List the issues in a repository', {
    ...COMMON,
    state: { type: 'string', description: 'open, closed or all' },
  }, ['repo']),
  tool('get_issue', 'Read one issue by number', {
    ...COMMON,
    issue_number: { type: 'number', description: 'Issue number' },
  }, ['repo', 'issue_number']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch', {
    ...COMMON,
    title: { type: 'string', description: 'Pull request title' },
    body: { type: 'string', description: 'Pull request body' },
    head: { type: 'string', description: 'Head branch' },
    base: { type: 'string', description: 'Base branch' },
  }, ['repo', 'title', 'head', 'base']),
  tool('list_pull_requests', 'List the pull requests in a repository', {
    ...COMMON,
    state: { type: 'string', description: 'open, closed, merged or all' },
  }, ['repo']),
  tool('get_pull_request', 'Read one pull request by number', {
    ...COMMON,
    pull_number: { type: 'number', description: 'Pull request number' },
  }, ['repo', 'pull_number']),
  tool('merge_pull_request', 'Merge a pull request into its base branch', {
    ...COMMON,
    pull_number: { type: 'number', description: 'Pull request number' },
    merge_method: { type: 'string', description: 'merge, squash or rebase' },
  }, ['repo', 'pull_number']),
  tool('add_issue_comment', 'Add a comment to an issue', {
    ...COMMON,
    issue_number: { type: 'number', description: 'Issue number' },
    body: { type: 'string', description: 'Comment body' },
  }, ['repo', 'issue_number', 'body']),
]);

function discoverResult(): Record<string, unknown> {
  return {
    resultType: 'discover',
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: { listChanged: false } },
    serverInfo: SERVER_INFO,
    instructions: 'A small GitHub-compatible forge: repositories, issues and pull requests.',
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  };
}

function rpcResult(id: JsonRpcId, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id.value, result };
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: JsonRpcError = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: '2.0', id: id.value, error };
}

function idOf(record: Record<string, unknown>): JsonRpcId {
  const present = Object.prototype.hasOwnProperty.call(record, 'id');
  const value = record.id;
  return { present, value: typeof value === 'string' || typeof value === 'number' ? value : null };
}

/** Process one JSON-RPC message.  Returns null for a notification (no response is sent). */
function processMessage(store: Store, message: unknown): Record<string, unknown> | null {
  const record = objectBody(message);
  const id = idOf(record);
  const method = typeof record.method === 'string' ? record.method : '';
  const params = objectBody(record.params);
  if (record.jsonrpc !== '2.0' || method === '') {
    return id.present ? rpcError(id, -32600, 'Invalid Request') : null;
  }

  if (!id.present) {
    // Notifications (notifications/initialized, cancelled, ...) are acknowledged with no body.
    return null;
  }

  if (method === 'server/discover') return rpcResult(id, discoverResult());
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: { listChanged: false } },
      serverInfo: SERVER_INFO,
      instructions: 'A small GitHub-compatible forge: repositories, issues and pull requests.',
    });
  }
  if (method === 'ping') return rpcResult(id, {});
  if (method === 'tools/list') return rpcResult(id, { tools: TOOLS });
  if (method === 'resources/list') return rpcResult(id, { resources: [] });
  if (method === 'prompts/list') return rpcResult(id, { prompts: [] });
  if (method === 'tools/call') {
    const name = params.name;
    if (typeof name !== 'string' || name === '') return rpcError(id, -32602, 'Invalid params: tools/call needs a tool name');
    const args = objectBody(params.arguments);
    const handler = TOOL_HANDLERS[name];
    if (handler === undefined) return rpcError(id, -32602, `Unknown tool: ${name}`);
    try {
      const payload = handler(store, args);
      return rpcResult(id, {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
        structuredContent: payload,
        isError: false,
      });
    } catch (err) {
      const message = err instanceof HttpError || err instanceof Error ? err.message : String(err);
      return rpcResult(id, {
        content: [{ type: 'text', text: message }],
        isError: true,
      });
    }
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

const PARSE_ERROR = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };

/** Handle one POST body.  Invalid JSON is the transport's 400 with JSON-RPC -32700. */
export function handleMcpBody(store: Store, raw: Buffer | undefined, res: ServerResponse): void {
  if (raw === undefined || raw.length === 0) {
    sendJson(res, 400, PARSE_ERROR);
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, PARSE_ERROR);
    return;
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((message) => processMessage(store, message)).filter((answer): answer is Record<string, unknown> => answer !== null);
    if (answers.length === 0) {
      sendEmpty(res, 202);
      return;
    }
    sendJson(res, 200, answers);
    return;
  }
  const answer = processMessage(store, parsed);
  if (answer === null) {
    sendEmpty(res, 202);
    return;
  }
  sendJson(res, 200, answer);
}

/** A tiny 405 for GET on the transport; POST and DELETE are the Streamable HTTP methods used. */
export function mcpMethodNotAllowed(res: ServerResponse): void {
  sendJson(res, 405, { message: 'Method Not Allowed' });
}
