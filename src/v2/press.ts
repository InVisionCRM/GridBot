/** Short vibration on press. Skipped when the user prefers reduced motion. */
export function press() {
  if (typeof navigator === 'undefined') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const nav = navigator as Navigator & { vibrate?: (ms: number) => boolean };
  nav.vibrate?.(8);
}
