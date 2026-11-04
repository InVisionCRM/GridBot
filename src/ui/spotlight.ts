/**
 * Spotlight cards: a soft mint light follows the pointer across the headline cards (Home's hero, a bot page's top
 * figures, the token trader's hero) and their border. One listener for the whole app sets the pointer's place on the
 * card under it (--spot-x / --spot-y); styles.css draws the light. A mouse only: touch and pens leave it off.
 */
export const SPOT_CARDS = '.dk-hero, .kpi-row > .kpi, .lpb-hero > .lpb-card, .tk-hero';

export function installSpotlight(): void {
  document.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const el = (e.target as Element | null)?.closest?.(SPOT_CARDS) as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--spot-x', `${e.clientX - r.left}px`);
    el.style.setProperty('--spot-y', `${e.clientY - r.top}px`);
  }, { passive: true });
}
