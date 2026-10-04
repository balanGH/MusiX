/**
 * Touch-first input detection.
 *
 * "Touch" here means the primary input cannot hover — a phone or tablet. A
 * laptop with a touchscreen still reports `hover: hover` for its trackpad and
 * keeps the desktop behaviour (double-click to play, hover-revealed actions).
 *
 * Must match the `touch:` Tailwind variant in tailwind.config.js.
 */

export const TOUCH_QUERY = '(hover: none)';

/** Read at event time rather than cached, so docking a tablet to a keyboard/trackpad is respected. */
export function isTouchPrimary(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(TOUCH_QUERY).matches
    : false;
}

/**
 * True when a click landed on (or inside) its own interactive control, so a
 * row-level "tap to play" handler must leave it alone.
 */
export function isInteractiveTarget(target: EventTarget | null, container: Element): boolean {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest('button, a, input, select, textarea, [role="menu"], [role="menuitem"]');
  return interactive !== null && interactive !== container && container.contains(interactive);
}
