/**
 * Shared page furniture: the scrolling header used by list and detail pages,
 * plus the standard play/shuffle action row.
 *
 * Extracted because nine pages need the same title / stats / actions block, and
 * nine slightly different versions of it is how an app starts to feel
 * inconsistent.
 */

import type { ReactNode } from 'react';
import { ListPlus, Play, Shuffle } from 'lucide-react';
import { formatCount, formatDurationLong } from '@core/utils';
import { Button, cx } from './primitives';

export interface PageHeaderProps {
  /** Small label above the title, e.g. "Album" or "Artist". */
  eyebrow?: string;
  title: string;
  subtitle?: ReactNode;
  /** Stat line under the subtitle, e.g. "12 tracks · 48 min". */
  stats?: ReactNode;
  artwork?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  eyebrow,
  title,
  subtitle,
  stats,
  artwork,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={cx('flex flex-col gap-5 px-4 pb-5 pt-4 sm:flex-row sm:items-end sm:px-6', className)}>
      {artwork}
      <div className="min-w-0 flex-1">
        {eyebrow && (
          <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">{eyebrow}</p>
        )}
        <h1 className="mt-1 truncate text-2xl font-semibold tracking-tight text-text sm:text-3xl">
          {title}
        </h1>
        {subtitle && <div className="mt-1 text-sm text-muted">{subtitle}</div>}
        {stats && <div className="mt-1.5 text-xs text-subtle">{stats}</div>}
        {actions && <div className="mt-4 flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}

export interface PlayActionsProps {
  count: number;
  onPlay(): void;
  onShuffle(): void;
  onAddToQueue?(): void;
  extra?: ReactNode;
  disabled?: boolean;
}

export function PlayActions({
  count,
  onPlay,
  onShuffle,
  onAddToQueue,
  extra,
  disabled,
}: PlayActionsProps) {
  const empty = disabled || count === 0;
  return (
    <>
      <Button variant="primary" onClick={onPlay} disabled={empty}>
        <Play className="h-4 w-4 fill-current" />
        Play
      </Button>
      <Button variant="secondary" onClick={onShuffle} disabled={empty}>
        <Shuffle className="h-4 w-4" />
        Shuffle
      </Button>
      {onAddToQueue && (
        <Button variant="ghost" onClick={onAddToQueue} disabled={empty}>
          <ListPlus className="h-4 w-4" />
          Add to queue
        </Button>
      )}
      {extra}
    </>
  );
}

/** `12 tracks · 48 min` — the stat line every collection page shows. */
export function trackStats(count: number, durationMs: number): string {
  const tracks = `${formatCount(count)} track${count === 1 ? '' : 's'}`;
  return durationMs > 0 ? `${tracks} · ${formatDurationLong(durationMs)}` : tracks;
}

/** Full-width page container with consistent padding. */
export function PageBody({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx('mx-scroll flex-1 px-4 pb-8 sm:px-6', className)}>{children}</div>;
}
