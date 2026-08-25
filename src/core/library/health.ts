/**
 * Library Health (spec §24).
 *
 * One cursor pass produces every metric on the page, including duplicate
 * grouping. Computed on demand only — a health page that recalculated itself in
 * the background would be precisely the speculative work spec §4 rules out, and
 * the numbers only change after a scan or an edit anyway.
 */

import { getTracks, scanAllTracks } from '../db/repositories/tracks';
import { fold } from '../utils';
import type { DuplicateGroup, LibraryHealth, Track } from '../types';

/**
 * Duplicate detection, in two stages.
 *
 * Stage one groups by title and artist alone. Stage two clusters each group by
 * duration, because duration is what separates a genuine duplicate from a
 * legitimate re-recording — a live version and the studio version share a title
 * and artist but never a length.
 *
 * Clustering rather than bucketing matters: rounding a duration into a fixed
 * bucket puts 180.0 s and 181.0 s on opposite sides of a boundary and misses
 * the pair, which is precisely the FLAC-and-its-MP3 case users most want found.
 */
const DURATION_TOLERANCE_MS = 2500;

function nameKey(track: Track): string | null {
  if (!track.title) return null;
  return `${fold(track.title)}|${fold(track.artist)}`;
}

export interface HealthDetail {
  health: LibraryHealth;
  /** Ids behind each count, so the UI can offer "show these" (spec §24). */
  missingMetadataIds: string[];
  missingArtworkIds: string[];
  missingLyricsIds: string[];
  unreadableIds: string[];
}

/** How many ids are kept per category, to bound memory on a large library. */
const ID_SAMPLE_LIMIT = 2000;

export async function computeLibraryHealth(): Promise<HealthDetail> {
  let trackCount = 0;
  let withMetadata = 0;
  let withArtwork = 0;
  let withLyrics = 0;
  let unreadable = 0;
  let totalBytes = 0;
  let totalDurationMs = 0;

  const missingMetadataIds: string[] = [];
  const missingArtworkIds: string[] = [];
  const missingLyricsIds: string[] = [];
  const unreadableIds: string[] = [];

  /** title|artist -> the candidates sharing it, with their durations */
  const byName = new Map<
    string,
    { title: string; artist: string; entries: { id: string; durationMs: number }[] }
  >();

  await scanAllTracks((track) => {
    trackCount++;
    totalBytes += track.sizeBytes;
    totalDurationMs += track.durationMs;

    if (track.tagState === 'complete') {
      withMetadata++;
    } else if (missingMetadataIds.length < ID_SAMPLE_LIMIT) {
      missingMetadataIds.push(track.id);
    }

    if (track.artworkId) withArtwork++;
    else if (missingArtworkIds.length < ID_SAMPLE_LIMIT) missingArtworkIds.push(track.id);

    if (track.hasLyrics) withLyrics++;
    else if (missingLyricsIds.length < ID_SAMPLE_LIMIT) missingLyricsIds.push(track.id);

    // A zero duration means no parser could make sense of the stream. The file
    // may still play — the browser's decoder is more forgiving than a tag
    // reader — so this is reported as "unreadable metadata", not "corrupt".
    if (track.durationMs === 0) {
      unreadable++;
      if (unreadableIds.length < ID_SAMPLE_LIMIT) unreadableIds.push(track.id);
    }

    const key = nameKey(track);
    // A zero duration means nothing to cluster on, so it is left out rather
    // than lumped in with everything else that failed to parse.
    if (key && track.durationMs > 0) {
      const entry = { id: track.id, durationMs: track.durationMs };
      const group = byName.get(key);
      if (group) group.entries.push(entry);
      else byName.set(key, { title: track.title, artist: track.artist, entries: [entry] });
    }

    return 'continue';
  });

  const duplicateGroups: DuplicateGroup[] = [];
  for (const [key, group] of byName) {
    if (group.entries.length < 2) continue;

    // Sort by duration, then walk: consecutive entries within the tolerance
    // belong to the same recording.
    group.entries.sort((a, b) => a.durationMs - b.durationMs);
    let cluster: typeof group.entries = [];
    let clusterIndex = 0;

    const flush = () => {
      if (cluster.length >= 2) {
        duplicateGroups.push({
          key: `${key}|${clusterIndex++}`,
          title: group.title,
          artist: group.artist,
          trackIds: cluster.map((entry) => entry.id),
        });
      }
      cluster = [];
    };

    for (const entry of group.entries) {
      const previous = cluster[cluster.length - 1];
      if (previous && entry.durationMs - previous.durationMs > DURATION_TOLERANCE_MS) flush();
      cluster.push(entry);
    }
    flush();
  }
  duplicateGroups.sort((a, b) => b.trackIds.length - a.trackIds.length);

  return {
    health: {
      trackCount,
      withMetadata,
      withArtwork,
      withLyrics,
      missingMetadata: trackCount - withMetadata,
      missingArtwork: trackCount - withArtwork,
      missingLyrics: trackCount - withLyrics,
      unreadable,
      duplicateGroups,
      totalBytes,
      totalDurationMs,
      computedAt: Date.now(),
    },
    missingMetadataIds,
    missingArtworkIds,
    missingLyricsIds,
    unreadableIds,
  };
}

export function healthPercent(part: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((part / total) * 100);
}

/**
 * Which copy in a duplicate group to keep.
 *
 * Lossless first, then higher bitrate, then longer duration, then larger file.
 * Presented as a *suggestion* — the health page shows all copies and the user
 * chooses, because MusiX never deletes a file the user did not point at
 * (spec §11: every destructive operation is previewed and confirmed).
 */
export async function suggestDuplicateResolution(
  group: DuplicateGroup,
): Promise<{ keep: Track; others: Track[] } | null> {
  const tracks = await getTracks(group.trackIds);
  if (tracks.length < 2) return null;

  const ranked = [...tracks].sort(
    (a, b) =>
      Number(b.lossless) - Number(a.lossless) ||
      (b.bitrateKbps ?? 0) - (a.bitrateKbps ?? 0) ||
      b.durationMs - a.durationMs ||
      b.sizeBytes - a.sizeBytes,
  );

  return { keep: ranked[0]!, others: ranked.slice(1) };
}
