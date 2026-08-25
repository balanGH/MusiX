import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor configuration — Android.
 *
 * MusiX ships as a WebView app rather than a rewrite: `src/core/` is pure
 * TypeScript with no DOM assumptions, so the database, scanner, tag parsers,
 * queue, search and every screen run unchanged inside the shell. Only the
 * filesystem provider and, later, the playback backend need native code.
 */
const config: CapacitorConfig = {
  appId: 'com.musix.app',
  appName: 'MusiX',
  webDir: 'dist',

  android: {
    // Release builds are minified anyway; this keeps the debug APK debuggable
    // from Chrome DevTools (chrome://inspect).
    webContentsDebuggingEnabled: true,
    // The app never loads remote content, so cleartext stays off. If you want
    // the APK to reach the audio-studio service on your desktop over the LAN,
    // see docs/ANDROID.md — it is off by default on purpose.
    allowMixedContent: false,
  },

  server: {
    /**
     * `https` rather than the default `http`.
     *
     * This matters more than it looks: a secure origin is what makes the
     * origin-private file system, persistent storage and crypto available
     * inside the WebView. On an `http://localhost` scheme MusiX could not
     * store imported audio at all.
     */
    androidScheme: 'https',
  },
};

export default config;
