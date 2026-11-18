// The forge's entire state.  One process, one store, no persistence: every fixture the suite makes is
// created through the API and lives here until the process exits.
//
// Two rules shape the data model:
//   - ids and timestamps are deterministic (fixed seed values and a monotonic store clock), so two
//     runs of the same requests see the same bytes and the replay export matches;
//   - git objects and refs are first-class here, so REST contents writes, git pushes, pull-request
//     merges and GraphQL reads all observe one repository.

import { DEFAULT_BRANCH, STORE_EPOCH_MS, VIEWER_LOGIN } from './config.ts';
import { HttpError } from './http.ts';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface Label {
  readonly id: number;
  readonly name: string;
  color: string;
  description: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly labels: Label[];
  readonly assignees: string[];
  readonly createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface Comment {
  readonly id: number;
  readonly issueNumber: number;
  readonly body: string;
  readonly user: string;
  readonly createdAt: string;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: string;
  readonly base: string;
  /** The head and base tips at the moment the pull request was opened. */
  readonly headSha: string;
  readonly baseSha: string;
  readonly createdAt: string;
  updatedAt: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  pushedAt: string | null;
  homepage: string | null;

  /** Loose objects by 40-hex SHA-1. */
  readonly objects: Map<string, GitObject>;
  /** Refs exactly as advertised (refs/heads/..., refs/tags/...). */
  readonly refs: Map<string, string>;

  readonly labels: Label[];
  readonly issues: Issue[];
  readonly comments: Comment[];
  readonly pulls: Pull[];
  issueSeq: number;
  commentSeq: number;
  pullSeq: number;
  labelSeq: number;
}

export interface Viewer {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

const NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

function key(owner: string, name: string): string {
  return `${owner.toLowerCase()}/${name.toLowerCase()}`;
}

export class Store {
  readonly viewer: Viewer;
  private readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private clockMs = STORE_EPOCH_MS;

  /**
   * A deterministic mutation counter. Every path that changes observable state calls `tick()`, so a
   * serialized GET response is valid exactly while its cached revision matches this one.
   */
  revision = 0;
  /** Serialized issue bodies, keyed by repo/number/origin. */
  readonly issueCache = new Map<string, { revision: number; body: Buffer }>();
  /** Serialized git bodies (advertisements, ls-refs and packs), keyed by repo/request. */
  readonly gitCache = new Map<string, { revision: number; body: Buffer }>();

  constructor() {
    this.viewer = {
      id: 1000,
      login: VIEWER_LOGIN,
      name: VIEWER_LOGIN.replace(/[^a-z0-9]+/gi, ' ').trim() || VIEWER_LOGIN,
      email: `${VIEWER_LOGIN}@example.invalid`,
    };
  }

  /** Deterministic ISO timestamp; advances one second per call. */
  tick(): string {
    const stamp = new Date(this.clockMs).toISOString();
    this.clockMs += 1_000;
    this.revision += 1;
    return stamp;
  }

  /** Whether `login` is the owner this process serves. */
  isViewer(login: string): boolean {
    return login.toLowerCase() === this.viewer.login.toLowerCase();
  }

  createRepo(input: { name: string; description?: string | null; private?: boolean; homepage?: string | null }): Repo {
    const name = input.name;
    if (typeof name !== 'string' || name.length === 0 || name.length > 100 || !NAME_PATTERN.test(name) || name === '.' || name === '..') {
      throw new HttpError(422, 'Repository creation failed. Name is invalid', {
        errors: [{ resource: 'Repository', field: 'name', code: 'invalid' }],
      });
    }
    const id = key(this.viewer.login, name);
    if (this.repos.has(id)) {
      throw new HttpError(422, 'Repository creation failed. Name already exists on this account', {
        errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }],
      });
    }
    const createdAt = this.tick();
    const repo: Repo = {
      id: ++this.repoSeq,
      owner: this.viewer.login,
      name,
      description: input.description ?? null,
      private: input.private ?? false,
      defaultBranch: DEFAULT_BRANCH,
      createdAt,
      updatedAt: createdAt,
      pushedAt: null,
      homepage: input.homepage ?? null,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      labels: [],
      issues: [],
      comments: [],
      pulls: [],
      issueSeq: 0,
      commentSeq: 0,
      pullSeq: 0,
      labelSeq: 0,
    };
    this.repos.set(id, repo);
    return repo;
  }

  /** A repository this token may see; another owner's name is simply absent (404, never 403). */
  findRepo(owner: string, name: string): Repo | undefined {
    if (!this.isViewer(owner)) return undefined;
    return this.repos.get(key(owner, name));
  }

  requireRepo(owner: string, name: string): Repo {
    const repo = this.findRepo(owner, name);
    if (repo === undefined) throw new HttpError(404, 'Not Found');
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (!this.isViewer(owner)) return false;
    return this.repos.delete(key(owner, name));
  }

  /** Repositories owned by `owner`, newest first (the GitHub `/user/repos` order). */
  listRepos(owner: string): Repo[] {
    if (!this.isViewer(owner)) return [];
    return [...this.repos.values()].filter((repo) => repo.owner.toLowerCase() === owner.toLowerCase()).reverse();
  }

  repoCount(owner: string): number {
    if (!this.isViewer(owner)) return 0;
    let count = 0;
    for (const repo of this.repos.values()) if (repo.owner.toLowerCase() === owner.toLowerCase()) count += 1;
    return count;
  }

  /** The default branch tip, or null for an unborn repository. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }

  branchTip(repo: Repo, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer, id: string): void {
    if (!repo.objects.has(id)) repo.objects.set(id, { type, data });
  }

  nextIssue(repo: Repo): number {
    repo.issueSeq += 1;
    return repo.issueSeq;
  }

  nextComment(repo: Repo): number {
    repo.commentSeq += 1;
    return repo.commentSeq;
  }

  nextPull(repo: Repo): number {
    repo.pullSeq += 1;
    return repo.pullSeq;
  }

  nextLabel(repo: Repo): number {
    repo.labelSeq += 1;
    return repo.labelSeq;
  }

  findLabel(repo: Repo, name: string): Label | undefined {
    return repo.labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
  }

  findIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((issue) => issue.number === number);
  }

  findPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((pull) => pull.number === number);
  }
}
