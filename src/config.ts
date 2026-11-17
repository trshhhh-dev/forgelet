// Process-wide constants.  The trial sets MAKEFUN_SHOP_TOKEN; the login is the fixed identity of the
// suite's seeded scenario viewer (the token is opaque, and the suite addresses every fixture repo
// under that login).  MAKEFUN_LOGIN only exists so a local run can use another name.

export const SHOP_TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';
export const VIEWER_LOGIN: string = process.env.MAKEFUN_LOGIN ?? 'adaiversen';

export const INSTALLED_VERSION = 'github-core-clone-forge/0.1.0';

/** The store's clock starts here and advances one second per mutation: stable across reads and runs. */
export const STORE_EPOCH_MS = Date.parse('2025-01-01T00:00:00.000Z');

export const DEFAULT_BRANCH = 'main';

/** JSON body ceiling for REST requests.  Big enough for a 100-file contents write; small enough to fail fast. */
export const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024;
