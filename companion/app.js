const $ = (id) => document.getElementById(id);
const api = window.modsync;
let st = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `show${bad ? ' bad' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 4500);
}

/** Yes/no in the app's own dialog (true = OK). Not confirm(): after one closes, Electron on Windows often stops
 * taking clicks until the app is reopened. */
function confirmBox(message) {
  return new Promise((resolve) => {
    const dialog = $('confirmDialog');
    $('confirmMessage').textContent = message;
    let answer = false;
    const done = () => {
      $('confirmForm').onsubmit = null;
      $('confirmCancel').onclick = null;
      dialog.removeEventListener('close', done);
      resolve(answer);
    };
    $('confirmForm').onsubmit = (e) => {
      e.preventDefault();
      answer = true;
      dialog.close();
    };
    $('confirmCancel').onclick = () => dialog.close();
    dialog.addEventListener('close', done);
    dialog.showModal();
    $('confirmOk').focus();
  });
}

function log(line) {
  const box = $('log');
  const row = el('div', null, `${new Date().toLocaleTimeString()}  ${line}`);
  box.prepend(row);
  while (box.childElementCount > 200) box.lastChild.remove();
}

async function busy(btn, label, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = label;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function refresh() {
  try {
    st = await api.state();
  } catch (err) {
    return toast(err.message, true);
  }
  render();
}

const scanner = () => (st?.platform === 'linux' ? 'ClamAV if you have it installed' : 'Windows Defender');

function render() {
  document.querySelector('button[data-game="starvalor"]')?.toggleAttribute('hidden', st?.platform === 'linux');
  if (st?.platform === 'linux' && currentTab === 'starvalor') setTab('valheim');
  $('appVersion').textContent = st.version ? `v${st.version}` : '';
  const beta = document.createElement('span');
  beta.className = 'beta-badge';
  beta.textContent = 'Beta';
  beta.title = 'SF Mod Manager is in beta: it is actively being worked on and updates are frequent.';
  $('appVersion').appendChild(beta);
  $('devBanner').hidden = !st.dev;
  if (st.dev && !document.title.endsWith('(DEV)')) document.title += ' (DEV)'; // the window title follows the page's
  // Game
  const g = $('gameInfo');
  g.innerHTML = '';
  if (!st.gameDir) {
    g.append(el('p', 'warn', "Valheim wasn't found automatically."));
    const pick = el('button', 'primary', 'Choose the Valheim folder…');
    pick.addEventListener('click', async () => {
      try {
        if (await api.pickFolder()) refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    g.append(pick);
  } else {
    const line = el('div', 'row');
    line.append(el('code', 'path', st.gameDir));
    const open = el('button', 'small ghost', 'Open');
    open.addEventListener('click', () => api.openFolder('game'));
    const change = el('button', 'small ghost', 'Change…');
    change.addEventListener('click', async () => {
      try {
        if (await api.pickFolder()) refresh();
      } catch (err) {
        toast(err.message, true);
      }
    });
    line.append(open, change);
    g.append(line);
    // Linux: Steam has to start the game a certain way, once, or the mods never load.
    if (st.linuxLaunch) {
      const box = el('div', 'setup-box');
      box.append(el('p', 'muted small', `One step in Steam for mods to load (${st.linuxLaunch.mode === 'proton' ? 'Valheim runs through Proton here' : 'native Linux Valheim'}): right-click Valheim → Properties → paste this into Launch Options. On Steam Deck do it from Desktop Mode or the game's settings.`));
      const row = el('div', 'row');
      const code = el('code', 'path', st.linuxLaunch.option);
      const copy = el('button', 'small', 'Copy');
      copy.addEventListener('click', async () => {
        await navigator.clipboard.writeText(st.linuxLaunch.option);
        copy.textContent = 'Copied';
        setTimeout(() => (copy.textContent = 'Copy'), 1500);
      });
      row.append(code, copy);
      box.append(row);
      g.append(box);
    }
    if (st.bepinex?.installed) {
      g.append(
        st.loaderOn === false
          ? el('p', 'muted', `BepInEx ${st.bepinex.version} is installed but switched off: Valheim starts vanilla (profile "Vanilla").`)
          : el('p', 'ok', `✔ BepInEx ${st.bepinex.version} installed (mods are on).`),
      );
    }
    else {
      const p = el('p', 'muted', 'BepInEx (the mod loader) is not installed yet. It is installed automatically when you sync or add a mod, or now:');
      const b = el('button', 'small primary', 'Install BepInEx');
      b.addEventListener('click', () =>
        busy(b, 'Installing…', async () => {
          try {
            await api.installBepInEx();
            toast('BepInEx installed');
            refresh();
          } catch (err) {
            toast(err.message, true);
          }
        }),
      );
      g.append(p, b);
    }
    if (st.running) g.append(el('p', 'warn', 'Valheim is running. Close it before syncing or changing mods.'));
  }
  $('autoSync').checked = st.autoSync;
  renderProfiles();
  renderNexus();

  // Server links
  const links = $('links');
  links.innerHTML = '';
  const valheimLinks = st.links.filter((l) => l.game === 'valheim');
  if (!valheimLinks.length) links.append(el('p', 'muted small', 'No Valheim servers yet. Add one with its link above.'));
  for (const l of valheimLinks) {
    const box = el('div', `link ${l.ok ? '' : 'bad'}`);
    const head = el('div', 'row');
    head.append(el('b', null, l.server ?? 'Server'));
    if (l.ok) {
      const p = l.plan;
      const changes = p ? p.add.length + p.update.length + p.remove.length + (p.needsBepInEx ? 1 : 0) : 0;
      head.append(el('span', `pill ${changes ? 'todo' : 'ok'}`, changes ? `${changes} change${changes === 1 ? '' : 's'} to sync` : '✔ matched'));
    } else head.append(el('span', 'pill bad', 'unreachable'));
    const rm = el('button', 'small ghost', 'Remove');
    rm.addEventListener('click', async () => {
      if (!await confirmBox(`Stop following ${l.server ?? 'this server'}? Mods already installed stay.`)) return;
      await api.removeLink(l.raw);
      refresh();
    });
    head.append(el('span', 'spacer'), rm);
    box.append(head);
    if (!l.ok) box.append(el('div', 'error small', l.error));
    else {
      const p = l.plan;
      const details = [];
      if (p?.needsBepInEx) details.push('install BepInEx');
      for (const m of p?.add ?? []) details.push(`+ ${m.name} ${m.version}`);
      for (const m of p?.update ?? []) details.push(`↑ ${m.name} ${m.from} → ${m.version}`);
      for (const m of p?.remove ?? []) details.push(`− ${m.name}`);
      box.append(el('div', 'muted small', `${l.manifest.mods.length} mod${l.manifest.mods.length === 1 ? '' : 's'} for players${details.length ? ` · ${details.join(' · ')}` : ''}`));
      if (!l.manifest.mods.length) {
        box.append(el('div', 'warn small', "This server isn't sharing any mods right now. If it should be, the owner can see why in Server Forge → Mods → Share mods with players (for example mods added with another mod manager need taking over first)."));
      }
    }
    links.append(box);
  }

  // Mods
  const mods = $('mods');
  mods.innerHTML = '';
  $('modCount').textContent = st.mods.length ? String(st.mods.length) : '';
  if (!st.mods.length && !st.loose.length) mods.append(el('p', 'muted small', 'No mods installed yet.'));
  const sorted = [...st.mods].sort((a, b) => Number(b.fromServer) - Number(a.fromServer) || a.name.localeCompare(b.name));
  for (const m of sorted) {
    const row = el('div', `mod${m.enabled ? '' : ' off'}`);
    const info = el('div');
    const name = el('div', 'name', m.name.replace(/_/g, ' '));
    name.append(el('span', `badge ${m.fromServer ? 'server' : 'own'}`, m.fromServer ? 'from server' : 'my mod'));
    if (m.asDependency) name.append(el('span', 'badge', 'dependency'));
    const from = m.source === 'hexium' ? ' · from Hexium' : m.namespace === 'Nexus' ? ' · from Nexus Mods' : m.source === 'upload' ? ' · own file' : '';
    info.append(name, el('div', 'muted small', `v${m.version} · by ${m.namespace}${from}${m.description ? ` · ${m.description}` : ''}`));
    row.append(info);
    const actions = el('div', 'row tight');
    if (m.fromServer) actions.append(el('span', 'muted small', 'managed by the server'));
    else {
      const lab = el('label', 'toggle');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = m.enabled;
      cb.addEventListener('change', async () => {
        try {
          await api.toggleMod(m.full, cb.checked);
          refresh();
        } catch (err) {
          toast(err.message, true);
          cb.checked = !cb.checked;
        }
      });
      lab.append(cb, document.createTextNode(' On'));
      if (updates[m.full]) {
        const up = el('button', 'small primary', `↑ Update to ${updates[m.full]}`);
        up.addEventListener('click', () =>
          busy(up, 'Updating…', async () => {
            try {
              (await api.updateMod(m.full)).forEach(log);
              delete updates[m.full];
              toast(`${m.name.replace(/_/g, ' ')} updated`);
            } catch (err) {
              toast(err.message, true);
            }
            refresh();
          }),
        );
        actions.append(up);
      }
      const rm = el('button', 'small danger', 'Remove');
      rm.addEventListener('click', async () => {
        if (!await confirmBox(`Remove ${m.name}?`)) return;
        try {
          await api.removeMod(m.full);
          refresh();
        } catch (err) {
          toast(err.message, true);
        }
      });
      actions.append(lab, rm);
    }
    row.append(actions);
    mods.append(row);
  }
  for (const f of st.loose) {
    const row = el('div', 'mod');
    row.append(el('div', null, f), el('span', 'muted small', 'added by hand (BepInEx/plugins)'));
    mods.append(row);
  }
  renderJava();
  renderPalworld();
  renderOther();
  renderTabs();
}

// ---------- games ----------

// Games without their own tab: the app only shows how to join (Satisfactory: and which mods to get with SMM).
const OTHER_GAMES = ['satisfactory', 'bedrock', 'terraria', 'spaceengineers', 'factorio', 'enshrouded', 'sevendays', 'zomboid', 'vrising'];
const TABS = ['valheim', 'java', 'palworld', 'starvalor', 'other'];
const tabOf = (game) => (OTHER_GAMES.includes(game) ? 'other' : game);
let currentTab = (() => {
  try {
    // A saved tab that no longer exists (Satisfactory had one up to 0.5.3) opens the tab its servers moved to.
    const saved = localStorage.getItem('tcmm-tab') || 'valheim';
    return TABS.includes(saved) ? saved : tabOf(saved);
  } catch {
    return 'valheim';
  }
})();

function setTab(tab) {
  currentTab = tab;
  try {
    localStorage.setItem('tcmm-tab', tab);
  } catch {}
  renderTabs();
}

function renderTabs() {
  for (const b of $('gameTabs').querySelectorAll('button')) {
    const tab = b.dataset.game;
    b.classList.toggle('active', tab === currentTab);
    const n = st ? st.links.filter((l) => tabOf(l.game) === tab).length : 0;
    b.querySelector('.tab-count')?.remove();
    if (n) b.append(el('span', 'tab-count', String(n)));
  }
  for (const tab of TABS) $(`view-${tab}`).hidden = tab !== currentTab;
  if (currentTab === 'starvalor') loadAchilles();
  // Star Valor: Achilles takes over the whole window (no server links there, it manages the player's own mods);
  // the game tabs stay as a slim bar on top to switch back.
  document.body.classList.toggle('starvalor-mode', currentTab === 'starvalor');
  // Sync now / Play are Valheim's (Minecraft has its own Sync button).
  $('btnSync').hidden = $('btnPlay').hidden = currentTab !== 'valheim';
}
$('gameTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-game]');
  if (b) setTab(b.dataset.game);
});

// Star Valor: Achilles (its own page from its local server, started the first time this tab opens).
let achillesLoading = null;
function loadAchilles() {
  if (achillesLoading) return;
  achillesLoading = api
    .achillesUrl()
    .then((url) => {
      const frame = $('achillesFrame');
      frame.src = url;
      frame.hidden = false;
      $('achillesNote').hidden = true;
    })
    .catch((err) => {
      $('achillesNote').textContent = `Achilles couldn't start: ${err.message}`;
      achillesLoading = null; // try again next time the tab opens
    });
}

/** The common top of a server box: name, a status pill, Remove. */
function linkBox(l, pill) {
  const box = el('div', `link ${l.ok ? '' : 'bad'}`);
  const head = el('div', 'row');
  head.append(el('b', null, l.server ?? 'Server'));
  if (!l.ok) head.append(el('span', 'pill bad', 'unreachable'));
  else if (pill) head.append(pill);
  const rm = el('button', 'small ghost', 'Remove');
  rm.addEventListener('click', async () => {
    if (!await confirmBox(`Stop following ${l.server ?? 'this server'}? Anything already installed stays.`)) return;
    await api.removeLink(l.raw);
    refresh();
  });
  head.append(el('span', 'spacer'), rm);
  box.append(head);
  if (!l.ok) box.append(el('div', 'error small', l.error));
  return box;
}

/** "Join: host:port [Copy]". */
function addressRow(l, label = 'Address') {
  const row = el('div', 'row tight');
  if (!l.address) return row;
  const copy = el('button', 'small ghost', 'Copy');
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(l.address);
      toast('Address copied');
    } catch {
      toast(l.address);
    }
  });
  row.append(el('span', 'muted small', `${label}:`), el('code', 'address', l.address), copy);
  return row;
}

function renderJava() {
  const box = $('mcLinks');
  box.innerHTML = '';
  const list = st.links.filter((l) => l.game === 'java');
  if (!list.length) box.append(el('p', 'muted small', 'No Minecraft Java servers yet. Add one with its link above.'));
  for (const l of list) {
    if (!l.ok || !l.java) {
      const b = linkBox(l, l.ok ? el('span', 'pill ok', 'no mods needed') : null);
      if (l.ok) {
        b.append(addressRow(l));
        if (l.note) b.append(el('div', 'muted small', l.note));
      }
      box.append(b);
      continue;
    }
    const p = l.plan;
    const changes = p.add.length + p.update.length + p.remove.length;
    const b = linkBox(l, el('span', `pill ${changes ? 'todo' : 'ok'}`, changes ? `${changes} change${changes === 1 ? '' : 's'} to sync` : '✔ matched'));
    const j = l.java;
    const details = [];
    for (const m of p.add) details.push(`+ ${m.name} ${m.version}`);
    for (const m of p.update) details.push(`↑ ${m.name} ${m.from} → ${m.version}`);
    for (const f of p.remove) details.push(`− ${f}`);
    b.append(el('div', 'muted small', `${j.loader}${j.loaderVersion ? ` ${j.loaderVersion}` : ''} · Minecraft ${j.mcVersion} · ${j.mods} mod${j.mods === 1 ? '' : 's'} for players${details.length ? ` · ${details.join(' · ')}` : ''}`));
    b.append(addressRow(l));
    // Launcher: loader and profile.
    const s = l.setup;
    const setup = el('div', 'setup-box');
    if (!j.loaderVersion) {
      setup.append(el('div', 'warn small', `The server doesn't say which ${j.loader} version it runs, so the app can't set up the launcher. Install ${j.loader} for Minecraft ${j.mcVersion} yourself and point a launcher profile at the mods folder (Open mods folder).`));
    } else if (!s.loaderReady && s.installerUrl) {
      setup.append(el('div', 'warn small', `${j.loader} ${j.loaderVersion} isn't in your Minecraft Launcher yet. Download its installer, run it, choose "Install client" and press OK, then press "Check again". (The installer needs Java; if double-clicking it does nothing, install Java from adoptium.net first.)`));
      const row = el('div', 'row tight');
      const dl = el('button', 'small primary', `Download the ${j.loader} installer`);
      dl.addEventListener('click', () => api.openExternal(s.installerUrl).catch((err) => toast(err.message, true)));
      const again = el('button', 'small', 'Check again');
      again.addEventListener('click', () => mcSetup(l, again));
      row.append(dl, again);
      setup.append(row);
    } else if (!s.profile) {
      setup.append(el('div', 'muted small', changes ? 'Sync to download the mods and add the server\'s profile to the Minecraft Launcher.' : 'The launcher profile is missing.'));
      if (!changes) {
        const make = el('button', 'small primary', 'Set up the launcher');
        make.addEventListener('click', () => mcSetup(l, make));
        setup.append(make);
      }
    } else {
      setup.append(el('div', 'ok small', `✔ The Minecraft Launcher profile for "${l.server}" is ready. Open the launcher, pick that profile under Installations or next to Play, and the server is in Multiplayer. Restart the launcher if it was open when the profile was added.`));
    }
    b.append(setup);
    const own = l.installed.filter((x) => !x.fromServer);
    if (own.length) b.append(el('div', 'muted small', `Your own jars in this folder (left alone): ${own.map((x) => x.file).join(', ')}`));
    const actions = el('div', 'row tight');
    const open = el('button', 'small ghost', 'Open mods folder');
    open.addEventListener('click', () => api.mcOpenFolder(l.raw));
    actions.append(open);
    b.append(actions);
    box.append(b);
  }
}

/** Palworld: the game's mod loader, then each server with what's left to sync. */
function renderPalworld() {
  const game = $('palGame');
  const box = $('palLinks');
  game.innerHTML = '';
  box.innerHTML = '';
  const list = st.links.filter((l) => l.game === 'palworld');
  const pw = st.palworld;
  renderPalMods(pw);
  if (!list.length) box.append(el('p', 'muted small', 'No Palworld servers yet. Add one with its link above.'));
  const setup = el('div', 'setup-box');
  if (!pw) setup.append(el('div', 'warn small', "Palworld wasn't found. Install it with Steam, then come back to this tab."));
  else {
    setup.append(el('div', 'muted small', `Palworld: ${pw.gameDir}`));
    setup.append(el('div', 'muted small', `Mods go to ${pw.root}${pw.steamWorkshop ? " (the game reads Steam Workshop's folder because you've subscribed to Workshop mods; the server's mods go there too)" : ''}.`));
    if (pw.running) setup.append(el('div', 'warn small', 'Palworld is running. Close it to add, change or sync mods: it sets them up when it starts.'));
    if (pw.manualUe4ss) setup.append(el('div', 'warn small', "You have a manual UE4SS install (dwmapi.dll in Pal\\Binaries\\Win64). It doesn't read the mod loader's mods, so the server's script mods won't run. To use them, rename or delete dwmapi.dll, then Sync now."));
    const missing = pw.installed.filter((m) => !m.present || !m.active);
    if (pw.installed.length && (missing.length || !pw.loaderOn)) setup.append(el('div', 'warn small', 'Some server mods were switched off or removed in the game. Sync now puts them back.'));
  }
  game.append(setup);
  for (const l of list) {
    if (!l.ok || !l.palworld) {
      const b = linkBox(l, l.ok ? el('span', 'pill ok', 'no mods needed') : null);
      if (l.ok) {
        b.append(addressRow(l));
        if (l.note) b.append(el('div', 'muted small', l.note));
      }
      box.append(b);
      continue;
    }
    const p = l.plan;
    const changes = p ? p.add.length + p.update.length + p.remove.length : 0;
    const todo = p && (changes || p.needsFix);
    const b = linkBox(l, el('span', `pill ${todo ? 'todo' : 'ok'}`, !p ? 'Palworld not found' : changes ? `${changes} change${changes === 1 ? '' : 's'} to sync` : p.needsFix ? 'needs a sync' : '✔ matched'));
    const mods = l.palworld.mods;
    const details = [];
    for (const m of p?.add ?? []) details.push(`+ ${m.name} ${m.version}`);
    for (const m of p?.update ?? []) details.push(`↑ ${m.name} ${m.from} → ${m.version}`);
    for (const id of p?.remove ?? []) details.push(`− ${id}`);
    b.append(el('div', 'muted small', `${mods.length} mod${mods.length === 1 ? '' : 's'} for players${details.length ? ` · ${details.join(' · ')}` : ''}`));
    if (mods.length) b.append(el('div', 'muted small', mods.map((m) => `${m.name}${m.version ? ` ${m.version}` : ''}`).join(' · ')));
    b.append(addressRow(l));
    if (l.note) b.append(el('div', 'muted small', l.note));
    box.append(b);
  }
}

/** Every mod in the game: on/off and remove for the player's own, labels for what a server or Steam looks after. */
function renderPalMods(pw) {
  const box = $('palMods');
  box.innerHTML = '';
  for (const id of ['btnPalCurseForge', 'btnPalNexus', 'btnPalAdd', 'btnPalFolder']) $(id).disabled = !pw;
  $('btnPalPlay').disabled = !pw || pw.running;
  $('btnPalPlay').title = !pw ? "Palworld wasn't found" : pw.running ? 'Palworld is already running' : 'Syncs with your servers, then starts Palworld';
  if (!pw) return;
  if (!pw.mods.length) return box.append(el('p', 'muted small', 'No mods yet.'));
  const change = async (fn) => {
    try {
      await fn();
    } catch (err) {
      toast(err.message, true);
    }
    refresh();
  };
  for (const m of pw.mods) {
    const row = el('div', 'mod');
    const info = el('div');
    const name = el('div', null, `${m.name}${m.version ? ` ${m.version}` : ''}`);
    name.append(document.createTextNode(' '), el('span', 'pill', m.source === 'server' ? 'from a server' : m.source === 'workshop' ? 'Steam Workshop' : 'yours'));
    info.append(name, el('div', 'muted small', [m.types.join(', '), m.author && m.author !== 'unknown' ? `by ${m.author}` : '', m.pending].filter(Boolean).join(' · ')));
    if (m.needsUe4ss) info.append(el('div', 'warn small', 'Needs UE4SS: add UE4SS-Palworld.zip here, or subscribe to "UE4SS Experimental (Palworld)" on the Steam Workshop.'));
    if (m.serverOnly) info.append(el('div', 'warn small', "Made for servers only: your game doesn't use it."));
    row.append(info);
    const actions = el('div', 'row tight');
    if (m.source === 'server') actions.append(el('span', 'muted small', m.active ? 'kept matched to the server' : 'off: Sync now puts it back'));
    else {
      const label = el('label', 'toggle');
      const on = el('input');
      on.type = 'checkbox';
      on.checked = m.active;
      on.addEventListener('change', () => change(() => api.palToggle(m.id, on.checked)));
      label.append(on, document.createTextNode(' On'));
      actions.append(label);
      if (m.source === 'own') {
        const rm = el('button', 'small danger', 'Remove');
        rm.addEventListener('click', async () => {
          if (await confirmBox(`Remove ${m.name}?`)) change(() => api.palRemove(m.id));
        });
        actions.append(rm);
      }
    }
    row.append(actions);
    box.append(row);
  }
}

async function mcSetup(l, btn) {
  await busy(btn, 'Checking…', async () => {
    try {
      const s = await api.mcSetup(l.raw);
      toast(s.profile ? `The Minecraft Launcher profile for "${l.server}" is ready` : 'The loader still isn\'t in the launcher', !s.profile);
    } catch (err) {
      toast(err.message, true);
    }
  });
  refresh();
}

/** Satisfactory: the server's mods, each opening in Satisfactory Mod Manager (it installs them and their dependencies). */
function satisfactoryMods(b, mods) {
  for (const m of mods) {
    const row = el('div', 'mod');
    const info = el('div');
    info.append(el('div', 'name', m.name), el('div', 'muted small', m.id === 'SML' ? `v${m.version} · the mod loader (SMM installs it with the mods)` : `v${m.version}`));
    row.append(info);
    const actions = el('div', 'row tight');
    if (m.id !== 'SML') {
      const smm = el('button', 'small primary', 'Install with SMM');
      smm.title = 'Opens this mod in Satisfactory Mod Manager';
      smm.addEventListener('click', () => api.openExternal(`smmanager://install?modID=${m.id}${/^[\w.\-+]{1,40}$/.test(m.version) ? `&version=${m.version}` : ''}`).catch((err) => toast(err.message, true)));
      actions.append(smm);
    }
    const page = el('button', 'small ghost', 'ficsit.app');
    page.addEventListener('click', () => api.openExternal(`https://ficsit.app/mod/${m.id}`).catch((err) => toast(err.message, true)));
    actions.append(page);
    row.append(actions);
    b.append(row);
  }
  if (mods.length) b.append(el('div', 'muted small', "\"Install with SMM\" needs Satisfactory Mod Manager installed (smm.ficsit.app). Install the version shown, the same as the server's."));
}

function renderOther() {
  const box = $('otherLinks');
  box.innerHTML = '';
  const list = st.links.filter((l) => OTHER_GAMES.includes(l.game));
  if (!list.length) box.append(el('p', 'muted small', 'No servers for these games yet. Add one with its link above.'));
  for (const l of list) {
    const mods = l.game === 'satisfactory' ? (l.mods ?? []) : [];
    const pill = mods.length ? `${l.gameName} · ${mods.length} mod${mods.length === 1 ? '' : 's'}` : l.gameName;
    const b = linkBox(l, l.ok ? el('span', 'pill ok', pill) : null);
    if (l.ok) {
      b.append(addressRow(l));
      if (l.note) b.append(el('div', 'muted small', l.note));
      satisfactoryMods(b, mods);
    }
    box.append(b);
  }
}

// ---------- profiles ----------

const vanilla = () => st?.activeProfile === 'vanilla';

function renderProfiles() {
  const box = $('profiles');
  box.innerHTML = '';
  const chip = (id, name, sub, extra = '') => {
    const b = el('button', `profile-chip${extra}${st.activeProfile === id ? ' active' : ''}`);
    b.append(el('span', null, `${st.activeProfile === id ? '● ' : ''}${name}`), el('span', 'sub', sub));
    b.disabled = st.running || !st.gameDir;
    b.title = st.running ? 'Close Valheim to switch profiles' : '';
    b.addEventListener('click', async () => {
      if (st.activeProfile === id) return;
      try {
        await api.switchProfile(id);
        toast(`Switched to ${name}`);
      } catch (err) {
        toast(err.message, true);
      }
      refresh();
    });
    box.append(b);
  };
  chip('vanilla', 'Vanilla', 'no mods', ' vanilla');
  for (const p of st.profiles) chip(p.id, p.name, p.off ? `${p.off} mod${p.off === 1 ? '' : 's'} off` : 'all mods on');
  // Rename/delete the active modded profile.
  const actions = $('profileActions');
  actions.innerHTML = '';
  const current = st.profiles.find((p) => p.id === st.activeProfile);
  if (current) {
    const rename = el('button', 'small ghost', 'Rename');
    rename.addEventListener('click', () => nameBox('Rename to', current.name, async (name) => api.renameProfile(current.id, name)));
    const del = el('button', 'small danger', 'Delete');
    del.disabled = st.profiles.length <= 1;
    del.title = del.disabled ? 'Keep at least one modded profile' : '';
    del.addEventListener('click', async () => {
      if (!await confirmBox(`Delete the profile "${current.name}"? Your mods stay installed.`)) return;
      try {
        await api.deleteProfile(current.id);
      } catch (err) {
        toast(err.message, true);
      }
      refresh();
    });
    actions.append(rename, del);
  }
  // Play button colour/label follow the profile.
  $('btnPlay').textContent = vanilla() ? '▶ Play Valheim (vanilla)' : '▶ Play Valheim';
  $('btnPlay').classList.toggle('vanilla', vanilla());
}

/** A small inline name box under the profiles (Electron has no prompt()). */
function nameBox(label, value, save) {
  const actions = $('profileActions');
  actions.innerHTML = '';
  const form = el('form', 'row');
  const input = el('input');
  input.value = value;
  input.placeholder = 'Profile name';
  input.maxLength = 40;
  const ok = el('button', 'small primary', label === 'Rename to' ? 'Rename' : 'Create');
  ok.type = 'submit';
  const cancel = el('button', 'small ghost', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => renderProfiles());
  form.append(el('span', 'muted small', label), input, ok, cancel);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await save(input.value);
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
  actions.append(form);
  input.focus();
  input.select();
}

$('btnNewProfile').addEventListener('click', () =>
  nameBox('New profile (starts with the mods that are on now):', '', async (name) => {
    await api.createProfile(name);
    toast(`Created and switched to ${name.trim()}`);
  }),
);

// ---------- Nexus Mods ----------

function renderNexus() {
  const n = st.nexus;
  $('nexusStatus').textContent = n ? `· linked as ${n.name}${n.premium ? ' (Premium)' : ''}` : '· no API key (Manual download only)';
  $('nexusKeyRemove').hidden = !n;
  $('nexusKeyInput').placeholder = n ? 'Replace the saved key' : 'Nexus Mods API key';
}

$('btnNexus').addEventListener('click', () => api.browseNexus());
$('btnHexium').addEventListener('click', () => api.browseHexium());

// Updating the app itself from a new installer (Tavern-Client-Mod-Manager-Setup-x.y.z.exe).
$('btnUpdateApp').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const picked = await api.pickUpdate();
    if (!picked) return;
    const cmp = picked.version.split('.').map(Number).reduce((r, n, i) => r || n - (picked.current.split('.').map(Number)[i] ?? 0), 0);
    const note = cmp > 0 ? '' : cmp === 0 ? '\n\nThat is the version you already have (it will be reinstalled).' : '\n\nThat is an OLDER version than the one you have.';
    if (!await confirmBox(`Update SF Mod Manager from ${picked.current} to ${picked.version || 'the version in that file'}?${note}\n\nThe app closes, an "Updating" window shows the progress, and the new version opens by itself. Your mods and settings are kept.`)) return;
    await api.runUpdate();
    toast('Updating… watch the "Updating" window');
  } catch (err) {
    toast(err.message, true);
  }
});

// New versions of this app (GitHub releases): a banner when one is out, checked at start and every 6 hours.
let appUpdate = null;
async function checkAppUpdate(force = false) {
  try {
    appUpdate = await api.appUpdate(force);
  } catch (err) {
    if (force) toast(err.message, true);
    return;
  }
  const u = appUpdate;
  $('updateBanner').hidden = !u.available;
  $('updateText').textContent = u.available ? `SF Mod Manager ${u.latest} is available (you have ${u.current}).` : '';
  $('btnInstallAppUpdate').hidden = !u.canInstall;
  $('settingsDot').hidden = !u.available;
  const status = u.available
    ? `Version ${u.latest} is available.`
    : u.error
      ? `Couldn't check for updates: ${u.error}`
      : u.latest
        ? `You have the latest version.`
        : 'No releases have been published yet.';
  $('aboutUpdate').textContent = status;
  renderUpdateSettings(status);
  if (force && !u.available && !u.error) toast('You have the latest version');
}

/** Settings → Update SF Mod Manager: this version, the newest one and what's new in it. */
function renderUpdateSettings(status) {
  const u = appUpdate;
  const box = $('appUpdateInfo');
  box.innerHTML = '';
  if (!u) return box.append(el('p', 'muted small', 'Checking for updates…'));
  box.append(el('p', null, `You have version ${u.current}.`));
  box.append(el('p', u.available ? 'ok-text' : u.error ? 'warn-text small' : 'muted small', status));
  if (u.checkedAt) box.append(el('p', 'muted small', `Last checked ${new Date(u.checkedAt).toLocaleString()}.`));
  if (u.available && u.notes) {
    const notes = el('details', 'update-notes');
    notes.append(el('summary', null, `What's new in ${u.latest}`), el('div', 'notes-text', u.notes));
    box.append(notes);
  }
  if (u.available && !u.canInstall) box.append(el('p', 'muted small', 'Updates install only in the installed app (this copy runs from the source files).'));
  $('btnSettingsInstall').hidden = !(u.available && u.canInstall);
  $('btnSettingsInstall').textContent = `Install ${u.latest ?? 'update'}`;
}
checkAppUpdate();
setInterval(() => checkAppUpdate(), 6 * 3600_000);

$('updateNotes').addEventListener('click', (e) => {
  e.preventDefault();
  if (appUpdate?.notes) alert(`What's new in ${appUpdate.latest}:\n\n${appUpdate.notes}`);
  else window.open(appUpdate?.url ?? 'https://github.com/CorruptedVariant/sf-mod-manager-releases/releases');
});

// The banner's "Update now" and Settings' "Install" do the same thing; both show the download progress.
const installButtons = () => [$('btnInstallAppUpdate'), $('btnSettingsInstall')];
api.on('update-progress', (p) => {
  const mb = (n) => (n / 1048576).toFixed(1);
  for (const b of installButtons()) b.textContent = p.total ? `Downloading ${mb(p.received)} / ${mb(p.total)} MB…` : `Downloading ${mb(p.received)} MB…`;
});

async function installAppUpdate() {
  if (!appUpdate?.available) return;
  if (!await confirmBox(`Update to ${appUpdate.latest}?\n\nIt downloads from GitHub, then the app closes, an "Updating" window shows the progress, and the new version opens by itself. Your mods and settings are kept.`)) return;
  for (const b of installButtons()) b.disabled = true;
  try {
    await api.installAppUpdate();
    for (const b of installButtons()) b.textContent = 'Installing…';
  } catch (err) {
    for (const b of installButtons()) b.disabled = false;
    $('btnInstallAppUpdate').textContent = 'Update now';
    $('btnSettingsInstall').textContent = `Install ${appUpdate.latest}`;
    toast(err.message, true);
  }
}
$('btnInstallAppUpdate').addEventListener('click', installAppUpdate);
$('btnSettingsInstall').addEventListener('click', installAppUpdate);

function openSettings() {
  renderUpdateSettings($('aboutUpdate').textContent);
  $('settingsDialog').showModal();
}
$('btnSettings').addEventListener('click', openSettings);
$('settingsClose').addEventListener('click', () => $('settingsDialog').close());
$('btnAboutUpdates').addEventListener('click', () => {
  $('aboutDialog').close();
  openSettings();
});

$('btnAbout').addEventListener('click', (e) => {
  e.preventDefault();
  const v = st?.version ?? '';
  $('aboutVersion').textContent = v ? `v${v}` : '';
  // The bug report form fills in which app and version by itself.
  $('aboutReport').href = `https://github.com/CorruptedVariant/server-forge/issues/new?template=bug_report.yml&app=${encodeURIComponent('SF Mod Manager')}&version=${encodeURIComponent(v)}`;
  $('aboutDialog').showModal();
});
$('aboutClose').addEventListener('click', () => $('aboutDialog').close());
$('btnCheckAppUpdate').addEventListener('click', () => busy($('btnCheckAppUpdate'), 'Checking…', () => checkAppUpdate(true)));

// Updates for the player's own mods (Thunderstore / Hexium); mods from a server follow the server.
let updates = {};
$('btnCheckUpdates').addEventListener('click', () =>
  busy($('btnCheckUpdates'), 'Checking…', async () => {
    try {
      updates = await api.checkUpdates();
      const n = Object.keys(updates).length;
      toast(n ? `${n} update${n === 1 ? '' : 's'} available` : 'Your mods are up to date');
      render();
    } catch (err) {
      toast(err.message, true);
    }
  }),
);
$('nexusKeyForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = $('nexusKeyInput').value.trim();
  if (!key) return;
  await busy(e.submitter, 'Checking…', async () => {
    try {
      const user = await api.setNexusKey(key);
      $('nexusKeyInput').value = '';
      toast(`Nexus Mods linked as ${user.name}${user.premium ? ' (Premium)' : ''}`);
      refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
});
$('nexusKeyRemove').addEventListener('click', async () => {
  if (!await confirmBox('Remove the saved Nexus Mods API key from this PC?')) return;
  await api.setNexusKey('');
  toast('Key removed');
  refresh();
});
$('nexusLinkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('nexusLinkInput').value.trim();
  if (!input) return;
  await busy(e.submitter, 'Installing…', async () => {
    try {
      const hexium = /hexium\.gg\//i.test(input);
      const done = hexium ? await api.installHexium(input) : await api.installNexus(input);
      done.forEach(log);
      $('nexusLinkInput').value = '';
      toast(`Installed from ${hexium ? 'Hexium' : 'Nexus Mods'}`);
    } catch (err) {
      toast(err.message, true);
    }
  });
  refresh();
});

// ---------- actions ----------

$('linkForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const raw = $('linkInput').value.trim();
  if (!raw) return;
  const ok = await confirmBox(
    'Follow this server?\n\nFor Valheim and modded Minecraft, the server owner decides which mods run in your game. Mods are programs that run on your PC, so only follow servers whose owner you trust.\n\nEvery mod is safety-checked before it is installed (Windows Defender, plus Thunderstore or Modrinth). Anything not from those sites, or that the check flags, waits for your approval.',
  );
  if (!ok) return;
  const btn = e.submitter;
  await busy(btn, 'Checking…', async () => {
    try {
      const r = await api.addLink(raw);
      $('linkInput').value = '';
      toast(`Following ${r.server} (${r.gameName})`);
      log(`Added ${r.gameName} server ${r.server}.`);
      setTab(tabOf(r.game));
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });
});

// ---------- sync with review ----------

let afterReview = null; // what to do once the review is closed (e.g. start Valheim)

function scanBadge(scan) {
  const cls = scan.verdict === 'clean' ? 'ok' : scan.verdict === 'blocked' ? 'bad' : 'todo';
  const label = scan.verdict === 'clean' ? '✔ passed checks' : scan.verdict === 'blocked' ? '⛔ blocked' : '⚠ needs review';
  return el('span', `pill ${cls}`, label);
}

function showReview(review, game = 'valheim') {
  $('reviewIntro').textContent =
    game === 'java'
      ? `Every mod was downloaded from the server and checked (${scanner()}, and whether Modrinth has the exact same file). Nothing has been installed yet.`
      : game === 'palworld'
        ? `Every mod was downloaded from the server and checked with ${scanner()}. Nothing has been installed yet. Palworld sets the mods up the next time it starts.`
        : `Every mod was downloaded and safety-checked (${scanner()}, Thunderstore status and a scan for malware-like behaviour). Nothing has been installed yet.`;
  const body = $('reviewBody');
  body.innerHTML = '';
  let needsTick = 0;
  for (const srv of review) {
    body.append(el('h3', null, srv.server));
    if (srv.bepinex) {
      const row = el('div', 'change');
      row.append(el('div', 'name', `Install BepInEx ${srv.bepinex.version} (the mod loader)`), scanBadge(srv.bepinex.scan));
      body.append(row);
    }
    for (const c of srv.changes) {
      const row = el('div', `change ${c.blocked ? 'blocked' : ''}`);
      const info = el('div');
      const title = el('div', 'name', `${c.action === 'add' ? '+ Add' : '↑ Update'} ${c.name} ${c.from ? `${c.from} → ` : ''}${c.version}`);
      const badge =
        c.source === 'upload' ? 'not on Thunderstore'
        : c.source === 'server' ? 'not on Modrinth'
        : c.source === 'palserver' ? 'from the server'
        : c.source === 'modrinth' ? 'on Modrinth'
        : c.source === 'hexium' ? `by ${c.author} · Hexium`
        : `by ${c.author}`;
      title.append(el('span', `badge ${c.source === 'upload' || c.source === 'server' || c.source === 'palserver' ? 'own' : ''}`, badge));
      info.append(title, el('div', 'muted small', c.scan.summary));
      for (const f of c.scan.flags) info.append(el('div', `small ${f.level === 'high' ? 'error' : 'warn'}`, `${f.level === 'high' ? '⛔' : '⚠'} ${f.text}${f.file ? ` (${f.file})` : ''}`));
      if (c.source === 'upload' && !c.scan.flags.length) info.append(el('div', 'small warn', '⚠ Uploaded by the server owner, not from Thunderstore: nobody else has checked it.'));
      if (c.source === 'server' && !c.scan.flags.length) info.append(el('div', 'small warn', "⚠ Sent by the server owner, and Modrinth doesn't have this exact file: nobody else has checked it."));
      if (c.source === 'palserver' && !c.scan.flags.length) info.append(el('div', 'small warn', '⚠ Sent by the server owner: nobody else has checked these files. Only approve mods from servers you trust.'));
      row.append(info);
      const right = el('div', 'change-right');
      right.append(scanBadge(c.scan));
      if (c.blocked) right.append(el('span', 'small error', "Won't be installed"));
      else if (c.needsApproval) {
        const lab = el('label', 'toggle small');
        const cb = el('input');
        cb.type = 'checkbox';
        cb.dataset.key = c.key;
        cb.checked = c.approvedBefore;
        if (!c.approvedBefore) needsTick++;
        lab.append(cb, document.createTextNode(c.approvedBefore ? ' Approved before' : ' I trust this mod'));
        right.append(lab);
      }
      row.append(right);
      body.append(row);
    }
    for (const r of srv.removals) body.append(el('div', 'change', `− Remove ${r} (the server no longer uses it)`));
    for (const u of srv.unavailable ?? []) body.append(el('div', 'change blocked', `⚠ Can't download ${u}. Ask the server owner to check it in Server Forge (Mods → Share mods with players). The other mods still install.`));
    // Mod settings the server owner sends: only these values change in the player's config files.
    for (const s of srv.settings ?? []) {
      const row = el('div', 'change');
      const info = el('div');
      const title = el('div', 'name', `⚙ ${s.key}: ${s.from == null ? '' : `${s.from === '' ? '(empty)' : s.from} → `}${s.value === '' ? '(empty)' : s.value}`);
      title.append(el('span', 'badge', 'mod setting'));
      info.append(title, el('div', 'muted small', `${s.file} · [${s.section}] · set by the server owner, every time you sync`));
      row.append(info);
      body.append(row);
    }
  }
  $('reviewNote').textContent = needsTick ? 'Unticked mods are skipped (the others are still installed).' : '';
  $('reviewDialog').showModal();
}

async function prepareAndReview(thenLaunch) {
  const btn = thenLaunch ? $('btnPlay') : $('btnSync');
  await busy(btn, 'Checking…', async () => {
    try {
      // Vanilla: just start the game (no syncing into a game that won't load the mods anyway).
      if (thenLaunch && vanilla()) {
        await api.launch();
        return;
      }
      if (!st?.links.some((l) => l.game === 'valheim')) {
        if (thenLaunch) await api.launch();
        else toast('Add a Valheim server link first');
        return;
      }
      const r = await api.prepare('valheim');
      if (!r.changes) {
        const empty = st.links.filter((l) => l.game === 'valheim' && l.ok && !l.manifest.mods.length).map((l) => l.server);
        log(empty.length ? `${empty.join(', ')} isn't sharing any mods right now.` : 'Your mods already match the server.');
        if (thenLaunch) await api.launch();
        else toast(empty.length ? `${empty.join(', ')} isn't sharing any mods (the owner can check why in Server Forge)` : 'Already up to date', !!empty.length);
        return;
      }
      afterReview = thenLaunch ? () => api.launch() : null;
      showReview(r.review);
    } catch (err) {
      toast(err.message, true);
    }
  });
  refresh();
}

$('reviewApply').addEventListener('click', async () => {
  const approve = [...$('reviewBody').querySelectorAll('input[data-key]:checked')].map((c) => c.dataset.key);
  $('reviewApply').disabled = true;
  try {
    const summary = await api.apply(approve);
    toast('Mods updated');
    $('reviewDialog').close();
    if (afterReview) await afterReview();
    summary.forEach(log);
  } catch (err) {
    toast(err.message, true);
  } finally {
    $('reviewApply').disabled = false;
    afterReview = null;
    refresh();
  }
});
$('reviewCancel').addEventListener('click', async () => {
  await api.cancel();
  $('reviewDialog').close();
  afterReview = null;
  log('Sync cancelled; nothing was installed.');
});

$('btnSync').addEventListener('click', () => prepareAndReview(false));
$('btnPlay').addEventListener('click', () => prepareAndReview(true));
api.on('needs-review', (r) => {
  toast('A server added or changed mods: please review them');
  afterReview = null;
  showReview(r.review, r.game);
});

// Minecraft Java: download + check, then review (or report nothing to do).
$('btnMcSync').addEventListener('click', () =>
  busy($('btnMcSync'), 'Checking…', async () => {
    try {
      if (!st?.links.some((l) => l.game === 'java' && l.java)) return toast('No modded Minecraft servers to sync');
      const r = await api.prepare('java');
      if (!r.changes) {
        log('Your Minecraft mods already match the servers.');
        toast('Already up to date');
        return;
      }
      afterReview = null;
      showReview(r.review, 'java');
    } catch (err) {
      toast(err.message, true);
    }
    refresh();
  }),
);

// Palworld: the same, for the game's own mod loader.
$('btnPalSync').addEventListener('click', () =>
  busy($('btnPalSync'), 'Checking…', async () => {
    try {
      if (!st?.links.some((l) => l.game === 'palworld' && l.palworld)) return toast('No Palworld servers with mods to sync');
      const r = await api.prepare('palworld');
      if (!r.changes) {
        log('Your Palworld mods already match the servers.');
        toast('Already up to date');
        return;
      }
      afterReview = null;
      showReview(r.review, 'palworld');
    } catch (err) {
      toast(err.message, true);
    }
    refresh();
  }),
);

$('autoSync').addEventListener('change', () => api.setAuto($('autoSync').checked));
$('btnBrowse').addEventListener('click', () => api.browse());
$('btnPlugins').addEventListener('click', () => api.openFolder('plugins'));

async function installFiles(files) {
  for (const f of files) {
    try {
      const done = await api.installFile(f);
      done.forEach((d) => log(d));
      toast(`Installed ${f.name}`);
    } catch (err) {
      toast(`${f.name}: ${err.message}`, true);
    }
  }
  refresh();
}
$('fileInput').addEventListener('change', () => {
  installFiles([...$('fileInput').files]);
  $('fileInput').value = '';
});
for (const evt of ['dragenter', 'dragover']) $('drop').addEventListener(evt, (e) => (e.preventDefault(), $('drop').classList.add('over')));
for (const evt of ['dragleave', 'drop']) $('drop').addEventListener(evt, () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', (e) => {
  e.preventDefault();
  installFiles([...e.dataTransfer.files]);
});

/** Runs one Palworld add and reports it. */
async function palAdded(run, label) {
  try {
    const r = await run();
    r.done.forEach(log);
    r.warnings.forEach((w) => log(`⚠ ${w}`));
    if (r.done.length) toast(r.warnings[0] ?? `${label}`, !!r.warnings.length);
  } catch (err) {
    toast(err.message, true);
  }
  refresh();
}
// Like Valheim's Play: match the servers first (with the review if anything changed), then start the game.
$('btnPalPlay').addEventListener('click', () =>
  busy($('btnPalPlay'), 'Checking…', async () => {
    try {
      if (!st?.links.some((l) => l.game === 'palworld' && l.palworld)) return await api.palLaunch();
      // A server that's down shouldn't stop the game starting.
      const r = await api.prepare('palworld').catch((err) => {
        log(`Couldn't check your Palworld servers (${err.message}). Starting anyway.`);
        return { changes: 0 };
      });
      if (!r.changes) return await api.palLaunch();
      afterReview = () => api.palLaunch();
      showReview(r.review, 'palworld');
    } catch (err) {
      toast(err.message, true);
    } finally {
      refresh();
    }
  }),
);
$('btnPalCurseForge').addEventListener('click', () => api.palBrowse('curseforge'));
$('btnPalNexus').addEventListener('click', () => api.palBrowse('nexus'));
$('btnPalFolder').addEventListener('click', () => api.palOpenFolder());
$('btnPalAdd').addEventListener('click', () => palAdded(() => api.palPickFiles(), 'Mods added'));
for (const evt of ['dragenter', 'dragover']) $('palDrop').addEventListener(evt, (e) => (e.preventDefault(), $('palDrop').classList.add('over')));
for (const evt of ['dragleave', 'drop']) $('palDrop').addEventListener(evt, () => $('palDrop').classList.remove('over'));
$('palDrop').addEventListener('drop', async (e) => {
  e.preventDefault();
  for (const f of [...e.dataTransfer.files]) await palAdded(() => api.palInstallFile(f), `Added ${f.name}`);
});

api.on('log', log);
// The mod downloads panel (the mod browser window shows the same list).
api.on('downloads', (rows) => {
  const tray = document.getElementById('downloadTray');
  tray.hidden = !rows.length;
  tray.textContent = '';
  if (!rows.length) return;
  tray.append(el('h4', null, 'Mod downloads'));
  const mbs = (n) => (n / 1048576).toFixed(n < 104857600 ? 1 : 0);
  for (const d of rows) {
    const row = el('div', `download-row ${d.state}`);
    const top = el('div', 'download-top');
    const name = el('span', 'download-name', d.name);
    name.title = d.name;
    top.append(name);
    if (d.canCancel || d.state === 'failed') {
      const b = el('button', 'small ghost', d.state === 'failed' ? 'Dismiss' : 'Cancel');
      b.addEventListener('click', () => (d.state === 'failed' ? api.dismissDownload(d.id) : api.cancelDownload(d.id)));
      top.append(b);
    }
    row.append(top);
    if (d.state === 'downloading' || d.state === 'installing') {
      const known = d.state === 'downloading' && d.total > 0;
      const bar = el('div', `download-bar${known ? '' : ' busy'}`);
      const fill = el('i');
      if (known) fill.style.width = `${Math.min(100, (d.received / d.total) * 100)}%`;
      bar.append(fill);
      row.append(bar);
    }
    const note =
      d.state === 'downloading' ? (d.total ? `${Math.floor((d.received / d.total) * 100)}%  ·  ${mbs(d.received)} of ${mbs(d.total)} MB` : d.received ? `${mbs(d.received)} MB so far` : 'Downloading…')
      : d.state === 'waiting' ? 'Downloaded. Confirm the install in the browser window.'
      : d.state === 'installing' ? d.note || 'Checking and installing…'
      : d.state === 'done' ? 'Installed' : d.note || 'Failed';
    row.append(el('div', 'download-note', note));
    tray.append(row);
  }
});

api.on('installed', (r) => {
  if (r.error) toast(`${r.filename}: ${r.error}`, true);
  else {
    r.done.forEach(log);
    toast(`Installed ${r.filename}`);
  }
  refresh();
});
api.on('auto-synced', (summary) => {
  summary.forEach(log);
  toast('Your mods were updated to match the server');
  refresh();
});
api.on('state-changed', refresh);

// ---------- colour theme (hue picker, bottom-left; same as Server Forge) ----------

const DEFAULT_HUE = 214; // Forge blue; existing saved choices are kept.
const PRESET_HUES = [214, 32, 0, 50, 95, 145, 185, 265, 300, 330];
let logoImage = null;

function loadHue() {
  try {
    const v = localStorage.getItem('tcmm-hue');
    return v !== null && Number.isFinite(Number(v)) ? Number(v) : DEFAULT_HUE;
  } catch {
    return DEFAULT_HUE;
  }
}

/** The logo recoloured to the hue, for the window/taskbar icon. */
async function recolouredIcon(hue) {
  if (!logoImage) {
    logoImage = new Image();
    logoImage.src = 'icon.png';
    await logoImage.decode();
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 256;
  const ctx = canvas.getContext('2d');
  ctx.filter = `hue-rotate(${hue - DEFAULT_HUE}deg)`;
  ctx.drawImage(logoImage, 0, 0, 256, 256);
  return canvas.toDataURL('image/png');
}

let iconTimer;
function applyHue(hue, save = true) {
  document.documentElement.style.setProperty('--hue', String(hue));
  $('themeHue').value = String(hue);
  if (save) {
    try {
      localStorage.setItem('tcmm-hue', String(hue));
    } catch {}
  }
  clearTimeout(iconTimer);
  iconTimer = setTimeout(async () => {
    try {
      api.setIcon(await recolouredIcon(hue));
    } catch {}
  }, 250);
}

for (const hue of PRESET_HUES) {
  const b = el('button');
  b.type = 'button';
  b.title = hue === DEFAULT_HUE ? 'Forge blue' : hue === 32 ? 'Amber' : `Hue ${hue}`;
  b.style.background = `hsl(${hue} 84% 55%)`;
  b.addEventListener('click', () => applyHue(hue));
  $('themeSwatches').appendChild(b);
}
$('themeHue').addEventListener('input', () => applyHue(Number($('themeHue').value)));
$('themeReset').addEventListener('click', () => applyHue(DEFAULT_HUE));
$('btnTheme').addEventListener('click', (e) => {
  e.stopPropagation();
  $('themePop').hidden = !$('themePop').hidden;
  $('btnTheme').setAttribute('aria-expanded', String(!$('themePop').hidden));
});
document.addEventListener('click', (e) => {
  if (!$('themePop').hidden && !e.target.closest('.theme-corner')) {
    $('themePop').hidden = true;
    $('btnTheme').setAttribute('aria-expanded', 'false');
  }
});
applyHue(loadHue(), false);

renderTabs();
refresh();
