// The downloads panel in the corner of a mod browser window, plus the list behind it. It's the app's own small page laid
// over the website (a separate view, so the site can't see or touch it), because that window is where people are looking
// while a mod downloads. companion/download-monitor.js is the same file: keep them matched.
import { WebContentsView } from 'electron';

const PAGE = `<!doctype html><meta charset="utf-8"><style>
html,body{margin:0;background:#12161d;color:#e6e9ef;font:13px system-ui,"Segoe UI",sans-serif;overflow:hidden}
h1{margin:0;padding:8px 12px 2px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:#8b95a7;font-weight:600}
.row{padding:7px 12px 9px}
.top{display:flex;gap:8px;align-items:baseline}
.name{flex:1;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
a{color:#8b95a7;cursor:pointer;text-decoration:underline;font-size:12px}
.bar{height:6px;margin:6px 0 4px;border-radius:3px;background:#2a303b;overflow:hidden}
.bar i{display:block;height:100%;background:#3b82f6}
.bar.busy i{width:35%;animation:slide 1.4s ease-in-out infinite alternate}
@keyframes slide{from{margin-left:0}to{margin-left:65%}}
.note{color:#a3acbb;font-size:12px}.failed .note{color:#fca5a5}.done .note{color:#4ade80}
</style><h1>Mod downloads</h1><div id="list"></div><script>
const mb = (n) => (n / 1048576).toFixed(n < 104857600 ? 1 : 0);
window.show = (items) => {
  const list = document.getElementById('list');
  list.textContent = '';
  for (const d of items) {
    const row = document.createElement('div');
    row.className = 'row ' + d.state;
    const top = document.createElement('div');
    top.className = 'top';
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = d.name;
    name.title = d.name;
    top.append(name);
    if (d.canCancel || d.state === 'failed') {
      const a = document.createElement('a');
      a.textContent = d.state === 'failed' ? 'Dismiss' : 'Cancel';
      a.onclick = () => window.open('sf-' + (d.state === 'failed' ? 'dismiss' : 'cancel') + ':' + d.id);
      top.append(a);
    }
    row.append(top);
    if (d.state === 'downloading' || d.state === 'installing') {
      const bar = document.createElement('div');
      const known = d.state === 'downloading' && d.total > 0;
      bar.className = 'bar' + (known ? '' : ' busy');
      const fill = document.createElement('i');
      if (known) fill.style.width = Math.min(100, (d.received / d.total) * 100) + '%';
      bar.append(fill);
      row.append(bar);
    }
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent =
      d.state === 'downloading' ? (d.total ? Math.floor((d.received / d.total) * 100) + '%  ·  ' + mb(d.received) + ' of ' + mb(d.total) + ' MB' : d.received ? mb(d.received) + ' MB so far' : 'Downloading…')
      : d.state === 'waiting' ? 'Downloaded. Waiting for you to confirm the install.'
      : d.state === 'installing' ? (d.note || 'Checking and installing…')
      : d.state === 'done' ? 'Installed' : d.note || 'Failed';
    row.append(note);
    list.append(row);
  }
};
</script>`;

const WIDTH = 360;
const HEADER = 30;
const ROW = 64;

/** `onChange(list)` gets every change, for the app's own page. Items: {id, name, state, received, total, note, canCancel}. */
export function createDownloadMonitor({ onChange }) {
  const items = new Map();
  const cancels = new Map();
  let host = null;
  let view = null;
  let ready = null;
  let shown = false;

  const live = () => host && !host.isDestroyed();
  const layout = () => {
    if (!live() || !view) return;
    const { width, height } = host.getContentBounds();
    const h = Math.min(height - 24, HEADER + items.size * ROW);
    view.setBounds({ x: Math.max(0, width - WIDTH - 16), y: Math.max(0, height - h - 16), width: Math.min(WIDTH, width), height: h });
  };
  const sync = () => {
    const list = [...items.values()];
    onChange(list);
    if (!live() || !view) return;
    if (list.length && !shown) {
      host.contentView.addChildView(view);
      shown = true;
    } else if (!list.length && shown) {
      host.contentView.removeChildView(view);
      shown = false;
    }
    layout();
    ready?.then(() => {
      if (view && !view.webContents.isDestroyed()) view.webContents.executeJavaScript(`show(${JSON.stringify(list)})`).catch(() => {});
    });
    // The window's taskbar button shows it too.
    const active = list.filter((d) => d.state === 'downloading' && d.total);
    host.setProgressBar(active.length ? active.reduce((a, d) => a + d.received, 0) / active.reduce((a, d) => a + d.total, 0) : -1);
  };
  const remove = (id) => {
    items.delete(id);
    cancels.delete(id);
    sync();
  };

  return {
    /** Shows the panel in this mod browser window. */
    attach(window) {
      host = window;
      view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
      view.setBackgroundColor('#12161d');
      shown = false;
      // The panel's links arrive as window.open: the page itself has no access to the app.
      view.webContents.setWindowOpenHandler(({ url }) => {
        const m = /^sf-(cancel|dismiss):(.+)$/.exec(url);
        if (m?.[1] === 'cancel') cancels.get(m[2])?.();
        else if (m?.[1] === 'dismiss') remove(m[2]);
        return { action: 'deny' };
      });
      ready = view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`).catch(() => {});
      const thisView = view;
      window.on('resize', layout);
      window.on('closed', () => {
        if (host === window) {
          host = null;
          view = null;
          shown = false;
        }
        if (!thisView.webContents.isDestroyed()) thisView.webContents.close();
      });
      sync();
    },
    /** Adds or changes an item. Finished ones clear themselves: quickly when installed, slowly when something went wrong. */
    set(id, patch, cancel) {
      items.set(id, { id, name: '', state: 'downloading', received: 0, total: 0, ...items.get(id), ...patch, canCancel: !!(cancel ?? cancels.get(id)) && (patch.state ?? items.get(id)?.state) === 'downloading' });
      if (cancel) cancels.set(id, cancel);
      const state = items.get(id).state;
      if (state === 'done') setTimeout(() => remove(id), 6000);
      if (state === 'failed') setTimeout(() => remove(id), 30_000);
      sync();
    },
    remove,
    cancel: (id) => cancels.get(id)?.(),
    dismiss: remove,
    list: () => [...items.values()],
  };
}
