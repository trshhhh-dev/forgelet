// REST v3 repositories: the API root, meta, the viewer, list/create/patch/delete of repositories.
// A repository belongs to the token's login; asking for the same name under any other owner is a
// 404, which is what the suite expects (never 403).  Every object here is a plain deterministic
// literal, so two reads of one repository are byte-identical.

import type { RequestContext } from '../router.ts';
import type { Router } from '../router.ts';
import { INSTALLED_VERSION } from '../config.ts';
import { HttpError, asObject, optionalBoolean, optionalString, requireString, sendEmpty, sendJson } from '../http.ts';
import type { Repo, Store, Viewer } from '../store.ts';

function originOf(ctx: RequestContext): string {
  const host = ctx.req.headers.host ?? 'localhost';
  return `http://${host}`;
}

function userJson(user: Viewer, origin: string): Record<string, unknown> {
  return {
    login: user.login,
    id: user.id,
    node_id: `U_kgDO${user.id.toString(16).padStart(6, '0')}`,
    avatar_url: `${origin}/avatars/u/${user.id}`,
    gravatar_id: '',
    url: `${origin}/api/v3/users/${user.login}`,
    html_url: `${origin}/${user.login}`,
    followers_url: `${origin}/api/v3/users/${user.login}/followers`,
    following_url: `${origin}/api/v3/users/${user.login}/following{/other_user}`,
    gists_url: `${origin}/api/v3/users/${user.login}/gists{/gist_id}`,
    starred_url: `${origin}/api/v3/users/${user.login}/starred{/owner}{/repo}`,
    subscriptions_url: `${origin}/api/v3/users/${user.login}/subscriptions`,
    organizations_url: `${origin}/api/v3/users/${user.login}/orgs`,
    repos_url: `${origin}/api/v3/users/${user.login}/repos`,
    events_url: `${origin}/api/v3/users/${user.login}/events{/privacy}`,
    received_events_url: `${origin}/api/v3/users/${user.login}/received_events`,
    type: 'User',
    site_admin: false,
  };
}

/** The GitHub repository object, with every field the suite or `gh` may look at. */
export function repositoryJson(store: Store, repo: Repo, origin: string): Record<string, unknown> {
  const fullName = `${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_kgDO${repo.id.toString(16).padStart(6, '0')}`,
    name: repo.name,
    full_name: fullName,
    private: repo.private,
    owner: userJson(store.viewer, origin),
    html_url: `${origin}/${fullName}`,
    description: repo.description,
    fork: false,
    url: `${origin}/api/v3/repos/${fullName}`,
    forks_url: `${origin}/api/v3/repos/${fullName}/forks`,
    keys_url: `${origin}/api/v3/repos/${fullName}/keys{/key_id}`,
    collaborators_url: `${origin}/api/v3/repos/${fullName}/collaborators{/collaborator}`,
    teams_url: `${origin}/api/v3/repos/${fullName}/teams`,
    hooks_url: `${origin}/api/v3/repos/${fullName}/hooks`,
    issue_events_url: `${origin}/api/v3/repos/${fullName}/issues/events{/number}`,
    events_url: `${origin}/api/v3/repos/${fullName}/events`,
    assignees_url: `${origin}/api/v3/repos/${fullName}/assignees{/user}`,
    branches_url: `${origin}/api/v3/repos/${fullName}/branches{/branch}`,
    tags_url: `${origin}/api/v3/repos/${fullName}/tags`,
    blobs_url: `${origin}/api/v3/repos/${fullName}/git/blobs{/sha}`,
    git_tags_url: `${origin}/api/v3/repos/${fullName}/git/tags{/sha}`,
    git_refs_url: `${origin}/api/v3/repos/${fullName}/git/refs{/sha}`,
    trees_url: `${origin}/api/v3/repos/${fullName}/git/trees{/sha}`,
    statuses_url: `${origin}/api/v3/repos/${fullName}/statuses/{sha}`,
    languages_url: `${origin}/api/v3/repos/${fullName}/languages`,
    stargazers_url: `${origin}/api/v3/repos/${fullName}/stargazers`,
    contributors_url: `${origin}/api/v3/repos/${fullName}/contributors`,
    subscribers_url: `${origin}/api/v3/repos/${fullName}/subscribers`,
    subscription_url: `${origin}/api/v3/repos/${fullName}/subscription`,
    commits_url: `${origin}/api/v3/repos/${fullName}/commits{/sha}`,
    git_commits_url: `${origin}/api/v3/repos/${fullName}/git/commits{/sha}`,
    comments_url: `${origin}/api/v3/repos/${fullName}/comments{/number}`,
    issue_comment_url: `${origin}/api/v3/repos/${fullName}/issues/comments{/number}`,
    contents_url: `${origin}/api/v3/repos/${fullName}/contents/{+path}`,
    compare_url: `${origin}/api/v3/repos/${fullName}/compare/{base}...{head}`,
    merges_url: `${origin}/api/v3/repos/${fullName}/merges`,
    archive_url: `${origin}/api/v3/repos/${fullName}/{archive_format}{/ref}`,
    downloads_url: `${origin}/api/v3/repos/${fullName}/downloads`,
    issues_url: `${origin}/api/v3/repos/${fullName}/issues{/number}`,
    pulls_url: `${origin}/api/v3/repos/${fullName}/pulls{/number}`,
    milestones_url: `${origin}/api/v3/repos/${fullName}/milestones{/number}`,
    notifications_url: `${origin}/api/v3/repos/${fullName}/notifications{?since,all,participating}`,
    labels_url: `${origin}/api/v3/repos/${fullName}/labels{/name}`,
    releases_url: `${origin}/api/v3/repos/${fullName}/releases{/id}`,
    deployments_url: `${origin}/api/v3/repos/${fullName}/deployments`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.pushedAt,
    git_url: `git://${hostOf(origin)}/${fullName}.git`,
    ssh_url: `git@${hostOf(origin)}:${fullName}.git`,
    clone_url: `${origin}/${fullName}.git`,
    svn_url: `${origin}/${fullName}`,
    homepage: repo.homepage,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    open_issues: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    web_commit_signoff_required: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_pulls_count: repo.pulls.filter((pull) => pull.state === 'open').length,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    organization: null,
    network_count: 0,
    subscribers_count: 0,
  };
}

function hostOf(origin: string): string {
  return origin.replace(/^https?:\/\//, '');
}

function intParam(value: string | null, fallback: number, min: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Register every repository-collection route.  Static paths first, resource paths second. */
export function registerRepositoryRoutes(router: Router, store: Store): void {
  router.get('/api/v3', (ctx) => {
    const origin = originOf(ctx);
    sendJson(
      ctx.res,
      200,
      {
        current_user_url: `${origin}/api/v3/user`,
        current_user_authorizations_html_url: `${origin}/settings/connections/applications{/client_id}`,
        authorizations_url: `${origin}/api/v3/authorizations`,
        code_search_url: `${origin}/api/v3/search/code?q={query}{&page,per_page,sort,order}`,
        commit_search_url: `${origin}/api/v3/search/commits?q={query}{&page,per_page,sort,order}`,
        emails_url: `${origin}/api/v3/user/emails`,
        emojis_url: `${origin}/api/v3/emojis`,
        events_url: `${origin}/api/v3/events`,
        feeds_url: `${origin}/api/v3/feeds`,
        followers_url: `${origin}/api/v3/user/followers`,
        following_url: `${origin}/api/v3/user/following{/target}`,
        gists_url: `${origin}/api/v3/gists{/gist_id}`,
        hub_url: `${origin}/api/v3/hub`,
        issue_search_url: `${origin}/api/v3/search/issues?q={query}{&page,per_page,sort,order}`,
        issues_url: `${origin}/api/v3/issues`,
        keys_url: `${origin}/api/v3/user/keys{/key_id}`,
        label_search_url: `${origin}/api/v3/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
        notifications_url: `${origin}/api/v3/notifications`,
        organization_url: `${origin}/api/v3/orgs/{org}`,
        organization_repositories_url: `${origin}/api/v3/orgs/{org}/repos{?type,page,per_page,sort}`,
        organization_teams_url: `${origin}/api/v3/orgs/{org}/teams`,
        public_gists_url: `${origin}/api/v3/gists/public`,
        rate_limit_url: `${origin}/api/v3/rate_limit`,
        repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
        repository_search_url: `${origin}/api/v3/search/repositories?q={query}{&page,per_page,sort,order}`,
        current_user_repositories_url: `${origin}/api/v3/user/repos{?type,page,per_page,sort}`,
        starred_url: `${origin}/api/v3/user/starred{/owner}{/repo}`,
        starred_gists_url: `${origin}/api/v3/gists/starred`,
        topic_search_url: `${origin}/api/v3/search/topics?q={query}{&page,per_page}`,
        user_url: `${origin}/api/v3/users/{user}`,
        user_organizations_url: `${origin}/api/v3/user/orgs`,
        user_repositories_url: `${origin}/api/v3/users/{user}/repos{?type,page,per_page,sort}`,
        user_search_url: `${origin}/api/v3/search/users?q={query}{&page,per_page,sort,order}`,
      } as Record<string, unknown>,
      { 'x-oauth-scopes': 'repo, read:org, user, write:discussion' },
    );
  });

  router.get('/api/v3/meta', (ctx) => {
    const origin = originOf(ctx);
    sendJson(ctx.res, 200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: INSTALLED_VERSION,
      verifiable_password_authentication_note: `standalone forge at ${origin}`,
    });
  });

  router.get('/api/v3/user', (ctx) => {
    sendJson(ctx.res, 200, userJson(store.viewer, originOf(ctx)));
  });

  router.get('/api/v3/user/repos', (ctx) => {
    const origin = originOf(ctx);
    const perPage = intParam(ctx.url.searchParams.get('per_page'), 30, 1, 100);
    const page = intParam(ctx.url.searchParams.get('page'), 1, 1, 1_000_000_000);
    const all = store.listRepos(store.viewer.login);
    const start = (page - 1) * perPage;
    const slice = all.slice(start, start + perPage);
    const headers: Record<string, string | number> = {};
    if (start + perPage < all.length) {
      const next = `${origin}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
      headers.link = `<${next}>; rel="next"`;
    }
    sendJson(ctx.res, 200, slice.map((repo) => repositoryJson(store, repo, origin)), headers);
  });

  router.post('/api/v3/user/repos', (ctx) => {
    const body = asObject(ctx.body);
    const name = requireString(body, 'name');
    const description = optionalString(body, 'description') ?? null;
    const homepage = optionalString(body, 'homepage') ?? null;
    const isPrivate = optionalBoolean(body, 'private') ?? false;
    const repo = store.createRepo({ name, description, private: isPrivate, homepage });
    sendJson(ctx.res, 201, repositoryJson(store, repo, originOf(ctx)), {
      location: `${originOf(ctx)}/api/v3/repos/${repo.owner}/${repo.name}`,
    });
  });

  router.get('/api/v3/repos/:owner/:repo', (ctx) => {
    const repo = store.requireRepo(ctx.params.owner as string, ctx.params.repo as string);
    sendJson(ctx.res, 200, repositoryJson(store, repo, originOf(ctx)));
  });

  router.patch('/api/v3/repos/:owner/:repo', (ctx) => {
    const repo = store.requireRepo(ctx.params.owner as string, ctx.params.repo as string);
    const body = asObject(ctx.body);
    const description = optionalString(body, 'description');
    const homepage = optionalString(body, 'homepage');
    const isPrivate = optionalBoolean(body, 'private');
    if (description !== undefined) repo.description = description;
    if (homepage !== undefined) repo.homepage = homepage;
    if (isPrivate !== undefined) repo.private = isPrivate;
    repo.updatedAt = store.tick();
    sendJson(ctx.res, 200, repositoryJson(store, repo, originOf(ctx)));
  });

  router.delete('/api/v3/repos/:owner/:repo', (ctx) => {
    const owner = ctx.params.owner as string;
    const name = ctx.params.repo as string;
    if (store.findRepo(owner, name) === undefined) throw new HttpError(404, 'Not Found');
    store.deleteRepo(owner, name);
    sendEmpty(ctx.res, 204);
  });
}

/** Exposed for the future contents/pulls layers and for GraphQL's REST parity. */
export { userJson, originOf };
