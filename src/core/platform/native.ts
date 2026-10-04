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
