// Resizable server list: drag the line between it and the server page (or focus it and use the arrow keys);
// double-click puts it back. The width is saved per browser / desktop app, like the colour and Classic/Neon choice.
const KEY = 'sf-sidebar-width';
const DEFAULT = 260;
const MIN = 200;
const layout = document.querySelector('.layout');
const handle = document.getElementById('sidebarResize');
// Never so wide that the server page gets squeezed out. (Before sign-in the layout is hidden and has no width yet.)
const max = () => (layout.clientWidth ? Math.max(MIN, Math.min(560, Math.round(layout.clientWidth * 0.5))) : 560);
const clamp = (w) => Math.round(Math.min(max(), Math.max(MIN, w)));
let width = DEFAULT;
try {
  const saved = Number(localStorage.getItem(KEY));
  if (saved) width = saved;
} catch {}

function apply(w, save = false) {
  width = clamp(w);
  layout.style.setProperty('--sidebar-w', `${width}px`);
  handle.setAttribute('aria-valuenow', String(width));
  handle.setAttribute('aria-valuemin', String(MIN));
  handle.setAttribute('aria-valuemax', String(max()));
  if (save) {
    try {
      if (width === DEFAULT) localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, String(width));
    } catch {}
  }
}

handle.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  handle.setPointerCapture(e.pointerId);
  const startX = e.clientX;
  const startW = width;
  handle.classList.add('dragging');
  document.body.classList.add('resizing-split');
  const move = (ev) => apply(startW + ev.clientX - startX);
  const end = () => {
    handle.classList.remove('dragging');
    document.body.classList.remove('resizing-split');
    handle.removeEventListener('pointermove', move);
    apply(width, true);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', end, { once: true });
  handle.addEventListener('pointercancel', end, { once: true });
});
handle.addEventListener('dblclick', () => apply(DEFAULT, true));
handle.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 40 : 10;
  if (e.key === 'ArrowLeft') apply(width - step, true);
  else if (e.key === 'ArrowRight') apply(width + step, true);
  else if (e.key === 'Home') apply(MIN, true);
  else if (e.key === 'End') apply(max(), true);
  else return;
  e.preventDefault();
});
// A smaller window can't keep a list wider than half of it.
window.addEventListener('resize', () => apply(width));
apply(width);
