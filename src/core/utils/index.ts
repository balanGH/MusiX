/**
 * Small, dependency-free helpers shared across the core.
 *
 * Everything here is synchronous and pure so it can run in a Web Worker, in
 * Node (tests) or in the main thread without a platform check.
 */

// ---------------------------------------------------------------------------
// Hashing / ids
// ---------------------------------------------------------------------------

/**
 * 64-bit FNV-1a, returned as 16 hex chars.
 *
 * Track / album / artist ids must be stable across rescans and derivable
 * without a round-trip to the database, so they are content-derived rather than
 * autoincrement. A single 32-bit lane collides with meaningful probability at
 * 100k tracks, so two independently-seeded lanes are combined.
 */
export function hashId(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Hash of raw bytes, used to deduplicate embedded artwork (spec §13). */
export function hashBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x1000193;
  // Sampling stride keeps this O(1)-ish for multi-megabyte covers while still
  // reading the head, tail and length, which is plenty to key a cache on.
  const stride = bytes.length > 65536 ? Math.floor(bytes.length / 4096) : 1;
  for (let i = 0; i < bytes.length; i += stride) {
    const c = bytes[i]!;
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c + i;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (
    h1.toString(16).padStart(8, '0') +
    h2.toString(16).padStart(8, '0') +
    bytes.length.toString(16)
  );
}

let uidCounter = 0;
/** Monotonic non-persisted id, for queue slots and toasts. */
export function uid(prefix = 'u'): string {
  uidCounter = (uidCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}${Date.now().toString(36)}${uidCounter.toString(36)}`;
}

// ---------------------------------------------------------------------------
// Strings
// ---------------------------------------------------------------------------

const COMBINING_MARKS = /[\u0300-\u036f]/g;

const LEADING_ARTICLE = /^(the|a|an|le|la|les|el|los|das|der|die)\s+/i;

/** Fold accents and case so search and sorting behave predictably. */
export function fold(value: string): string {
  return value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim();
}

/** Sort key that ignores a leading article, the way music apps are expected to. */
export function sortKey(value: string): string {
  return fold(value).replace(LEADING_ARTICLE, '');
}

/** Locale-aware, numeric-aware comparator (so "Track 2" precedes "Track 10"). */
export const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: 'base',
});

/**
 * Separators that reliably mean "and now a different artist".
 *
 * Deliberately excludes `&`, `,` and the word "and". Those appear inside single
 * act names far too often — "Simon & Garfunkel", "Crosby, Stills & Nash",
 * "Florence and the Machine" — and splitting them invents artists like
 * "the Machine" that the user then has to look at forever. Semicolons and
 * slashes are the actual multi-value separators in ID3 and Vorbis, and
 * "feat."/"ft."/"featuring"/"with" are explicit featured-artist markers.
 *
 * Note `\bfeat\b\.?` rather than `\bfeat\.?\b`: the word boundary has to be
 * asserted *before* the optional full stop, or "feat." matches as "feat" and
 * leaves a stray "." on the next name.
 */
const ARTIST_SEPARATORS =
  /\s*(?:;|\/(?!\s*\d)|\bfeaturing\b|\bfeat\b\.?|\bft\b\.?|\bwith\b|\bvs\b\.?)\s*/gi;

/**
 * Split a credit string into individual artists.
 *
 * The original string is always kept as the display value; this split only
 * feeds the artist index, so an over-eager split over-links rather than losing
 * data — but see above for why it is kept narrow anyway.
 */
export function splitArtists(value: string): string[] {
  if (!value) return [];
  const parts = value
    .split(ARTIST_SEPARATORS)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parts.length > 0 ? dedupe(parts) : [value.trim()];
}

/** Split a genre tag, which is far more regular than artist credits. */
export function splitGenres(value: string): string[] {
  if (!value) return [];
  return dedupe(
    value
      // The NUL is intentional: ID3v2.4 separates repeated values with it.
      // eslint-disable-next-line no-control-regex
      .split(/[;/,|\u0000]/)
      .map((g) => g.trim())
      .filter((g) => g.length > 0 && g.toLowerCase() !== 'unknown'),
  );
}

export function dedupe<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Filename without its extension, tidied enough to use as a fallback title. */
export function titleFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, '');
  const tidied = base
    // Strip a leading track number: "04 - ", "04. ", "04_"
    .replace(/^\s*\d{1,3}\s*[-._)]\s*/, '')
    .replace(/[_]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  // A dotfile like ".flac" leaves nothing behind; the raw filename is a worse
  // title but an infinitely better one than an empty string.
  return tidied || base || filename;
}

export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function basename(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return slash === -1 ? path : path.slice(slash + 1);
}

export function dirname(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** `3:07`, or `1:02:33` once the track passes an hour. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '--:--';
  const total = Math.floor(ms / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => n.toString().padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Long form for aggregates: `4 hr 12 min`. */
export function formatDurationLong(ms: number): string {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const days = Math.floor(h / 24);
  if (days >= 1) return `${days} d ${h % 24} hr`;
  return m === 0 ? `${h} hr` : `${h} hr ${m} min`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** i;
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function formatCount(n: number): string {
  return n.toLocaleString();
}

/** `just now`, `3 min ago`, `Mar 14` — used by Recently Played / Added. */
export function formatRelative(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hr ago`;
  if (diff < 7 * 86_400_000) return `${Math.round(diff / 86_400_000)} d ago`;
  const date = new Date(timestamp);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** `FLAC · 1,411 kbps · 44.1 kHz · 16-bit` */
export function formatQuality(t: {
  format: string;
  bitrateKbps: number | null;
  sampleRate: number | null;
  bitDepth: number | null;
}): string {
  const parts: string[] = [t.format.toUpperCase()];
  if (t.bitrateKbps) parts.push(`${Math.round(t.bitrateKbps)} kbps`);
  if (t.sampleRate) parts.push(`${(t.sampleRate / 1000).toFixed(1).replace(/\.0$/, '')} kHz`);
  if (t.bitDepth) parts.push(`${t.bitDepth}-bit`);
  return parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Decibels to a linear gain multiplier. */
export function dbToGain(db: number): number {
  return 10 ** (db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(gain, 1e-6));
}

/**
 * Perceptual volume curve. A linear slider sounds wrong: most of the useful
 * range crowds into the bottom quarter. Cubic tracks loudness far better.
 */
export function sliderToGain(slider: number): number {
  return clamp(slider, 0, 1) ** 3;
}

export function gainToSlider(gain: number): number {
  return clamp(gain, 0, 1) ** (1 / 3);
}

// ---------------------------------------------------------------------------
// Arrays / async
// ---------------------------------------------------------------------------

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** In-place Fisher-Yates, optionally seeded so shuffles are reproducible. */
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** Deterministic PRNG (mulberry32) so a shuffled queue survives a reload. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Run `worker` over `items` with bounded concurrency.
 *
 * The scanner uses this to keep a handful of file reads in flight instead of
 * thousands, which is the difference between a smooth scan and an OOM (§35).
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Trailing-edge throttle.
 *
 * Progress reporting during a scan would otherwise post thousands of messages
 * per second and starve the UI thread it is trying to keep responsive.
 */
export function throttle<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { flush(): void } {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: A | null = null;

  const invoke = () => {
    if (!pending) return;
    last = Date.now();
    const args = pending;
    pending = null;
    fn(...args);
  };

  const throttled = (...args: A) => {
    pending = args;
    const elapsed = Date.now() - last;
    if (elapsed >= ms) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      invoke();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        invoke();
      }, ms - elapsed);
    }
  };

  throttled.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    invoke();
  };

  return throttled;
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}

/** Yield to the event loop so long synchronous loops cannot block paint. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
