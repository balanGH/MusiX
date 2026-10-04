/**
 * Is the backend reachable, and may this app use it?
 *
 * Studio and Download need the Python service. On the desktop it is the one
 * on this machine, reached through the Vite proxy, and the pages that use it
 * already probe it themselves when opened — so nothing here runs on the web
 * unless the user has pointed the app at another server. In the Android app
 * there is no service unless the user connects to the one on their PC, and
 * those features are hidden until a probe says it is there.
 *
 * Probes run on startup, when the server settings change, and when the app
 * comes back to the foreground — never on a timer (spec §37).
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import { isNativeApp } from '@core/platform/native';
import { apiHeaders, apiUrl, currentServer, hasCustomServer } from './apiBase';

export type ServerState =
  /** Android app with no server address entered. */
  | 'not-configured'
  | 'ok'
  /** Nothing answered: wrong address, PC asleep, firewall, other network. */
  | 'unreachable'
  /** Something answered, but not a MusiX server. */
  | 'not-musix'
  /** The server refused the password that was sent. */
  | 'wrong-token'
  /** The server needs a password and none is set. */
  | 'needs-token';

export interface ProbeResult {
  state: ServerState;
  /** The server's version, when it answered. */
  version?: string;
  /** A detail worth showing, e.g. an HTTP status. */
  message?: string;
}

interface HealthBody {
  status?: string;
  version?: string;
  auth?: 'required' | 'none';
}

const PROBE_TIMEOUT_MS = 5000;

/** One request to `/health`, classified. Never throws. */
export async function probeServer(): Promise<ProbeResult> {
  if (isNativeApp() && !hasCustomServer()) return { state: 'not-configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(apiUrl('/health'), {
      headers: apiHeaders(),
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch {
    return { state: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401) return { state: 'wrong-token' };
  if (!response.ok) {
    return { state: 'unreachable', message: `${response.status} ${response.statusText}`.trim() };
  }

  let body: HealthBody;
  try {
    body = (await response.json()) as HealthBody;
  } catch {
    // An HTML page, typically — the address points at some other web server.
    return { state: 'not-musix' };
  }
  if (body?.status !== 'ok') return { state: 'not-musix' };

  if (body.auth === 'required' && !currentServer().token) {
    return { state: 'needs-token', version: body.version };
  }
  return { state: 'ok', version: body.version };
}

interface ServerStatusStore {
  /** The latest settled probe; null until the first one finishes. */
  result: ProbeResult | null;
  checking: boolean;
}

export const useServerStatus = create<ServerStatusStore>(() => ({
  result: null,
  checking: false,
}));

let inFlight: { key: string; promise: Promise<ProbeResult> } | null = null;

/**
 * Probe now and publish the result.
 *
 * A probe already running for the same server is shared rather than repeated,
 * and a probe for a server the user has since changed is discarded — its
 * answer is about an address no longer in use.
 */
export function refreshServerStatus(): Promise<ProbeResult> {
  const key = `${currentServer().url}\n${currentServer().token}`;
  if (inFlight?.key === key) return inFlight.promise;

  useServerStatus.setState({ checking: true });
  const promise = probeServer().then((result) => {
    if (inFlight?.key === key) {
      inFlight = null;
      // `result` is kept through re-probes, so a resume-time check does not
      // briefly hide Studio — and unmount it mid-job — while it runs.
      useServerStatus.setState({ result, checking: false });
    }
    return result;
  });
  inFlight = { key, promise };
  return promise;
}

/**
 * Whether to show Studio and Download.
 *
 * On the web: always, as before — those pages explain for themselves when the
 * local service is not running. In the Android app: only once a probe has
 * found a usable server. `settled` is false until the first probe finishes, so
 * a route can wait instead of redirecting away on launch.
 */
export function useBackendFeatures(): { visible: boolean; settled: boolean } {
  const result = useServerStatus((state) => state.result);
  if (!isNativeApp()) return { visible: true, settled: true };
  return { visible: result?.state === 'ok', settled: result !== null };
}

/**
 * Keep `useServerStatus` current. Mount once, near the root, with the server
 * settings so a change to them triggers a fresh probe.
 */
export function useServerStatusWatcher(serverUrl: string, serverToken: string): void {
  useEffect(() => {
    // The desktop's own service is probed by the pages that use it; probing it
    // here as well would only add a failing request on every launch for the
    // many users who never start it.
    if (!isNativeApp() && !serverUrl) return;

    void refreshServerStatus();

    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshServerStatus();
    };
    // Capacitor fires `resume` on the document when the app returns to the
    // foreground; `visibilitychange` covers browsers and is a backstop.
    document.addEventListener('visibilitychange', onVisible);
    document.addEventListener('resume', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener('resume', onVisible);
    };
  }, [serverUrl, serverToken]);
}
