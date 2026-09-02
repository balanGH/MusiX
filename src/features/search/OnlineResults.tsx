import { useState } from 'react';
import { Download, Loader2 } from 'lucide-react';

import {
  getOnlineDownloadFile,
  getOnlineDownloadStatus,
  startOnlineDownload,
  type OnlineSong,
} from './onlineDownloader';

import { useLibrary } from '@state/libraryStore';
import { Button } from '@ui/primitives';

interface Props {
  results: OnlineSong[];
}

export function OnlineResults({ results }: Props) {
  const importDownloadedFile = useLibrary((state) => state.importDownloadedFile);

  const [downloading, setDownloading] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);

  async function handleDownload(song: OnlineSong) {
    if (downloading) {
      return;
    }

    try {
      setDownloading(song.id);
      setProgress(0);

      const { jobId } = await startOnlineDownload(song.url);

      let status = await getOnlineDownloadStatus(jobId);
      while (status.status !== 'complete') {
        if (status.status === 'error') {
          throw new Error(status.error || 'Download failed.');
        }

        setProgress(status.progress ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = await getOnlineDownloadStatus(jobId);
      }

      setProgress(100);

      // Copy the finished MP3 into the library, exactly as a manually
      // imported file would be — so it shows up and plays right away.
      const file = await getOnlineDownloadFile(jobId);
      const displayName = status.artist ? `${status.artist} - ${status.title}` : status.title || song.title;
      const result = await importDownloadedFile(file, displayName || song.title);

      if (!result.added) {
        throw new Error(result.message || 'Could not add the download to your library.');
      }
    } catch (error) {
      console.error('Online download failed:', error);

      alert(error instanceof Error ? error.message : 'Download failed.');
    } finally {
      setDownloading(null);
      setProgress(0);
    }
  }

  if (results.length === 0) {
    return null;
  }

  return (
    <section className="mt-6">
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-text">Online results</h2>

        <p className="mt-1 text-2xs text-subtle">
          Found online because this song isn't in your MusiX library.
        </p>
      </div>

      <div className="space-y-2">
        {results.map((song) => {
          const isDownloading = downloading === song.id;

          return (
            <div
              key={song.id}
              className="flex items-center gap-3 rounded-xl border border-line bg-surface p-3"
            >
              {song.thumbnail ? (
                <img
                  src={song.thumbnail}
                  alt=""
                  className="h-14 w-14 shrink-0 rounded-lg object-cover"
                />
              ) : (
                <div className="h-14 w-14 shrink-0 rounded-lg bg-surface-hover" />
              )}

              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-text">
                  {song.title}
                </p>

                <p className="truncate text-2xs text-muted">
                  {song.artist || song.channel || 'Unknown artist'}
                </p>

                <p className="truncate text-2xs text-subtle">
                  {song.album ? (
                    <>
                      {song.album}
                      {song.year ? ` · ${song.year}` : ''}
                    </>
                  ) : (
                    // Says why this one will import as an untagged track,
                    // rather than letting it look the same as a tagged result.
                    <span className="text-warn">
                      No album or artist tags — imports with just a title
                    </span>
                  )}
                </p>
              </div>

              <Button
                size="sm"
                variant="secondary"
                disabled={downloading !== null}
                onClick={() => void handleDownload(song)}
              >
                {isDownloading ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {Math.round(progress)}%
                  </>
                ) : (
                  <>
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </>
                )}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
