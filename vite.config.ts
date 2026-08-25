import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

const alias = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icons/favicon.svg'],
      manifest: {
        id: '/',
        name: 'MusiX — Music Library & Audio Studio',
        short_name: 'MusiX',
        description:
          'Offline-first music library, player, metadata manager and audio studio. Your music stays on your device.',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        scope: '/',
        categories: ['music', 'entertainment', 'utilities'],
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // The app shell is precached so MusiX opens with zero network (spec §2).
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        // Audio is served from the user's own disk / OPFS, never from the SW cache.
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            // Optional online enrichment (artwork/metadata) is cache-first and
            // capped, so a lookup is never repeated for the same resource (spec §13).
            urlPattern: /^https:\/\/(coverartarchive\.org|musicbrainz\.org)\//,
            handler: 'CacheFirst',
            options: {
              cacheName: 'musix-online-metadata',
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 90 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@core': alias('./src/core'),
      '@state': alias('./src/state'),
      '@ui': alias('./src/ui'),
      '@features': alias('./src/features'),
      '@app': alias('./src/app'),
    },
  },
  optimizeDeps: {
    exclude: ['lucide-react'],
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          // Metadata parsers are only needed during a scan; keep them out of
          // the startup path so first paint stays fast (spec §35).
          metadata: ['./src/core/metadata/index.ts'],
        },
      },
    },
  },
  server: {
    proxy: {
      // The audio-studio backend is optional and strictly local (spec §18).
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false },
    },
  },
});
