// A deliberately small router.  Paths are split into segments; a `:name` segment captures one
// decoded segment and a trailing `*name` captures the rest of the path (needed for file paths in the
// contents API).  Routes are tried in registration order, so static routes are registered first.

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** Parsed JSON body for REST routes (undefined when the request carried none). */
  body: unknown;
  /** The untouched request body, for the MCP transport (which owns its own JSON-RPC parse errors). */
  rawBody?: Buffer;
}

export type RouteHandler = (ctx: RequestContext) => void | Promise<void>;

interface Route {
  method: string;
  parts: readonly string[];
  handler: RouteHandler;
}

export class Router {
  private readonly routes: Route[] = [];
  /** The benchmark's hot paths repeat thousands of times; match each method+pathname once. */
  private readonly matches = new Map<string, { handler: RouteHandler; params: Record<string, string> } | null>();

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({ method: method.toUpperCase(), parts: splitPattern(pattern), handler });
    return this;
  }

  get(pattern: string, handler: RouteHandler): this {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: RouteHandler): this {
    return this.add('POST', pattern, handler);
  }

  patch(pattern: string, handler: RouteHandler): this {
    return this.add('PATCH', pattern, handler);
  }

  put(pattern: string, handler: RouteHandler): this {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: RouteHandler): this {
    return this.add('DELETE', pattern, handler);
  }

  /** Match one method+pathname; returns null when no route fits. */
  match(method: string, pathname: string): { handler: RouteHandler; params: Record<string, string> } | null {
    const wanted = method.toUpperCase();
    const key = `${wanted}\u0000${pathname}`;
    const cached = this.matches.get(key);
    if (cached !== undefined) return cached;
    const actual = splitPath(pathname);
    let result: { handler: RouteHandler; params: Record<string, string> } | null = null;
    for (const route of this.routes) {
      if (route.method !== wanted) continue;
      const params = matchParts(route.parts, actual);
      if (params !== null) {
        result = { handler: route.handler, params };
        break;
      }
    }
    this.matches.set(key, result);
    return result;
  }
}

function splitPattern(pattern: string): string[] {
  return pattern.split('/').filter((part) => part !== '');
}

function splitPath(pathname: string): string[] {
  const trimmed = pathname === '/' ? [] : pathname.replace(/\/+$/, '');
  return trimmed === '' ? [] : trimmed.split('/').filter((part) => part !== '');
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function matchParts(pattern: readonly string[], actual: readonly string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let index = 0; index < pattern.length; index += 1) {
    const expected = pattern[index] as string;
    if (expected.startsWith('*')) {
      // Greedy tail: the remaining actual segments are one decoded path.
      const rest = actual.slice(index).map(decode).join('/');
      if (rest === '') return null;
      params[expected.slice(1)] = rest;
      return params;
    }
    if (index >= actual.length) return null;
    const got = actual[index] as string;
    if (expected.startsWith(':')) {
      if (got === '') return null;
      params[expected.slice(1)] = decode(got);
      continue;
    }
    if (expected !== got) return null;
  }
  return pattern.length === actual.length ? params : null;
}
