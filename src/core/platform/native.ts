/**
 * Whether MusiX is running inside the Capacitor Android/iOS shell.
 *
 * Read from the global the native bridge injects rather than importing
 * `@capacitor/core`, so the web build pays nothing for it and this module stays
 * safe to import from anywhere, including tests.
 */

interface CapacitorGlobal {
  isNativePlatform?(): boolean;
  getPlatform?(): string;
}

function bridge(): CapacitorGlobal | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor;
}

export function isNativeApp(): boolean {
  return bridge()?.isNativePlatform?.() === true;
}

/** 'android' | 'ios' | 'web'. */
export function nativePlatform(): string {
  return bridge()?.getPlatform?.() ?? 'web';
}

// ---------------------------------------------------------------------------
// Calling native code without @capacitor/core
//
// The native bridge script Capacitor injects into the WebView already provides
// `nativePromise` and `convertFileSrc`; @capacitor/core's `registerPlugin` is
// only a typed proxy over them. Using the bridge directly keeps the web build
// free of any Capacitor dependency.
// ---------------------------------------------------------------------------

interface NativeBridge extends CapacitorGlobal {
  convertFileSrc?(filePath: string): string;
  nativePromise?(pluginName: string, methodName: string, options?: unknown): Promise<unknown>;
  /** Injected by the Android shell: one entry per registered native plugin. */
  PluginHeaders?: Array<{ name: string }>;
}

function nativeBridge(): NativeBridge | undefined {
  return bridge() as NativeBridge | undefined;
}

/** Whether a native plugin with this name is registered in the running app. */
export function hasNativePlugin(name: string): boolean {
  return nativeBridge()?.PluginHeaders?.some((header) => header.name === name) === true;
}

/**
 * Call one method of a native plugin.
 *
 * Rejects with the plugin's error (an Error-like object carrying `code`) when
 * the call fails, and with a plain Error outside the native app.
 */
export function callNative<T>(pluginName: string, methodName: string, options: object = {}): Promise<T> {
  const native = nativeBridge();
  if (!isNativeApp() || typeof native?.nativePromise !== 'function') {
    return Promise.reject(new Error(`${pluginName}.${methodName} is only available in the MusiX app.`));
  }
  return native.nativePromise(pluginName, methodName, options) as Promise<T>;
}

/**
 * URL the WebView can fetch for an absolute file path on the device.
 *
 * Capacitor's local server serves it under /_capacitor_file_/. The bridge only
 * prefixes the path, so each segment is percent-encoded here: a "#" or "?" in a
 * file name would otherwise end the path (the server decodes it again).
 */
export function nativeFileUrl(absolutePath: string): string | null {
  const convert = nativeBridge()?.convertFileSrc;
  if (typeof convert !== 'function') return null;
  const encoded = absolutePath.split('/').map(encodeURIComponent).join('/');
  return convert(encoded);
}
