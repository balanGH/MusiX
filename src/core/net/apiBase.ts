/**
 * The one place that knows where the optional backend lives.
 *
 * By default requests go same-origin to `/api`, which vite.config.ts proxies to
 * the service in dev and `vite preview`. A build that cannot proxy can point at
 * the service with `VITE_MUSIX_API_BASE`, e.g. `http://127.0.0.1:8000`.
 *
 * On top of that, the user can choose a server at runtime (Settings → PC
 * server): the Android app has no proxy and no service of its own, so it talks
 * to the backend on the user's PC over Wi-Fi. That choice, and the password
 * the server may require, arrive through `configureServer` — settingsStore
 * calls it on load and on every change, so this module stays free of React and
 * zustand and can be unit-tested on its own.
 *
 * Whatever origin is used must be allowed in the service's
 * `MUSIX_ALLOWED_ORIGINS`.
 */

export interface ServerConfig {
  /** e.g. `http://192.168.1.5:8000`. Empty means the build-time default. */
  url: string;
  /** Shared secret (`MUSIX_API_TOKEN` on the server). Empty means none. */
  token: string;
}

const buildOverride = (import.meta.env.VITE_MUSIX_API_BASE as string | undefined)?.trim() ?? '';

let server: ServerConfig = { url: '', token: '' };

/**
 * Tidy what a person types into an address field: add the scheme they left
 * off, drop trailing slashes, and drop a trailing `/api` (the routes add it).
 * Returns '' for a blank entry.
 */
export function normalizeServerUrl(raw: string): string {
  let url = raw.trim();
  if (!url) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) url = `http://${url}`;
  url = url.replace(/\/+$/, '');
  url = url.replace(/\/api$/i, '');
  return url;
}

export function configureServer(next: ServerConfig): void {
  server = { url: normalizeServerUrl(next.url), token: next.token.trim() };
}

/** The server in use right now, as normalised by `configureServer`. */
export function currentServer(): Readonly<ServerConfig> {
  return server;
}

/** True when the user has chosen a server rather than relying on the default. */
export function hasCustomServer(): boolean {
  return server.url !== '';
}

/** Prefix for every backend route, e.g. `${apiRoot()}/health`. No trailing slash. */
export function apiRoot(): string {
  const base = server.url || buildOverride.replace(/\/+$/, '');
  return `${base}/api`;
}

/** Full URL of a backend route. `path` starts with `/`, e.g. `/health`. */
export function apiUrl(path: string): string {
  return `${apiRoot()}${path}`;
}

/**
 * URL for something loaded by the browser itself — an `<audio>` src, a
 * download link — which cannot carry an Authorization header. The token goes
 * in the query string instead; the service accepts either.
 */
export function apiMediaUrl(path: string): string {
  const url = apiUrl(path);
  if (!server.token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(server.token)}`;
}

/** Headers every backend request should carry, merged over `extra`. */
export function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  return server.token
    ? { ...extra, Authorization: `Bearer ${server.token}` }
    : { ...extra };
}
