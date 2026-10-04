/**
 * Entry point.
 *
 * Three responsibilities, in order: mount React, register the service worker
 * that makes the app shell available offline (spec §2), and make sure a failure
 * in either is visible rather than silent (spec §34).
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import { App } from '@app/App';
import { createLogger, describeError } from '@core/logger';
import { toast } from '@state/uiStore';
import './index.css';

const log = createLogger('main');

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * Service worker.
 *
 * `registerType: 'prompt'` in vite.config.ts means an update never reloads the
 * page from under the user — which would cut off whatever is playing. Instead
 * the toast offers the reload and they choose when.
 */
const updateServiceWorker = registerSW({
  onNeedRefresh() {
    toast('A new version of MusiX is ready.', {
      kind: 'info',
      durationMs: 0,
      action: {
        label: 'Reload',
        run: () => void updateServiceWorker(true),
      },
    });
  },
  onOfflineReady() {
    log.info('app shell cached; MusiX will open without a network');
  },
  onRegisterError(error) {
    // Not fatal: without a service worker the app still runs, it just will not
    // open while offline.
    log.warn(`service worker registration failed: ${describeError(error)}`);
  },
});
