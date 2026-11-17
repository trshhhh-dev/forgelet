# forgelet

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/trshhhh-dev/forgelet/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/trshhhh-dev/forgelet/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A small, dependency-free GitHub-compatible forge: git smart HTTP, REST v3, GraphQL v4 and a Model Context Protocol endpoint, all backed by one in-memory store. It is built for the make.fun `github-core-clone-01` bounty and answers the same documents `gh` and `github-mcp-server` send.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=test-token node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle: it binds an ephemeral port, POSTs `{"port": N}` to `$MAKEFUN_ENV_URL/register`, then polls `/done` and exits 0. To serve the forge without the harness, start the app directly:

```sh
node --experimental-strip-types -e "import('./src/app.ts').then(({ createApp }) => createApp().listen(8080, () => console.log('forge on http://127.0.0.1:8080')))"
```

## How it works

**Surfaces.** `src/app.ts` is the front door and dispatches to five surfaces:

- `/<owner>/<repo>.git/...` — git smart HTTP (`info/refs`, `git-upload-pack`, `git-receive-pack`) over an in-process object database and pack codec.
- `/api/v3/...` — GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files and merges.
- `POST /api/graphql` — GitHub GraphQL v4: `viewer`, `repository`, issue/pull-request connections with cursors, `refs`, `object(expression)`, Relay global `node(id:)`, `__type` probes and the issue/PR/comment mutations.
- `POST /mcp` — Model Context Protocol over Streamable HTTP, speaking the modern `2026-07-28` revision (`server/discover`) and the legacy `initialize` handshake, with tools backed by the same store.
- `GET /healthz` — the harness boot probe.

**Store.** Everything lives in one deterministic in-memory store (`src/store.ts`): repositories, refs, git objects, issues, pull requests and comments. Mutations advance a fixed clock anchored at `2025-01-01T00:00:00Z` by one second; ids and cursors are monotonic, request ids are counters, and GraphQL global ids are deterministic base64 strings. No `Date.now()`, no `Math.random()`, no network or filesystem state leaks into a response, so a replay of the same requests produces the same bytes.

**Tests.** The kit's local runner drives the entry end to end: 30 git checks, 55 REST checks, 20 GraphQL checks and 15 MCP checks, for 120/120 conformance checks, plus the four performance workloads. GraphQL and MCP are also exercised directly against the same store, so a change made over one surface is immediately visible over the others.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gwmq7j6d&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
