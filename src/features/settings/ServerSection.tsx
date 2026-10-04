/**
 * PC server: where Studio and Download find the backend.
 *
 * On the desktop the field is normally left empty — the app reaches the
 * service on the same machine through the dev/preview proxy. In the Android
 * app there is no service on the phone, so Studio (Demucs) and Download
 * (yt-dlp) stay hidden until this points at the backend running on the user's
 * PC, on the same Wi-Fi.
 *
 * The address and password only take effect on Save, so a half-typed address
 * never triggers a probe; Save always tests the connection, so the user
 * learns straight away whether it worked.
 */

import { useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, Plug, Server } from 'lucide-react';
import { normalizeServerUrl } from '@core/net/apiBase';
import { isNativeApp } from '@core/platform/native';
import { refreshServerStatus, useServerStatus, type ProbeResult } from '@core/net/serverStatus';
import { useSettings } from '@state/settingsStore';
import { Button, Spinner, cx } from '@ui/primitives';

const START_COMMAND = `cd backend
$env:MUSIX_API_TOKEN = "choose-a-password"
$env:MUSIX_LAN = "1"
python main.py`;

export function ServerSection() {
  const serverUrl = useSettings((state) => state.serverUrl);
  const serverToken = useSettings((state) => state.serverToken);
  const patch = useSettings((state) => state.patch);
  const result = useServerStatus((state) => state.result);
  const checking = useServerStatus((state) => state.checking);
  const native = isNativeApp();

  const [urlDraft, setUrlDraft] = useState(serverUrl);
  const [tokenDraft, setTokenDraft] = useState(serverToken);
  // Only show a result the user asked for here, or one about the saved server
  // that the background probe produced — never a stale one from before.
  const [tested, setTested] = useState(false);

  const dirty = normalizeServerUrl(urlDraft) !== serverUrl || tokenDraft.trim() !== serverToken;

  const saveAndTest = async () => {
    // settingsStore hands the new values to the API base synchronously, so the
    // probe below already goes to the new address.
    patch({ serverUrl: normalizeServerUrl(urlDraft), serverToken: tokenDraft.trim() });
    setUrlDraft(normalizeServerUrl(urlDraft));
    setTokenDraft(tokenDraft.trim());
    setTested(true);
    await refreshServerStatus();
  };

  const forget = () => {
    patch({ serverUrl: '', serverToken: '' });
    setUrlDraft('');
    setTokenDraft('');
    setTested(native);
    void refreshServerStatus();
  };

  const shown = tested || native || serverUrl ? result : null;

  return (
    <section className="rounded-panel border border-line bg-surface px-4">
      <h2 className="flex items-center gap-2 border-b border-line py-3 text-sm font-semibold">
        <Server className="h-4 w-4 text-subtle" />
        PC server
      </h2>

      <div className="py-3">
        <p className="text-xs leading-relaxed text-muted">
          {native
            ? 'Audio Studio and Download run on your computer, not the phone. Start the MusiX backend on your PC, then enter its address here — Studio and Download appear once it connects.'
            : 'Audio Studio and Download use the MusiX backend. Leave the address empty to use the one on this computer, or enter another machine’s address.'}
        </p>

        <form
          className="mt-3 space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void saveAndTest();
          }}
        >
          <label className="block">
            <span className="text-2xs font-medium text-subtle">Server address</span>
            <input
              value={urlDraft}
              onChange={(event) => setUrlDraft(event.target.value)}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              placeholder={native ? 'http://192.168.1.5:8000' : 'Same computer (default)'}
              className={inputClass}
            />
          </label>

          <label className="block">
            <span className="text-2xs font-medium text-subtle">Password (MUSIX_API_TOKEN)</span>
            <input
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
              type="password"
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
              placeholder="Only if the server sets one"
              className={inputClass}
            />
          </label>

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button type="submit" variant="primary" loading={checking && tested}>
              <Plug className="h-4 w-4" />
              {dirty ? 'Save and test' : 'Test connection'}
            </Button>
            {(serverUrl || serverToken) && (
              <Button type="button" variant="ghost" onClick={forget} disabled={checking}>
                Disconnect
              </Button>
            )}
          </div>
        </form>

        {shown && <StatusLine result={shown} checking={checking} />}

        <details className="mt-3 text-2xs leading-relaxed text-muted">
          <summary className="cursor-pointer select-none font-medium text-subtle">
            How to connect your phone
          </summary>
          <ol className="mt-2 list-decimal space-y-1 pl-4">
            <li>
              On the PC, start the backend in LAN mode with a password (PowerShell, from the
              MusiX folder, with its Python environment active):
              <pre className="mx-scroll mt-1 overflow-x-auto rounded-lg border border-line bg-bg p-2 text-2xs text-text">
                <code>{START_COMMAND}</code>
              </pre>
            </li>
            <li>It prints the address to use, e.g. http://192.168.1.5:8000 (or run ipconfig).</li>
            <li>Phone and PC must be on the same Wi-Fi.</li>
            <li>
              Allow port 8000 through Windows Firewall for private networks — Windows asks the
              first time; otherwise add an inbound rule for TCP 8000.
            </li>
            <li>Enter the address and the same password above, then Test connection.</li>
          </ol>
        </details>
      </div>
    </section>
  );
}

const inputClass = cx(
  'mt-1 h-10 w-full min-w-0 rounded-xl border border-line bg-bg px-3 font-mono text-xs outline-none',
  'placeholder:font-sans placeholder:text-subtle focus-visible:border-accent',
);

const MESSAGES: Record<ProbeResult['state'], string> = {
  'not-configured': 'Not connected. Enter your PC’s address to use Studio and Download.',
  ok: 'Connected.',
  unreachable:
    'Could not reach the server. Check the address, that the backend is running in LAN mode, that both devices are on the same Wi-Fi, and that the firewall allows the port.',
  'not-musix': 'Something answered at that address, but it is not a MusiX server.',
  'wrong-token': 'Wrong password. It must match MUSIX_API_TOKEN on the server.',
  'needs-token': 'This server needs a password. Enter its MUSIX_API_TOKEN above.',
};

function StatusLine({ result, checking }: { result: ProbeResult; checking: boolean }) {
  const ok = result.state === 'ok';
  const neutral = result.state === 'not-configured';
  const Icon = ok ? CheckCircle2 : result.state.endsWith('token') ? KeyRound : AlertTriangle;
  return (
    <p
      role="status"
      className={cx(
        'mt-3 flex items-start gap-1.5 text-2xs leading-relaxed',
        ok ? 'text-ok' : neutral ? 'text-muted' : 'text-warn',
      )}
    >
      {checking ? (
        <Spinner size={12} className="mt-0.5 shrink-0" />
      ) : (
        <Icon className="mt-0.5 h-3 w-3 shrink-0" />
      )}
      <span>
        {MESSAGES[result.state]}
        {result.version && ` Server version ${result.version}.`}
        {result.message && ` (${result.message})`}
      </span>
    </p>
  );
}
