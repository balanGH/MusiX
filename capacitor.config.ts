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

  backgroundColor: '#05051a',

  android: {
    // Release builds are minified anyway; this keeps the debug APK debuggable
    // from Chrome DevTools (chrome://inspect).
    webContentsDebuggingEnabled: true,
    // Settings > PC server talks to the MusiX backend on the user's computer
    // at a plain http://<LAN IP>:8000 address. From this https origin that is
    // mixed content, which the WebView blocks unless allowed here. The backend
    // requires a password in LAN mode (docs/ANDROID.md).
    allowMixedContent: true,
    backgroundColor: '#05051a',
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
    // Android 9+ refuses cleartext HTTP to LAN addresses without this; needed
    // for the PC server connection above.
    cleartext: true,
  },
};

export default config;
