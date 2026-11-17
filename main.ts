// The entry's whole life: bind an ephemeral port, tell the trial env where it is, then wait for the
// env to say the trial is over and exit cleanly.  The forge itself lives in src/; this file only
// speaks the register/done protocol.
//
//   1. MAKEFUN_ENV_URL is the env's origin.  Without it there is nothing to talk to.
//   2. listen(0) -> the kernel picks a free port (never 8080: that belongs to the env).
//   3. POST /register {"port": N} until the env answers 200 (or 409: someone else registered first).
//   4. GET /done until the body says {"done": true}; retry transient failures forever.
//   5. close and exit 0.  The env then writes the export the scorer reads.

import { createApp } from './src/app.ts';

const ENV_ORIGIN = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV_ORIGIN === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is unset; no env to register with\n');
  process.exit(1);
}

const CALL_TIMEOUT_MS = 30_000;
const RETRY_MIN_MS = 250;
const RETRY_MAX_MS = 2_000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Exponential backoff that never waits longer than RETRY_MAX_MS. */
function backoff(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(attempt, 8));
}

async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let fatal = false;
    try {
      const reply = await fetch(`${ENV_ORIGIN}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      // 200 is the normal answer.  409 means a first register already won and the base URL is set;
      // either way there is nothing left to do here.
      if (reply.status === 200 || reply.status === 409) return;
      if (reply.status === 400 || reply.status === 405) {
        fatal = true;
        const text = await reply.text().catch(() => '');
        throw new Error(`register answered HTTP ${reply.status}${text === '' ? '' : `: ${text}`}`);
      }
      // Any other status: the env may still be starting, so retry.
    } catch (err) {
      if (fatal) throw err;
      // Connection refused / timeout / 5xx: retry after a pause.
    }
    await pause(backoff(attempt));
  }
}

async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const reply = await fetch(`${ENV_ORIGIN}/done`, {
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      if (reply.ok) {
        const state = (await reply.json().catch(() => null)) as { done?: unknown } | null;
        if (state !== null && state.done === true) return;
      }
    } catch {
      // Not answering yet, or the poll timed out: the trial is not over.
    }
    await pause(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });

  const bound = server.address();
  if (bound === null || typeof bound === 'string') {
    throw new Error('server.listen(0) did not bind a TCP port');
  }
  process.stdout.write(`[entry] forge listening on port ${bound.port}\n`);

  await announce(bound.port);
  process.stdout.write('[entry] registered; serving until the env is done\n');

  await awaitDone();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
