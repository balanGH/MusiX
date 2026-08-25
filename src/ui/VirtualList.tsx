/**
 * Windowed list and grid.
 *
 * Written rather than imported because the requirement is narrow and the
 * implementation is short: fixed row height, one scroll container, absolute
 * positioning. A 100,000-row list therefore mounts ~30 DOM nodes and stays at
 * ~30 no matter how far it is scrolled (spec §35).
 *
 * Fixed row height is what keeps this simple and correct — variable heights need
 * measurement, a position cache and scroll anchoring. MusiX has no
 * variable-height lists, so it pays none of that.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { cx } from './primitives';

/** Rows rendered beyond the viewport, so fast scrolling does not show gaps. */
const DEFAULT_OVERSCAN = 6;

interface Viewport {
  scrollTop: number;
  height: number;
}

/**
 * Track a container's scroll offset and height.
 *
 * The scroll handler is passive and does no work beyond a `setState`; React
 * batches those, so a flick-scroll produces a handful of renders rather than
 * one per scroll event.
 */
function useViewport(ref: React.RefObject<HTMLElement>): Viewport {
  const [viewport, setViewport] = useState<Viewport>({ scrollTop: 0, height: 0 });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const read = () =>
      setViewport((current) =>
        current.scrollTop === element.scrollTop && current.height === element.clientHeight
          ? current
          : { scrollTop: element.scrollTop, height: element.clientHeight },
      );

    read();
    element.addEventListener('scroll', read, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(element);

    return () => {
      element.removeEventListener('scroll', read);
      observer.disconnect();
    };
  }, [ref]);

  return viewport;
}

export interface VirtualListProps {
  count: number;
  rowHeight: number;
  renderRow(index: number): ReactNode;
  /** Rendered above the rows and scrolled with them. */
  header?: ReactNode;
  footer?: ReactNode;
  /** Told which rows are on screen, so the caller can fetch just those records. */
  onRangeChange?(start: number, end: number): void;
  className?: string;
  overscan?: number;
  /** Extra bottom padding so the last row clears the player bar. */
  paddingBottom?: number;
  emptyState?: ReactNode;
  ariaLabel?: string;
}

export function VirtualList({
  count,
  rowHeight,
  renderRow,
  header,
  footer,
  onRangeChange,
  className,
  overscan = DEFAULT_OVERSCAN,
  paddingBottom = 0,
  emptyState,
  ariaLabel,
}: VirtualListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const { scrollTop, height } = useViewport(scrollRef);

  // The header scrolls with the list, so its height shifts every row position.
  useLayoutEffect(() => {
    const element = headerRef.current;
    if (!element) {
      setHeaderHeight(0);
      return;
    }
    const observer = new ResizeObserver(() => setHeaderHeight(element.offsetHeight));
    observer.observe(element);
    setHeaderHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, [header]);

  const range = useMemo(() => {
    if (count === 0 || height === 0) return { start: 0, end: 0 };
    const offset = Math.max(0, scrollTop - headerHeight);
    const start = Math.max(0, Math.floor(offset / rowHeight) - overscan);
    const visible = Math.ceil(height / rowHeight);
    const end = Math.min(count, start + visible + overscan * 2);
    return { start, end };
  }, [count, height, scrollTop, headerHeight, rowHeight, overscan]);

  // Report the window so the caller can fetch exactly the records on screen.
  useEffect(() => {
    onRangeChange?.(range.start, range.end);
  }, [range.start, range.end, onRangeChange]);

  const rows: ReactNode[] = [];
  for (let index = range.start; index < range.end; index++) {
    rows.push(
      <div
        key={index}
        role="row"
        aria-rowindex={index + 1}
        style={{
          position: 'absolute',
          top: index * rowHeight,
          left: 0,
          right: 0,
          height: rowHeight,
        }}
      >
        {renderRow(index)}
      </div>,
    );
  }

  return (
    <div ref={scrollRef} className={cx('mx-scroll relative flex-1', className)}>
      {header && <div ref={headerRef}>{header}</div>}
      {count === 0 ? (
        emptyState
      ) : (
        <div
          role="grid"
          aria-label={ariaLabel}
          aria-rowcount={count}
          style={{ position: 'relative', height: count * rowHeight }}
        >
          {rows}
        </div>
      )}
      {footer}
      {paddingBottom > 0 && <div style={{ height: paddingBottom }} aria-hidden="true" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

export interface VirtualGridProps {
  count: number;
  /** Minimum tile width; the column count is derived from the container. */
  minTileWidth: number;
  /** Tile height including its caption. */
  rowHeight: number;
  gap?: number;
  renderTile(index: number): ReactNode;
  header?: ReactNode;
  onRangeChange?(start: number, end: number): void;
  className?: string;
  paddingBottom?: number;
  emptyState?: ReactNode;
  ariaLabel?: string;
}

/**
 * Windowed grid for albums and artists.
 *
 * Column count comes from the measured container width rather than a media
 * query, so the same component works in the main pane and in a narrow panel.
 */
export function VirtualGrid({
  count,
  minTileWidth,
  rowHeight,
  gap = 16,
  renderTile,
  header,
  onRangeChange,
  className,
  paddingBottom = 0,
  emptyState,
  ariaLabel,
}: VirtualGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [width, setWidth] = useState(0);
  const { scrollTop, height } = useViewport(scrollRef);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    setWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const element = headerRef.current;
    if (!element) {
      setHeaderHeight(0);
      return;
    }
    const observer = new ResizeObserver(() => setHeaderHeight(element.offsetHeight));
    observer.observe(element);
    setHeaderHeight(element.offsetHeight);
    return () => observer.disconnect();
  }, [header]);

  const columns = Math.max(1, Math.floor((width + gap) / (minTileWidth + gap)));
  const rowCount = Math.ceil(count / columns);
  const stride = rowHeight + gap;

  const range = useMemo(() => {
    if (count === 0 || height === 0) return { startRow: 0, endRow: 0 };
    const offset = Math.max(0, scrollTop - headerHeight);
    const startRow = Math.max(0, Math.floor(offset / stride) - 1);
    const endRow = Math.min(rowCount, startRow + Math.ceil(height / stride) + 2);
    return { startRow, endRow };
  }, [count, height, scrollTop, headerHeight, stride, rowCount]);

  const firstIndex = range.startRow * columns;
  const lastIndex = Math.min(count, range.endRow * columns);

  useEffect(() => {
    onRangeChange?.(firstIndex, lastIndex);
  }, [firstIndex, lastIndex, onRangeChange]);

  const tiles: ReactNode[] = [];
  for (let row = range.startRow; row < range.endRow; row++) {
    for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      if (index >= count) break;
      const tileWidth = (width - gap * (columns - 1)) / columns;
      tiles.push(
        <div
          key={index}
          style={{
            position: 'absolute',
            top: row * stride,
            left: column * (tileWidth + gap),
            width: tileWidth,
            height: rowHeight,
          }}
        >
          {renderTile(index)}
        </div>,
      );
    }
  }

  return (
    <div ref={scrollRef} className={cx('mx-scroll relative flex-1', className)}>
      {header && <div ref={headerRef}>{header}</div>}
      {count === 0 ? (
        emptyState
      ) : (
        <div
          aria-label={ariaLabel}
          style={{ position: 'relative', height: Math.max(0, rowCount * stride - gap) }}
        >
          {tiles}
        </div>
      )}
      {paddingBottom > 0 && <div style={{ height: paddingBottom }} aria-hidden="true" />}
    </div>
  );
}

/**
 * Fetch records for the visible window.
 *
 * The pattern every list page uses: hold the ordered ids (cheap — one string
 * each), fetch only the records currently on screen, and keep them in a map
 * that is pruned when it grows too large.
 */
export function useWindowedRecords<T>(
  ids: readonly string[],
  fetch: (ids: string[]) => Promise<T[]>,
  identify: (record: T) => string,
  cacheLimit = 900,
): {
  records: Map<string, T>;
  onRangeChange: (start: number, end: number) => void;
  /** Re-fetch specific records after a mutation (a favourite toggle, a rating). */
  refresh: (targets: readonly string[]) => Promise<void>;
} {
  const [records, setRecords] = useState<Map<string, T>>(new Map());
  const requested = useRef(new Set<string>());

  // A new id list (different sort, different page) invalidates everything.
  useEffect(() => {
    requested.current = new Set();
    setRecords(new Map());
  }, [ids]);

  const onRangeChange = useCallback(
    (start: number, end: number) => {
      const wanted = ids.slice(start, end).filter((id) => !requested.current.has(id));
      if (wanted.length === 0) return;
      for (const id of wanted) requested.current.add(id);

      void fetch(wanted).then((fetched) => {
        setRecords((current) => {
          const next = new Map(current);
          for (const record of fetched) next.set(identify(record), record);
          // Prune oldest insertions once the cache is oversized. Map preserves
          // insertion order, so the head is the coldest.
          if (next.size > cacheLimit) {
            const excess = next.size - cacheLimit;
            let removed = 0;
            for (const key of next.keys()) {
              if (removed++ >= excess) break;
              next.delete(key);
              requested.current.delete(key);
            }
          }
          return next;
        });
      });
    },
    [ids, fetch, identify, cacheLimit],
  );

  /**
   * Force a re-read of specific records.
   *
   * Needed because `onRangeChange` deliberately never re-requests an id it has
   * already fetched — without this, a favourite toggle would update the database
   * and leave the row on screen stale.
   */
  const refresh = useCallback(
    async (targets: readonly string[]) => {
      if (targets.length === 0) return;
      const fetched = await fetch([...targets]);
      setRecords((current) => {
        const next = new Map(current);
        for (const record of fetched) next.set(identify(record), record);
        return next;
      });
    },
    [fetch, identify],
  );

  return { records, onRangeChange, refresh };
}
