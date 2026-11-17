// HTTP plumbing shared by every surface: one JSON writer, one body reader, one error type.
// Nothing here decides a route; it only keeps the wire discipline (JSON only, a message string on
// every error, no HTML) in one place.

import type { IncomingMessage, ServerResponse } from 'node:http';

export const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/** An error with an HTTP status and a GitHub-shaped body. */
export class HttpError extends Error {
  readonly status: number;
  readonly extra: Readonly<Record<string, unknown>>;

  constructor(status: number, message: string, extra: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

/** Write a JSON body.  A charset parameter is allowed by the suite; the request id is set upstream. */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string | number>> = {},
): void {
  if (res.headersSent) return;
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_CONTENT_TYPE,
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

/** Write a bodiless reply (204, or an empty 200). */
export function sendEmpty(
  res: ServerResponse,
  status: number,
  headers: Readonly<Record<string, string | number>> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-length': 0, ...headers });
  res.end();
}

/** Write a raw byte body (git smart HTTP bodies are packets and packs, never JSON). */
export function sendBuffer(
  res: ServerResponse,
  status: number,
  body: Buffer,
  headers: Readonly<Record<string, string | number>> = {},
): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-length': body.length, ...headers });
  res.end(body);
}

/** Read the raw request body under a byte cap.  Over the cap is a 413, not a crash. */
export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const pieces: Buffer[] = [];
  let size = 0;
  for await (const piece of req) {
    const chunk = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as Uint8Array);
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body is too large');
    pieces.push(chunk);
  }
  return pieces.length === 1 ? (pieces[0] as Buffer) : Buffer.concat(pieces);
}

/**
 * Read and parse a JSON body.  An absent body is `undefined`; anything that is not valid JSON is a
 * 400 with a message, which is exactly the contract the suite checks.
 */
export async function readJsonBody(req: IncomingMessage, limit: number): Promise<unknown> {
  const raw = await readBody(req, limit);
  if (raw.length === 0) return undefined;
  const text = raw.toString('utf8');
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpError(400, 'Problems parsing JSON');
  }
}

/** A plain object body, or a 400 when the JSON was not an object. */
export function asObject(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null) return {};
  if (typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Body should be a JSON object');
  return body as Record<string, unknown>;
}

/** A required string field, or a 422 with GitHub's validation wording. */
export function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(422, `Validation Failed: ${field} is required`, {
      errors: [{ resource: 'Repository', field, code: 'missing_field' }],
    });
  }
  return value;
}

/** An optional string field; `null` clears it. */
export function optionalString(body: Record<string, unknown>, field: string): string | null | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (value === null) return null;
  if (typeof value !== 'string') throw new HttpError(422, `Validation Failed: ${field} must be a string`);
  return value;
}

/** An optional boolean field. */
export function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  if (!(field in body)) return undefined;
  const value = body[field];
  if (typeof value !== 'boolean') throw new HttpError(422, `Validation Failed: ${field} must be a boolean`);
  return value;
}
