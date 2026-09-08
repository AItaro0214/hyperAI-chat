/* Edge-swipe for the room drawer, the way the ChatGPT app behaves: drag in
 * from the left edge to reveal it, drag left to put it away. The panel tracks
 * the finger and snaps on release. */
const EDGE = 28; // how close to the left edge an opening drag must start
const SLOP = 8; // movement before the gesture commits to an axis
const COMMIT = 0.4; // fraction of the panel that counts as "open me"
const FLICK = 0.45; // px/ms that commits regardless of distance

// Anything that scrolls sideways keeps its own gestures.
const SCROLLERS = '.toolbar, .filter-row, .scroll-x, .tabs, .model-list, pre, table, input, textarea, select';

export function initGestures({ sidebar, scrim, isEnabled }) {
  let startX = 0;
  let startY = 0;
  let startAt = 0;
  let width = 0;
  let openAtStart = false;
  let axis = null; // null = undecided, 'x' | 'y'
  let active = false;

  const setProgress = (p) => {
    sidebar.style.transform = 'translateX(' + (p - 1) * 100 + '%)';
    scrim.style.opacity = String(p);
  };

  const release = () => {
    sidebar.classList.remove('dragging');
    scrim.classList.remove('dragging');
    sidebar.style.transform = '';
    scrim.style.opacity = '';
    axis = null;
    active = false;
  };

  const settle = (open) => {
    sidebar.classList.toggle('open', open);
    scrim.hidden = !open;
    release();
  };

  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1 || !isEnabled()) return;
      const touch = e.touches[0];
      openAtStart = sidebar.classList.contains('open');
      // Opening starts at the edge; closing can start anywhere on the panel.
      if (!openAtStart && touch.clientX > EDGE) return;
      if (e.target.closest && e.target.closest(SCROLLERS)) return;
      width = sidebar.getBoundingClientRect().width || 300;
      startX = touch.clientX;
      startY = touch.clientY;
      startAt = performance.now();
      axis = null;
      active = true;
    },
    { passive: true }
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!active || e.touches.length !== 1) return;
      const touch = e.touches[0];
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (!axis) {
        if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axis === 'y') {
          active = false;
          return;
        }
        sidebar.classList.add('dragging');
        scrim.classList.add('dragging');
        scrim.hidden = false;
      }

      // Horizontal drag owns the gesture from here.
      if (e.cancelable) e.preventDefault();
      const raw = openAtStart ? 1 + dx / width : dx / width;
      setProgress(Math.max(0, Math.min(1, raw)));
    },
    { passive: false }
  );

  const finish = (e) => {
    if (!active) return;
    if (axis !== 'x') {
      active = false;
      return;
    }
    const touch = e.changedTouches?.[0];
    const dx = touch ? touch.clientX - startX : 0;
    const velocity = dx / Math.max(1, performance.now() - startAt);
    const progress = Math.max(0, Math.min(1, openAtStart ? 1 + dx / width : dx / width));
    const flicked = Math.abs(velocity) > FLICK;
    const open = flicked ? velocity > 0 : progress > COMMIT;
    settle(open);
  };

  document.addEventListener('touchend', finish, { passive: true });
  document.addEventListener('touchcancel', () => (active ? settle(openAtStart) : undefined), { passive: true });
}
