/**
 * Where online downloads are saved.
 *
 * The folder belongs to the *service*, not the browser, so this is a path field
 * rather than a folder picker: a web page cannot show a native directory dialog
 * for a directory on the server's filesystem, even when the server is the same
 * machine. The service creates and write-tests whatever is entered before
 * accepting it, so a bad path is rejected here with a reason instead of
 * breaking every later download.
 *
 * The whole section hides itself when the studio service is not running, since
 * there is nothing it could usefully do (spec §41).
 */

import { useEffect, useState } from 'react';
import { Check, FolderDown, RotateCcw } from 'lucide-react';
import {
  getDownloadPath,
  setDownloadPath,
  type DownloadPath,
} from '@features/search/onlineDownloader';
import { useUi } from '@state/uiStore';
import { Button, Spinner, cx } from '@ui/primitives';

export function DownloadFolderSection() {
  const toast = useUi((state) => state.toast);

  const [current, setCurrent] = useState<DownloadPath | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void getDownloadPath()
      .then((found) => {
        if (cancelled) return;
        setCurrent(found);
        setDraft(found.path);
      })
      .catch(() => {
        // The service is not running. Nothing to configure.
        if (!cancelled) setCurrent(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (path: string) => {
    setSaving(true);
    setError(null);
    try {
      const updated = await setDownloadPath(path);
      setCurrent({ ...updated, default: current?.default, fixed: current?.fixed });
      setDraft(updated.path);
      toast('Downloads will be saved here from now on.', { kind: 'success' });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };

  // Nothing to show while probing, or when the service is absent.
  if (loading) {
    return (
      <section className="rounded-panel border border-line bg-surface px-4">
        <h2 className="flex items-center gap-2 py-3 text-sm font-semibold">
          <FolderDown className="h-4 w-4 text-subtle" />
          Download folder
          <Spinner size={12} className="ml-1 text-subtle" />
        </h2>
      </section>
    );
  }

  if (!current) return null;

  const unchanged = draft.trim() === current.path;

  return (
    <section className="rounded-panel border border-line bg-surface px-4">
      <h2 className="flex items-center gap-2 border-b border-line py-3 text-sm font-semibold">
        <FolderDown className="h-4 w-4 text-subtle" />
        Download folder
      </h2>

      <div className="py-3">
        <p className="text-xs leading-relaxed text-muted">
          Songs downloaded from search are saved here, then copied into your library. Enter a full
          path on this computer — the folder is created if it does not exist.
        </p>

        {current.fixed ? (
          <p className="mt-3 rounded-lg border border-line bg-bg px-3 py-2 font-mono text-2xs text-muted">
            {current.path}
            <span className="mt-1 block font-sans text-2xs text-subtle">
              Fixed by the MUSIX_DOWNLOAD_DIR environment variable, so it cannot be changed here.
            </span>
          </p>
        ) : (
          <>
            <form
              className="mt-3 flex flex-col gap-2 sm:flex-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (!unchanged && draft.trim()) void save(draft.trim());
              }}
            >
              <input
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  setError(null);
                }}
                spellCheck={false}
                aria-label="Download folder path"
                aria-invalid={error !== null}
                placeholder="C:\Users\You\Music\MusiX"
                className={cx(
                  'h-10 min-w-0 flex-1 rounded-xl border bg-bg px-3 font-mono text-xs outline-none',
                  'placeholder:text-subtle',
                  error ? 'border-danger' : 'border-line focus-visible:border-accent',
                )}
              />
              <Button
                type="submit"
                variant="primary"
                disabled={unchanged || !draft.trim() || saving}
                loading={saving}
              >
                <Check className="h-4 w-4" />
                Save
              </Button>
            </form>

            {error && <p className="mt-2 text-2xs leading-relaxed text-danger">{error}</p>}

            <div className="mt-2 flex items-center gap-3">
              {current.isDefault ? (
                <span className="text-2xs text-subtle">Using the default folder.</span>
              ) : (
                current.default && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={saving}
                    onClick={() => void save(current.default!)}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reset to default
                  </Button>
                )
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
