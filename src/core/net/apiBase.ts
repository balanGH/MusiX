/**
 * The one place that knows where the optional local backend lives.
 *
 * By default requests go same-origin to `/api`, which vite.config.ts proxies to
 * the service in dev and `vite preview`. A build that cannot proxy (a native
 * shell, say) can point at the service directly with `VITE_MUSIX_API_BASE`,
 * e.g. `http://127.0.0.1:8000`. That origin must then allow the app's origin
 * in the service's `MUSIX_ALLOWED_ORIGINS`.
 */

const override = (import.meta.env.VITE_MUSIX_API_BASE as string | undefined)?.trim();

/** Prefix for every backend route, e.g. `${API_ROOT}/health`. No trailing slash. */
export const API_ROOT = `${override ? override.replace(/\/+$/, '') : ''}/api`;
