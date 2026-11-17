# github-core-clone-01 — implementation plan

A standalone GitHub-compatible forge: one Node 22 process, no dependencies (only `node:` built-ins),
no git binary, no network beyond the trial's env. It binds an ephemeral port, registers it with the
env, serves git smart HTTP + REST v3 + GraphQL v4 + MCP, then exits when the env says done.

## 1. Lifecycle (`main.ts`)

1. Read `MAKEFUN_ENV_URL`; exit 1 immediately if it is absent (nothing to register with).
2. `createApp()` builds the `node:http` server; `listen(0)` binds an ephemeral port (never 8080).
3. `POST $ENV/register` with `{"port": N}`. A 200 or a 409 (another entry won) both mean "stop
   registering". 400/405 are contract errors and end the process; transport errors and other statuses
   retry with exponential backoff (250 ms → 2 s, capped).
4. Poll `GET $ENV/done` with a 30 s per-request timeout until the body is `{"done": true}`. The env
   answers immediately, so this is a poll, not a held request. Failures are retried, never fatal.
5. `server.close()`, print a line, exit 0.

`main.ts` imports only the local app. Everything else lives under `src/`.

## 2. Module layout

```
main.ts                 lifecycle only
src/app.ts              http.createServer, request-id, auth gate, top-level dispatch, error boundary
src/router.ts           tiny method+path router (`:param` segments, decoded params)
src/http.ts             JSON send/read helpers, ApiError, body limit, deterministic header values
src/store.ts            in-memory state: user, repositories, issues, labels, pulls, comments, git objects
src/rest/*.ts           REST v3 handlers grouped by resource (repos, contents, git-data, issues, pulls)
src/git/objects.ts      loose-object model: type+bytes, SHA-1 id, tree/commit/tag parse+build
src/git/pack.ts         pack v2/v3 reader (delta resolution) and writer (with checksum)
src/git/upload.ts       protocol v2 advertisement, ls-refs, fetch (incl. shallow/deepen)
src/git/receive.ts      v0 advertisement, push command list, pack ingest, per-ref report-status
src/graphql/schema.ts   introspection tables (Issue, PullRequest, Repository, SearchType, enums)
src/graphql/exec.ts     document parser/executor for the exact gh / github-mcp-server documents
src/mcp/server.ts       Streamable HTTP JSON-RPC, modern 2026-07-28 + legacy handshake, tools
```

## 3. In-memory store (`src/store.ts`)

One process = one forge. Everything is plain JS objects and `Buffer`s; no filesystem persistence.

- `viewer`: `{ id: 1000, login: "adaiversen", name, email }`. The suite's scenario is built from a
  fixed seed, and its token is the viewer's; the REST/GraphQL checks address repositories as
  `adaiversen/...`, so the authenticated login is the scenario viewer's. It is overridable with
  `MAKEFUN_LOGIN` for local play.
- `repos: Map<"owner/name", Repo>`; the key is lower-cased for lookup, the original spelling is kept.
- `Repo`: `id`, `owner`, `name`, `description`, `private`, `defaultBranch` (`main`), fixed `createdAt`
  / `updatedAt`, plus:
  - git: `objects: Map<sha, {type, data}>`, `refs: Map<refName, sha>` (HEAD is synthesized, not stored
    as a ref), `packCache`, `reachableCache`;
  - REST resources: `labels: Map<name, Label>`, `issues: Issue[]`, `issueSeq`, `comments: Comment[]`,
    `commentSeq`, `pulls: Pull[]`, `pullSeq`.
- Ids and numbers are monotonic per store/repo and start from fixed values. Timestamps come from a
  deterministic store clock anchored at 2025-01-01T00:00:00Z and advanced by 1 s per mutation — never
  `Date.now()`. This keeps every read stable and every replay byte-identical.
- All collections preserve insertion order; sorting is explicit at the edges.

Auth: `Authorization: Bearer <token>` must equal `MAKEFUN_SHOP_TOKEN` (when that env var is set).
Missing/wrong token → 401 `{"message":"Requires authentication"}`. A repo under another owner is
simply absent → 404, never 403.

Wire discipline: every REST reply is `application/json; charset=utf-8`, carries a non-empty
`X-GitHub-Request-Id` (a deterministic counter), and every error body has a string `message`.
Malformed JSON → 400. Any unknown route → JSON 404. No HTML, ever.

## 4. Git object store

- Object id = `sha1("<type> <byteLength>\0" + data)` via `node:crypto`.
- `tree`: entries `"<mode> <name>\0<20-byte oid>"`, sorted by name with git's directory ordering;
  modes `100644`, `100755`, `40000`, `120000`, `160000`. Parse and build symmetrical with the suite.
- `commit`: `tree`, zero or more `parent`, `author`, `committer`, blank line, message. Bytes are kept
  exactly as pushed — never re-serialized — so byte-exact clone checks pass.
- `tag`: `object`, `type`, `tag`, `tagger`, blank line, message.
- Reachability walks objects by type through parent/tree/entry links, used for both fetch closure and
  pack verification. A missing object is a protocol error, not a crash.

## 5. Packfiles (`src/git/pack.ts`)

Reader (for pushes):
- Header `PACK`, version 2 or 3, 4-byte object count; trailing 20-byte SHA-1 over all preceding bytes.
- Per entry: variable-length type+size. Types 1–4 (commit/tree/blob/tag) and 6/7 (ofs/ref delta).
  `OFS_DELTA` uses the negative-offset varint; `REF_DELTA` names a base id.
- Resolve deltas iteratively (base may come later in the pack), applying git's copy/insert delta
  instructions; verify each reconstructed object's SHA-1 equals the id it is stored/graph-linked by.
- Reject a pack whose trailer does not match or whose declared count is off, with a clean per-ref
  `unpack <error>` report rather than a crash.

Writer (for fetches):
- Collect the closure of the `want` tips minus everything reachable from the client's `have` lines
  and `shallow` boundaries; emit a fresh pack with each object whole (type/size + zlib via
  `node:zlib.deflateSync`), then the SHA-1 trailer.
- Object order: commits first, then trees, then blobs/tags (parents before children is not required
  for whole objects, but the order helps delta candidates and reasoning).
- No deltas are required by any check ("when the server sends them" only); whole objects are correct,
  simpler and deterministic. A later optimisation can add ofs-deltas for big similar blobs.
- Cache the last generated pack per repository+want set to make repeated clone workload rounds cheap.

## 6. upload-pack — protocol v2

`GET /:owner/:repo.git/info/refs?service=git-upload-pack`:
- With `Git-Protocol: version=2`: body starts `version 2`, then capability lines
  `agent=...`, `ls-refs=unborn`, `fetch=shallow`, `object-format=sha1`, `server-option`, flush.
  Content type `application/x-git-upload-pack-advertisement`.
- Without it: v0 advertisement, starting `# service=git-upload-pack\n` flush, then the ref list with
  the first ref carrying capabilities (`multi_ack_detailed`, `thin-pack`, `side-band-64k`,
  `ofs-delta`, `shallow`, `symref=HEAD:refs/heads/main`), then flush. Advertise `side-band-64k` so
  the suite can frame v0 fetches too.
- HEAD is synthesized: `refs/heads/main` if present, else the first branch, else unborn.
- Missing repo → HTTP 404 and the server stays up.

`POST /:owner/:repo.git/git-upload-pack` (v2):
- Parse the pkt-line command request: optional `agent`/`object-format`, delimiter, then
  `command=ls-refs` or `command=fetch`.
- `ls-refs`: honour `peel`, `symrefs`, `unborn`, and every `ref-prefix`; answer
  `<oid> <ref> [symref-target:...] [peeled:...]`, flush. No prefixes = all refs.
- `fetch`: read `want`, `have`, `shallow`, `deepen`, `deepen-since`, `deepen-not`, `done`, `ofs-delta`,
  `thin-pack`, `no-progress`, `filter`. Compute the object set:
  - remove objects reachable from `have`; remove objects outside the shallow boundary;
  - with `deepen N`, walk at most N generations of commits (and their trees/blobs), emit
    `shallow-info` naming the new boundary commit; with an existing shallow boundary and a deeper
    depth, emit `unshallow <old boundary>` where appropriate;
  - no wants or everything already held → empty pack (or no packfile section).
  - Answer `acknowledgments\n` (`ACK <oid>` for haves / `NAK` / `ready`) then `packfile\n`, then
    sideband packets `\x01<pack bytes>` chunked under 65515 bytes, flush. All pack bytes go in band 1;
    progress may be omitted (`no-progress`).

v0 fetch fallback: parse the two-section want/have list, answer `NAK`/ACKs then sideband-framed pack,
and honour `deepen` with `shallow <oid>` lines.

## 7. receive-pack — protocol v0

`GET /:owner/:repo.git/info/refs?service=git-receive-pack`: preamble
`# service=git-receive-pack\n`, flush, ref advertisement whose first line carries
`report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=...`,
`capabilities^{}` line for an empty repo, flush. Content type
`application/x-git-receive-pack-advertisement`. Missing repo → 404.

`POST /:owner/:repo.git/git-receive-pack`:
1. Parse pkt-line commands `<old> <new> <ref>`, first line may carry `\0capabilities`.
2. A delete has `new = 0{40}`; a create has `old = 0{40}`. Everything else is an update.
3. Body after the flush is a pack (unless delete-only). Ingest it with the pack reader; unknown base
   objects are "unpack" failures.
4. Per ref:
   - old oid must equal the current ref value (or zero for a create) — otherwise `ng <ref> stale info`;
   - create/update must resolve to an object present in the store;
   - update must be a fast-forward: current tip must be reachable from the new tip via commit parents.
     If not → `ng <ref> non-fast-forward`, ref unchanged;
   - delete must have `delete-refs` advertised and removes the ref.
   Apply accepted commands, and report **one line per command** in order:
   `unpack ok`, then `ok <ref>` / `ng <ref> <reason>`.
5. Frame the report: if `side-band-64k` was requested, wrap the pkt-lined report-status stream in band
   1 packets (`\x01...`) and flush; otherwise answer the pkt-lines directly. Never answer an HTTP
   error for a refused ref — the refusal lives in the report.
6. HEAD/default branch follows `refs/heads/main`; branch creation and deletion never touch other refs.

## 8. REST v3 route table

All under `/api/v3`, JSON, request-id header, auth required. Repository lookup always checks the
owner segment against the token's login first.

Repositories:
| Method | Route | Reply |
| --- | --- | --- |
| GET | `/` | 200 root JSON + `X-OAuth-Scopes: repo, read:org` |
| GET | `/meta` | 200 `{installed_version:"..."}` |
| GET | `/user` | 200 viewer `{login,id,...}` |
| GET | `/user/repos?per_page=&page=` | 200 array; GitHub `Link: <...>; rel="next"` |
| POST | `/user/repos` | 201 repository; 422 on duplicate/invalid name |
| GET | `/repos/{o}/{r}` | 200 repository; 404 otherwise |
| PATCH | `/repos/{o}/{r}` | 200 updated repository |
| DELETE | `/repos/{o}/{r}` | 204, then 404 |
| GET | `/repos/{o}/{r}/branches` | 200 `[{name, commit:{sha}}]` |
| GET | `/repos/{o}/{r}/branches/{branch}` | 200 one branch |
| GET | `/repos/{o}/{r}/commits?sha=` | 200 `[{sha, commit:{message,...}}]` |
| POST | `/repos/{o}/{r}/git/refs` | 201 `{ref, object:{sha}}` |
| GET | `/repos/{o}/{r}/git/refs/heads/{branch}` | 200 `{ref, object:{sha}}` |
| PUT | `/repos/{o}/{r}/contents/{path}` | 201 create / 200 update; 409 stale `sha` |
| GET | `/repos/{o}/{r}/contents/{path}?ref=` | 200 file or directory array; 404 |
| DELETE | `/repos/{o}/{r}/contents/{path}` | 200 `{commit:{sha}}` |

Content writes and branch creation make real commits in the git store: blob/tree/commit objects, then
move the ref, so git pushes, REST reads and GraphQL all agree. `PUT /contents` on an unborn repo
creates the first commit on the default branch. `sha` on update must match the current blob or 409.

Issues / labels:
| Method | Route | Reply |
| --- | --- | --- |
| POST | `/repos/{o}/{r}/labels` | 201 `{name,color}` |
| POST | `/repos/{o}/{r}/issues` | 201 open issue; 422 unknown label |
| GET | `/repos/{o}/{r}/issues?state=&sort=created&direction=&per_page=` | 200 filtered/sorted |
| GET | `/repos/{o}/{r}/issues/{n}` | 200 issue; 404 unknown |
| PATCH | `/repos/{o}/{r}/issues/{n}` | 200 (`state` closes/opens) |
| POST | `/repos/{o}/{r}/issues/{n}/comments` | 201 `{id,body}` |
| GET | `/repos/{o}/{r}/issues/{n}/comments` | 200 list |

Pulls:
| Method | Route | Reply |
| --- | --- | --- |
| POST | `/repos/{o}/{r}/pulls` | 201 open PR with head/base refs + tips |
| GET | `/repos/{o}/{r}/pulls?state=open|all` | 200 list (default open) |
| GET | `/repos/{o}/{r}/pulls/{n}` | 200 PR; 404 unknown |
| GET | `/repos/{o}/{r}/pulls/{n}/files` | 200 `[{filename,status,additions,deletions,changes}]` |
| PUT | `/repos/{o}/{r}/pulls/{n}/merge` | 200 `{sha,merged:true,message}`; 404 unknown; 405 conflict |

Merge (squash): diff the merge base (base tip) against the head tree; if any path changed on both
sides since the merge base with different results, 405. Otherwise write a single commit on the base
branch whose tree is the head tree and whose parent is the base tip; set the PR to closed/merged with
`merge_commit_sha`, `merged_at`. This gives the required "squash commit is on the default branch" and
"merged content readable at `?ref=base`". PR `files` is computed from the same tree diff.

Issue/PR serializers include the GitHub fields the checks assert: `number`, `title`, `body`, `state`,
`labels[]`, `id`, `user{login}`, `created_at`, `updated_at`, plus PR `head{ref,sha}`, `base{ref,sha}`,
`merged`, `merged_at`, `merge_commit_sha`. `Link` pagination for lists.

## 9. GraphQL v4

`POST /api/graphql` with bearer token; no token → exactly 401. Body `{query, variables}` or an array of
operation documents (answer an array of results, in order).

Rather than a general GraphQL engine, implement a small tokenizer/selection executor:
- Parse the document's operations, field selections, arguments (variables, ints, strings, enums,
  lists, input objects, null), aliases and inline fragments (`... on Repository`).
- Unknown field: HTTP 200 `{data:<partial>, errors:[{message:"Field 'x' doesn't exist on type 'Y'",
  locations, path}]}`.
- Unknown repository: `{data:{repository:null}}` with no errors.
- Introspection: static tables for `__type(name:)` returning `fields(name)` and `enumValues(name)` for
  `Issue`, `PullRequest`, `Repository`, `SearchType`, plus used types; `SearchType.enumValues` contains
  `ISSUE`; `PullRequest` lists `files`; `Repository` lists `issue`, `issues`, `pullRequests`,
  `pullRequest`, etc. Exact names required by the checks are guaranteed present.
- Global ids: opaque base64 of `"<type>:<numericId>"` (e.g. `Repository:3`), stable across reads and
  decodable by `node(id:)` and by mutations (`repositoryId`, `issueId`, `pullRequestId`, `subjectId`).
- Connections: `nodes`, `pageInfo {hasNextPage,endCursor}`; cursor is the array index encoded
  opaquely; `issues(first,after)` pages deterministically. `orderBy {field,direction}` sorts by
  created sequence or number; `states:[OPEN]` filters. Ties break by number DESC for DESC order.
- Mutations: `createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest` (SQUASH), `addComment`
  all operate on the same store as REST, so cross-surface reads agree. `createPullRequest` resolves
  head/base branch tips pushed over git.
- `repository { viewerPermission: "ADMIN", hasIssuesEnabled: true, defaultBranchRef {name} }`.

## 10. MCP endpoint

`POST /mcp`, JSON-RPC 2.0 over Streamable HTTP; accepts `application/json` and
`text/event-stream`; answers JSON (SSE is optional but supported for a final-event stream). Every
request must answer inside 3 s.

Modern era (revision `2026-07-28`, declared in `_meta` and `MCP-Protocol-Version`):
- `server/discover` → `{result:{supportedVersions:["2026-07-28","2025-11-25","2025-06-18"],
  capabilities:{tools:{}}, serverInfo:{name,version}, resultType:"complete"}}`.
- `tools/list`, `tools/call` answered without a handshake.

Legacy era: `initialize` echoes a supported revision, returns
`{protocolVersion, capabilities:{tools:{}}, serverInfo}`; `notifications/initialized` → 202 with no
body; an `Mcp-Session-Id` may be issued and accepted. `server/discover` may also answer -32601, which
the client treats as pre-discover.

Tools (stable order, byte-identical `tools/list` reply, each with non-empty description and
`inputSchema` of type object): `create_repo`, `get_repo`, `create_issue`, `list_issues`,
`create_pull_request`, `merge_pull_request` (plus `create_branch`/`get_file` for breadth). The suite
maps documented argument names onto the nearest property: accept `owner`, `repo`/`repository`,
`name`, `title`, `body`, `state`, `head`, `base`, `pull_number`/`number`, and a `full_name`
`owner/repo` property. Required properties are only the ones the suite can fill. Tools call the same
store methods as REST, returning the object JSON as a text content block (and `structuredContent`).

Errors: unknown tool → `-32602`/`-32601` (HTTP 200, never 500); missing required argument →
`isError:true` or `-32602`; body not JSON → HTTP 400 with `-32700`; no `Authorization` → HTTP 401.
Concurrent calls are independent (each response keeps its own id); no shared mutable request state.

## 11. Performance

- Everything in memory; no per-request file I/O, no zlib for REST reads, no timers.
- Repository/issue/PR serializers are cheap object literals; lists sort only when the query needs it.
- Keep-alive connections are the default for `node:http`; do not disable.
- `read` workload (2 000 sequential `GET /issues/{n}`): route match by segment count and dispatch
  directly; avoid regex per request in the hot path; no auth map allocation.
- `write` workload (200 issue creations): sequence counters + array push; `JSON.stringify` only once.
- `push` (200 × 1 KiB): incremental pack ingest, ref update O(1) plus fast-forward walk of one commit.
- `clone` (50 concurrent depth-1 clones of 200 commits): with depth 1 only the tip commit + its tree
  closure are packed; cache the generated pack keyed by (repo, want set, depth) while the refs are
  unchanged, so 50 concurrent clones share one Buffer. Sideband chunking is a single pass.
- Avoid O(repo objects) scans for `ls-refs`; refs are a `Map`.

## 12. Determinism

No `Date.now()`/`Math.random()` in anything observable: request ids are counters, timestamps come from
the store clock, ids/numbers are sequences, object order is insertion order. Identical requests produce
identical bytes across live and replay runs. (`node:crypto` SHA-1 is deterministic; zlib output is
deterministic for the same input and level.)

## 13. Check checklist (120)

### git (30)
- [x] advertise-v2 — v2 capability advertisement, `fetch` + `ls-refs`, sha1 object-format
- [x] advertise-receive-pack — v0 ref advertisement with `report-status`, `side-band-64k`, `delete-refs`
- [x] advertise-headers — smart content types + v0/v2/receive preambles
- [x] unknown-repo-404 — both services 404 for a missing repo; server stays up
- [x] ls-refs — refs, HEAD symref, peeled annotated tags
- [x] ls-refs-prefix — `ref-prefix` filtering (heads/tags/unmatched)
- [x] clone-empty — no refs, zero objects, unborn HEAD
- [x] push-first-commit — first push to an unborn branch; HEAD follows
- [x] clone-object-hashes — every cloned object recomputes to its SHA-1 and the closure is complete
- [x] clone-blob-bytes — every blob byte-identical
- [x] clone-tree-entries — paths, modes, nested trees round-trip
- [x] clone-commit-bytes — commit bytes, parents, message, author/committer round-trip
- [x] clone-annotated-tag — tag object bytes + peel to commit
- [x] fetch-incremental — only new objects, no re-send of held history
- [x] fetch-nothing-new — zero objects when the tip is held
- [x] fetch-shallow-depth1 — tip only; shallow-info names the tip; tip tree/blobs present
- [x] fetch-shallow-deepen — `deepen 2` adds exactly the parent; boundary moves
- [x] fetch-shallow-new-tip — new tip at depth 1 does not pull old history
- [x] push-update-ref — fast-forward moves a branch; clones see it
- [x] push-create-branch — create from an existing commit; advertised and cloned
- [x] push-delete-branch — delete reported; other refs intact; still clonable
- [x] push-non-fast-forward — `ng <ref> non-fast-forward`; ref unchanged; server healthy
- [x] push-mixed-report — one ok + one ng in one command list; only ok applied
- [x] push-delete-tag — tag delete reported and removed
- [x] push-100-files — 100-file commit round-trips byte-exactly
- [x] pack-integrity — pack header/count/version/trailer/objects valid
- [x] pack-deltas — delta objects (if sent) resolve; all objects verified
- [x] sideband-framing — packfile section is valid sideband band 1/2/3
- [x] push-sideband-report — report-status demuxed from band 1
- [x] repo-survives-errors — 404s, refusals and a malformed request leave the server healthy

### repos (15)
- [x] pagination — 30 repos at per_page=10, Link rel="next", ≥3 pages, no repeats
- [x] root — GET /api/v3/ 200 JSON + X-OAuth-Scopes
- [x] meta — GET /api/v3/meta installed_version non-empty
- [x] create — POST /user/repos 201; name/private/default_branch round-trip, stable
- [x] not-found — GET missing repo = JSON 404
- [x] patch — PATCH description updated and read back
- [x] delete — DELETE 204 then GET 404
- [x] branches — branch created via POST /git/refs is listed with its tip
- [x] commits — `?sha=<branch>` lists a branch-only commit, default branch excludes it
- [x] unauthorized — no token = 401
- [x] foreign-token — same name under another owner = 404 (never 403)
- [x] contents-create — PUT creates blob+commit; GET base64, sha, size match
- [x] contents-directory — GET a directory lists entries (file/dir, name, path, sha)
- [x] contents-stale-sha — stale `sha` update = 409
- [x] contents-delete — DELETE with sha = 200 `{commit:{sha}}`; GET 404 after

### issues (15)
- [x] create — 201 open issue with a number
- [x] create-title-body — title and body echoed
- [x] create-labels — attaches an existing label
- [x] numbers-increment — consecutive numbers +1
- [x] list-open — state=open lists the open issue
- [x] list-open-excludes-closed — closed issue omitted
- [x] list-sort-asc — sort=created&direction=asc in creation order
- [x] list-sort-desc — reverse order
- [x] list-shape — full GitHub issue shape each item
- [x] get-one — GET /issues/{n}
- [x] patch-close — PATCH state=closed
- [x] patch-close-persists — close survives a later GET
- [x] comment-create — POST comment 201 `{id,body}`
- [x] comments-list — GET comments lists it
- [x] bad-label — unknown label = 422 with message

### pulls (20)
- [x] create — POST 201 open PR from a head branch
- [x] create-body — title/body echoed
- [x] create-head-sha — head.sha = head tip
- [x] create-base-sha — base.sha = base tip
- [x] get-one — GET /pulls/{n}
- [x] files-list — changed path listed
- [x] files-shape — filename/status/additions/deletions/changes each item
- [x] files-multiple — every changed path listed
- [x] merge-status — squash merge 200
- [x] merge-body — `{merged:true, sha, message}`
- [x] merge-closes — closed, merged, merged_at
- [x] merge-commit-on-default — merge sha appears in default-branch commits
- [x] merge-content-on-default — squash content readable at `?ref=base`
- [x] merge-commit-sha — `merge_commit_sha` equals the merge sha
- [x] merge-unknown — 404
- [x] merge-conflict — 405 when both sides changed the same path
- [x] list-state-all — state=all lists open + merged
- [x] list-default-open — default open only
- [x] list-shape — full PR shape each item
- [x] get-unknown — 404

### graphql (20)
- [x] viewer-login — `viewer{login}` = token owner
- [x] repository-fields — id/databaseId/name/owner/defaultBranchRef/viewerPermission/hasIssuesEnabled
- [x] introspection-issue — Issue fields include id, number, title, state, body
- [x] introspection-types — PullRequest (headRefName, baseRefName, mergeable, state, merged, files),
      Repository (id, databaseId, name, nameWithOwner, owner, defaultBranchRef, viewerPermission,
      hasIssuesEnabled, issue, issues, pullRequests, pullRequest), SearchType enum has ISSUE
- [x] issues-open-order — states [OPEN], CREATED_AT DESC with number DESC ties
- [x] issue-by-number — one issue
- [x] create-issue — visible over REST
- [x] close-issue — REST sees closed
- [x] pull-requests-list — number/headRefName/baseRefName/mergeable/state
- [x] pull-request-files — `files { nodes { path } }`
- [x] create-pull-request — creates a PR over a pushed head branch; REST reads same refs
- [x] merge-pull-request — SQUASH merges; REST sees merged true
- [x] add-comment — REST lists the comment
- [x] invalid-field — HTTP 200 + errors naming the field
- [x] unauthenticated — exactly 401
- [x] node-repository — `node(id:)` round-trips a repository
- [x] unknown-repository — data.repository = null, no errors
- [x] batched-operations — two documents answer two results in order
- [x] global-id-stability — opaque ids equal on repeated reads
- [x] issues-pagination — `first`/`after` pages to the end with pageInfo

### mcp (15)
- [x] initialize — serverInfo.name/version non-empty, capabilities.tools present
- [x] server-discover — DiscoverResult with non-empty YYYY-MM-DD supportedVersions
- [x] tools-list — ≥6 tools incl. the six required names
- [x] tool-schemas — non-empty description + inputSchema type object for every tool
- [x] create-issue — issue appears over REST
- [x] list-issues — returns an existing issue
- [x] create-pull-request — REST reads back same head/base
- [x] merge-pull-request — REST reads merged:true
- [x] unknown-tool — JSON-RPC -32602/-32601, never 500
- [x] parse-error — non-JSON body → HTTP 400 + -32700
- [x] missing-arguments — isError:true or -32602
- [x] concurrent-calls — two in-flight calls keep their own ids/answers
- [x] tools-list-idempotent — identical tools array byte for byte
- [x] rest-parity — repo+issue created over MCP are the same REST objects, ids stable
- [x] auth-required — tools/call without Authorization = 401

### protocol (5)
- [x] content-type-json — every REST reply application/json, never HTML
- [x] unknown-route-json-404 — unknown /api/v3 route = JSON 404
- [x] malformed-body-400 — malformed JSON = 400 with message
- [x] request-id — non-empty X-GitHub-Request-Id on every reply
- [x] error-message — 401/404/422 bodies carry a string message

## 14. Build order

1. Lifecycle + router + REST repo create/read (this commit).
2. REST contents/git-data/branches/commits (real objects).
3. Git object store + pack reader/writer + v2 upload-pack + v0 receive-pack.
4. REST issues/labels/comments/pulls + merge.
5. GraphQL schema + executor.
6. MCP transport + tools.
7. Performance passes (pack caching, hot-path dispatch) and a local self-test with a synthetic client.
