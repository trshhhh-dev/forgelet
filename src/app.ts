// The forge's HTTP front door.  It owns three things every surface shares:
//   - a non-empty X-GitHub-Request-Id on every reply (a deterministic counter, never a clock);
//   - the bearer-token gate for /api/v3 (the token in MAKEFUN_SHOP_TOKEN; no token -> 401);
//   - one error boundary that turns any throw into a JSON body with a string message, never HTML.
// Route handling is delegated to the resource modules; this file only dispatches.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { MAX_JSON_BODY_BYTES, SHOP_TOKEN } from './config.ts';
import { HttpError, readBody, readJsonBody, sendEmpty, sendJson } from './http.ts';
import { Router, type RequestContext } from './router.ts';
import { Store } from './store.ts';
import { registerRepositoryRoutes } from './rest/repos.ts';
import { registerGitDataRoutes } from './rest/gitdata.ts';
import { registerContentsRoutes } from './rest/contents.ts';
import { registerIssueRoutes } from './rest/issues.ts';
import { registerPullRoutes } from './rest/pulls.ts';
import { executeGraphQL } from './graphql/exec.ts';
import { handleMcpBody, mcpMethodNotAllowed } from './mcp/server.ts';
import { registerGitRoutes } from './git/http.ts';

/** A per-process counter: unique enough for a request id, and identical across live/replay runs. */
let requestSeq = 0;

function nextRequestId(): string {
  requestSeq += 1;
  return `forge-${requestSeq.toString(36)}`;
}

function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : (match[1] as string).trim();
}

/** The token must be the trial's.  With no expected token (local run) any non-empty bearer is accepted. */
function requireAuth(req: IncomingMessage): void {
  const presented = bearerOf(req);
  if (presented === null || presented === '') {
    throw new HttpError(401, 'Requires authentication');
  }
  if (SHOP_TOKEN !== '' && presented !== SHOP_TOKEN) {
    throw new HttpError(401, 'Bad credentials');
  }
}

function isApiPath(pathname: string): boolean {
  return pathname === '/api/v3' || pathname.startsWith('/api/v3/');
}

function hasBody(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://forge').pathname;
  } catch {
    return '/';
  }
}

function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://forge');
  } catch {
    return new URL('/', 'http://forge');
  }
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  router: Router,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const pathname = pathOf(req);

  // The env's boot probe, and the only route that takes no token.
  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === '/api/graphql' || pathname === '/mcp') {
    // GraphQL and MCP are not under /api/v3, but both carry JSON bodies and need the same bearer
    // gate.  MCP reads the raw bytes itself so a malformed body can answer JSON-RPC -32700.
    requireAuth(req);
    const graphFound = router.match(method, pathname);
    if (graphFound === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    let graphBody: unknown;
    let rawBody: Buffer | undefined;
    if (method === 'POST') {
      if (pathname === '/mcp') rawBody = await readBody(req, MAX_JSON_BODY_BYTES);
      else graphBody = await readJsonBody(req, MAX_JSON_BODY_BYTES);
    }
    const context: RequestContext = { req, res, url: urlOf(req), params: graphFound.params, body: graphBody, rawBody };
    await graphFound.handler(context);
    return;
  }

  if (!isApiPath(pathname)) {
    // Git smart HTTP: /{owner}/{repo}.git/info/refs and the two service POSTs.  An unknown path is a
    // JSON 404 before auth (it reveals nothing); a git route itself requires the same bearer token.
    const found = router.match(method, pathname);
    if (found === null) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }
    requireAuth(req);
    const ctx: RequestContext = { req, res, url: urlOf(req), params: found.params, body: undefined };
    await found.handler(ctx);
    return;
  }

  requireAuth(req);

  // Body parsing happens only for the REST surface and only on methods that carry one.  A malformed
  // body is a 400 before any handler runs, which is what the protocol checks require.
  let body: unknown;
  if (hasBody(method)) {
    body = await readJsonBody(req, MAX_JSON_BODY_BYTES);
  }

  const found = router.match(method, pathname);
  if (found === null) {
    throw new HttpError(404, 'Not Found');
  }

  const ctx: RequestContext = {
    req,
    res,
    url: urlOf(req),
    params: found.params,
    body,
  };
  await found.handler(ctx);
}

/** A JSON error body: a message string plus any structured details the thrower attached. */
function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { message: err.message, ...err.extra });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[forge] unexpected error: ${message}\n`);
  sendJson(res, 500, { message: 'Internal Server Error' });
}

/** Build the forge.  Nothing binds until the caller listens (main.ts listens on port 0). */
export function createApp(): Server {
  const store = new Store();
  const router = new Router();
  registerRepositoryRoutes(router, store);
  registerGitDataRoutes(router, store);
  registerContentsRoutes(router, store);
  registerIssueRoutes(router, store);
  registerPullRoutes(router, store);
  router.post('/api/graphql', (ctx) => {
    sendJson(ctx.res, 200, executeGraphQL(store, ctx.body));
  });
  router.post('/mcp', (ctx) => handleMcpBody(store, ctx.rawBody, ctx.res));
  router.delete('/mcp', (ctx) => sendEmpty(ctx.res, 204));
  router.get('/mcp', (ctx) => mcpMethodNotAllowed(ctx.res));
  registerGitRoutes(router, store);

  return createServer((req, res) => {
    res.setHeader('x-github-request-id', nextRequestId());
    // The suite never asks for HTML; a conservative no-sniff header keeps intermediaries honest.
    res.setHeader('x-content-type-options', 'nosniff');

    dispatch(req, res, router).catch((err: unknown) => {
      // A reply that already started cannot be turned into a JSON error; drop the connection.
      if (res.headersSent) {
        res.destroy();
        return;
      }
      sendError(res, err);
    });
  });
}

/** For tests and future surfaces: the store a server was built with is private by design. */
export type { Store };
