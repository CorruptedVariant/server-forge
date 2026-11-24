// Visual effects are created and their stylesheet loaded only after an explicit opt-in.
const KEY = 'th-appearance';
const MOTION = 'th-appearance-motion';
let style = 'classic';
let motion = true;
try {
  style = localStorage.getItem(KEY) === 'neon' ? 'neon' : 'classic';
  motion = localStorage.getItem(MOTION) !== 'off';
} catch {}
const button = document.getElementById('panelAppearance');
const buttonLabel = document.getElementById('panelAppearanceLabel');
const toggle = document.getElementById('panelMotion');
const status = document.getElementById('appearanceStatus');
function apply(save = false) {
  const enabled = style === 'neon';
  if (enabled && !document.getElementById('neonStyles')) {
    const link = document.createElement('link');
    link.id = 'neonStyles';
    link.rel = 'stylesheet';
    link.href = '/neon.css';
    document.head.append(link);
    const fx = document.createElement('div');
    fx.id = 'neonBackdrop';
    fx.setAttribute('aria-hidden', 'true');
    fx.innerHTML = '<i class="neon-stars"></i>';
    document.body.prepend(fx);
  }
  document.documentElement.classList.toggle('neon', enabled);
  document.documentElement.classList.toggle('neon-still', !motion);
  if (!enabled) {
    document.getElementById('neonStyles')?.remove();
    document.getElementById('neonBackdrop')?.remove();
  }
  button.setAttribute('aria-pressed', String(enabled));
  button.setAttribute('aria-label', enabled ? 'Neon UI is on. Switch to Classic UI' : 'Classic UI is on. Switch to Neon UI');
  button.title = enabled ? 'Switch to Classic UI (fewer visual effects)' : 'Switch to Neon UI (more visual effects)';
  buttonLabel.textContent = enabled ? 'Neon UI' : 'Classic UI';
  toggle.checked = motion;
  toggle.disabled = !enabled;
  status.textContent = enabled ? 'Neon UI is on for this device.' : 'Classic UI uses fewer resources.';
  if (save) {
    try {
      localStorage.setItem(KEY, style);
      localStorage.setItem(MOTION, motion ? 'on' : 'off');
    } catch {
      status.textContent += ' This browser cannot save the preference.';
    }
  }
}
button.addEventListener('click', () => { style = style === 'neon' ? 'classic' : 'neon'; apply(true); });
toggle.addEventListener('change', () => { motion = toggle.checked; apply(true); });
document.addEventListener('visibilitychange', () => {
  document.documentElement.classList.toggle('neon-paused', document.hidden);
});
window.addEventListener('storage', (event) => {
  if (event.key !== KEY && event.key !== MOTION && event.key !== null) return;
  try {
    style = localStorage.getItem(KEY) === 'neon' ? 'neon' : 'classic';
    motion = localStorage.getItem(MOTION) !== 'off';
  } catch {}
  apply();
});
apply();
