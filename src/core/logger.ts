/**
 * Tiny levelled logger.
 *
 * Reasons this exists rather than bare `console.log`:
 *  - the scanner and audio engine log from a worker, where prefixes matter;
 *  - spec §34 requires the app to survive and *report* failures rather than
 *    crash, so warnings need a single funnel the UI can also subscribe to;
 *  - spec §32 is privacy-first: nothing here ever leaves the device.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogRecord {
  level: LogLevel;
  scope: string;
  message: string;
  detail?: unknown;
  at: number;
}

type Listener = (record: LogRecord) => void;

const listeners = new Set<Listener>();
/** Kept for the Settings > Diagnostics panel; bounded so it cannot grow. */
const recent: LogRecord[] = [];
const RECENT_LIMIT = 300;

let threshold: LogLevel = import.meta.env?.DEV ? 'debug' : 'warn';

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

export function onLog(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recentLogs(): readonly LogRecord[] {
  return recent;
}

function emit(level: LogLevel, scope: string, message: string, detail?: unknown): void {
  const record: LogRecord = { level, scope, message, detail, at: Date.now() };

  recent.push(record);
  if (recent.length > RECENT_LIMIT) recent.shift();
  for (const listener of listeners) {
    try {
      listener(record);
    } catch {
      // A broken listener must never take down the thing being logged about.
    }
  }

  if (LEVEL_ORDER[level] < LEVEL_ORDER[threshold]) return;
  const prefix = `[musix:${scope}]`;
  if (level === 'error') console.error(prefix, message, detail ?? '');
  else if (level === 'warn') console.warn(prefix, message, detail ?? '');
  // eslint-disable-next-line no-console
  else console.log(prefix, message, detail ?? '');
}

export interface Logger {
  debug(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (m, d) => emit('debug', scope, m, d),
    info: (m, d) => emit('info', scope, m, d),
    warn: (m, d) => emit('warn', scope, m, d),
    error: (m, d) => emit('error', scope, m, d),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

/** Normalise anything thrown into a readable message (spec §34). */
export function describeError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`;
  if (error instanceof Error) return error.message || error.name;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
