// The AI view: the SF Assistant (chat sessions), the player helper and AI accounts. Shared by Classic and Neon UI.
// Uses window.sf from app.js (api, toast, el, confirmBox, state).
const $ = (id) => document.getElementById(id);
const sf = () => window.sf;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const ai = {
  info: null, // GET /api/ai
  tab: 'chat',
  sessions: [],
  current: null, // session view
  helperServer: null,
  helper: null,
};

// ---------- small helpers ----------

/** Inline markdown on already-escaped text: code, bold, links. */
const inline = (s) =>
  s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

/** Very small markdown: code blocks, tables, headings, bullet lines, inline code, bold, links. */
function md(text) {
  const parts = String(text ?? '').split(/```[\w-]*\n?/);
  return parts
    .map((p, i) => {
      if (i % 2) return `<pre class="ai-code">${esc(p.replace(/\n$/, ''))}</pre>`;
      const lines = p.split('\n');
      const out = [];
      for (let j = 0; j < lines.length; j++) {
        // A table: a | row, then a |---| row.
        if (/^\s*\|.*\|\s*$/.test(lines[j]) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[j + 1] ?? '')) {
          const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => inline(esc(c.trim())));
          const head = cells(lines[j]);
          const rows = [];
          j += 2;
          while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) rows.push(cells(lines[j++]));
          j--;
          out.push(`<table class="ai-table"><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
          continue;
        }
        const h = /^#{1,4}\s+(.*)$/.exec(lines[j]);
        if (h) {
          out.push(`<b class="ai-h">${inline(esc(h[1]))}</b>`);
          continue;
        }
        out.push(inline(esc(lines[j]).replace(/^(\s*)[-*] /, '$1• ')) + '<br>');
      }
      return out.join('').replace(/(<br>)+$/, '');
    })
    .join('');
}

const time = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const engineName = (e) => (e === 'codex' ? 'ChatGPT' : 'Claude');

function serverOptions(selected, { none = 'All servers' } = {}) {
  const list = [...sf().state.servers.values()].filter((s) => !s.archivedAt).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return [`<option value="">${esc(none)}</option>`, ...list.map((s) => `<option value="${esc(s.id)}"${s.id === selected ? ' selected' : ''}>${esc(s.name)}${s.node?.name ? ` (${esc(s.node.name)})` : ''}</option>`)].join('');
}

function accountOptions(selected, { blank = null } = {}) {
  const accts = ai.info?.accounts ?? [];
  return [blank != null ? `<option value="">${esc(blank)}</option>` : '', ...accts.map((a) => `<option value="${esc(a.id)}"${a.id === selected ? ' selected' : ''}>${esc(a.name)}${a.loggedIn === false ? ' (signed out)' : ''}</option>`)].join('');
}

function modelOptions(engine, selected) {
  const list = (engine === 'codex' ? ai.info?.models?.codex : ai.info?.models?.claude) ?? [{ id: 'default', name: 'Default' }];
  const ids = list.map((m) => m.id);
  const extra = selected && !ids.includes(selected) ? [`<option selected>${esc(selected)}</option>`] : [];
  return [...extra, ...list.map((m) => `<option value="${esc(m.id)}"${m.id === selected ? ' selected' : ''}>${esc(m.name)}</option>`)].join('');
}

function limitBars(limits, maxShort, maxLong) {
  if (!limits?.length) return '';
  return limits
    .map((l) => {
      const cap = (l.windowHours ?? 999) <= 6 ? maxShort : maxLong;
      const over = cap != null && l.percent >= cap;
      return `<div class="ai-limit${over ? ' over' : ''}" title="${l.resetsAt ? `Resets ${esc(new Date(l.resetsAt).toLocaleString())}` : ''}"><span>${esc(l.label)}: <b>${Math.round(l.percent)}%</b>${cap != null ? ` · pauses at ${cap}%` : ''}</span><i><s style="width:${Math.min(100, l.percent)}%"></s>${cap != null ? `<u style="left:${cap}%"></u>` : ''}</i></div>`;
    })
    .join('');
}

// ---------- opening the view ----------

async function loadInfo() {
  ai.info = await sf().api('GET', '/api/ai');
  $('btnAi').hidden = !(ai.info.canUse || ai.info.canManage);
  $('aiSettingsToggle').checked = !!ai.info.enabled;
  return ai.info;
}

async function open(tab) {
  sf().leaveOtherViews();
  $('aiView').hidden = false;
  await loadInfo();
  if (!ai.info.canManage && tab !== 'chat') tab = 'chat';
  showTab(tab ?? ai.tab);
}

function showTab(tab) {
  ai.tab = tab;
  for (const b of document.querySelectorAll('#aiTabs [data-aitab]')) {
    b.classList.toggle('active', b.dataset.aitab === tab);
    if (b.hasAttribute('data-aimanage')) b.hidden = !ai.info?.canManage;
  }
  const off = !ai.info?.enabled;
  $('aiOff').hidden = !(off && tab !== 'accounts');
  $('aiOffText').textContent = ai.info?.canManage ? 'Turn them on to chat with Claude or ChatGPT here and to use the player helper.' : 'The owner can turn them on in Settings → AI.';
  $('btnAiTurnOn').hidden = !ai.info?.canManage;
  $('aiChatPane').hidden = tab !== 'chat' || off || !ai.info?.canUse;
  $('aiHelperPane').hidden = tab !== 'helper' || off;
  $('aiAccountsPane').hidden = tab !== 'accounts';
  if (tab === 'chat' && !off && ai.info?.canUse) loadSessions();
  if (tab === 'helper' && !off) renderHelperPicker();
  if (tab === 'accounts') renderAccounts();
}

// ---------- assistant ----------

async function loadSessions(selectId) {
  const r = await sf().api('GET', '/api/ai/sessions');
  ai.sessions = r.sessions;
  renderSessionList();
  const id = selectId ?? ai.current?.id ?? ai.sessions[0]?.id;
  if (id && ai.sessions.some((s) => s.id === id)) await openSession(id);
  else renderChat();
}

function renderSessionList() {
  const box = $('aiSessionList');
  box.innerHTML = ai.sessions.length
    ? ai.sessions
        .map((s) => `<button class="ai-session${s.id === ai.current?.id ? ' active' : ''}" data-sid="${esc(s.id)}"><b>${esc(s.title)}</b><span class="muted small-text">${s.busy ? '● working… · ' : ''}${esc(s.serverName ?? 'All servers')} · ${esc(new Date(s.updatedAt).toLocaleDateString())}</span></button>`)
        .join('')
    : '<p class="muted small-text">No chats yet.</p>';
}

async function openSession(id) {
  ai.current = await sf().api('GET', `/api/ai/sessions/${id}`);
  renderSessionList();
  renderChat();
}

function renderChat() {
  const s = ai.current;
  $('aiChatHead').hidden = !s;
  $('aiForm').hidden = !s;
  $('aiEmpty').hidden = !!s;
  if (!s) {
    $('aiMessages').querySelectorAll('.ai-msg').forEach((n) => n.remove());
    $('aiLimits').innerHTML = '';
    return;
  }
  if (document.activeElement !== $('aiTitle')) $('aiTitle').value = s.title;
  $('aiAccount').innerHTML = accountOptions(s.accountId, { blank: s.accountId ? null : 'Pick an account' });
  const acct = ai.info.accounts.find((a) => a.id === s.accountId);
  $('aiModel').innerHTML = modelOptions(acct?.engine, s.model);
  $('aiEffort').value = s.effort;
  $('aiServer').innerHTML = serverOptions(s.serverId);
  if (s.serverId && ![...$('aiServer').options].some((o) => o.value === s.serverId)) $('aiServer').insertAdjacentHTML('beforeend', `<option value="${esc(s.serverId)}" selected>${esc(s.serverName ?? s.serverId)}</option>`);
  const box = $('aiMessages');
  box.querySelectorAll('.ai-msg').forEach((n) => n.remove());
  for (const m of s.list) box.appendChild(messageNode(m));
  box.scrollTop = box.scrollHeight;
  setBusy(s.busy);
  renderLimits();
}

function renderLimits() {
  const s = ai.current;
  const acct = s && ai.info.accounts.find((a) => a.id === s.accountId);
  const st = ai.info.settings ?? {};
  $('aiLimits').innerHTML = acct ? `<span>${esc(acct.name)}</span>${limitBars(acct.limits, st.maxShort, st.maxLong)}` : '';
}

function messageNode(m) {
  const n = document.createElement('div');
  n.className = `ai-msg ${m.role}${m.isError ? ' failed' : ''}`;
  if (m.role === 'tool') {
    const input = m.input && Object.keys(m.input).length ? JSON.stringify(m.input) : '';
    n.innerHTML = `<details><summary><span class="ai-tool-name">${esc(m.tool)}</span> <span class="muted">${esc(input.slice(0, 140))}</span>${m.text ? (m.isError ? ' <b class="ai-tool-bad">failed</b>' : ' <span class="ai-tool-ok">✓</span>') : ' <span class="muted">…</span>'}</summary><pre class="ai-code">${esc(m.text || 'Working…')}</pre></details>`;
  } else if (m.role === 'user') n.innerHTML = `<div class="ai-bubble">${esc(m.text).replace(/\n/g, '<br>')}</div><span class="ai-meta">${esc(m.by ?? '')} · ${time(m.t)}</span>`;
  else if (m.role === 'assistant') n.innerHTML = `<div class="ai-bubble">${md(m.text)}</div>`;
  else n.innerHTML = `<div class="ai-note">${esc(m.text)}</div>`;
  return n;
}

function setBusy(busy) {
  $('btnAiSend').hidden = !!busy;
  $('btnAiStop').hidden = !busy;
  $('aiText').disabled = false;
  for (const id of ['aiAccount', 'aiModel', 'aiEffort', 'aiServer', 'btnAiClear']) $(id).disabled = !!busy;
  let w = $('aiWorking');
  if (busy && !w) {
    w = document.createElement('div');
    w.id = 'aiWorking';
    w.className = 'ai-msg working';
    w.innerHTML = '<div class="ai-note"><span class="ai-dots"><i></i><i></i><i></i></span> Working…</div>';
    $('aiMessages').appendChild(w);
    $('aiMessages').scrollTop = $('aiMessages').scrollHeight;
  } else if (!busy && w) w.remove();
}

async function sendMessage() {
  const text = $('aiText').value.trim();
  if (!text || !ai.current) return;
  $('aiText').value = '';
  setBusy(true);
  try {
    await sf().api('POST', `/api/ai/sessions/${ai.current.id}/message`, { text });
  } catch (err) {
    $('aiText').value = text;
    setBusy(false);
    sf().toast(err.message, true);
  }
}

async function patchSession(patch) {
  if (!ai.current) return;
  try {
    await sf().api('PUT', `/api/ai/sessions/${ai.current.id}`, patch);
    await openSession(ai.current.id);
    loadSessions(ai.current.id);
  } catch (err) {
    sf().toast(err.message, true);
    renderChat();
  }
}

function onAiEvent(e) {
  if (e.kind === 'session') {
    const i = ai.sessions.findIndex((s) => s.id === e.session.id);
    if (i >= 0) ai.sessions[i] = e.session;
    renderSessionList();
  }
  if (!ai.current || e.sessionId !== ai.current.id || $('aiView').hidden) return;
  const box = $('aiMessages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  if (e.kind === 'message') {
    ai.current.list.push(e.message);
    const w = $('aiWorking');
    box.insertBefore(messageNode(e.message), w ?? null);
  } else if (e.kind === 'tool_done') {
    ai.current.list[e.index] = e.message;
    const nodes = box.querySelectorAll('.ai-msg:not(.working)');
    if (nodes[e.index]) nodes[e.index].replaceWith(messageNode(e.message));
  } else if (e.kind === 'session') {
    Object.assign(ai.current, e.session);
    setBusy(e.session.busy);
  } else if (e.kind === 'done') {
    setBusy(false);
    loadInfo().then(renderLimits).catch(() => {});
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

// ---------- accounts & settings ----------

function renderAccounts() {
  const i = ai.info;
  const st = i.settings ?? {};
  $('aiEnabled').checked = !!i.enabled;
  $('aiEnabled').disabled = !i.canManage;
  $('aiWho').value = st.who ?? 'admins';
  $('aiMaxShort').value = st.maxShort ?? 80;
  $('aiMaxLong').value = st.maxLong ?? 80;
  $('aiDefault').innerHTML = accountOptions(st.defaultAccount, { blank: 'First account' });
  const notes = [];
  if (!i.engines.claude.installed) notes.push('Claude needs Claude Code installed on the system running Server Forge (claude.com/claude-code).');
  if (!i.engines.codex.installed) notes.push('ChatGPT needs OpenAI Codex installed on the system running Server Forge (the Codex app, or npm install -g @openai/codex).');
  $('aiEngineNote').textContent = notes.join(' ');
  $('btnAddClaude').disabled = $('btnAddClaudeSys').disabled = !i.engines.claude.installed;
  $('btnAddChatgpt').disabled = $('btnAddCodexSys').disabled = !i.engines.codex.installed;
  $('aiAccountList').innerHTML = i.accounts.length
    ? i.accounts
        .map(
          (a) => `<div class="ai-account" data-aid="${esc(a.id)}">
      <div class="ai-account-main"><b>${esc(a.name)}</b> <span class="ai-badge ${a.engine}">${engineName(a.engine)}</span>
        <div class="muted small-text">${a.signingIn ? 'Waiting for the sign-in in the browser…' : a.loggedIn ? `Signed in${a.email ? ` as ${esc(a.email)}` : ''}${a.plan ? ` · ${esc(a.plan)}` : ''}` : a.loggedIn === false ? `<span class="error">Not signed in</span>` : 'Checking…'}${a.system ? " · this system's own sign-in" : ''}${a.error && !a.loggedIn ? ` · ${esc(a.error)}` : ''}</div>
        ${a.signingIn && a.authUrl ? `<div class="small-text">Browser didn't open? <a href="${esc(a.authUrl)}" target="_blank" rel="noopener">Open the sign-in page</a></div>` : ''}
        ${limitBars(a.limits, st.maxShort, st.maxLong)}</div>
      <div class="ai-account-actions">
        ${a.system ? '' : `<button class="small" data-act="login">${a.loggedIn ? 'Sign in again' : 'Sign in'}</button>`}
        <button class="small ghost" data-act="refresh">Check</button>
        <button class="small ghost" data-act="rename">Rename</button>
        <button class="small red ghost" data-act="remove">Remove</button>
      </div></div>`,
        )
        .join('')
    : '<p class="muted small-text">No accounts yet.</p>';
  $('aiMcpUrl').textContent = `${location.origin}/mcp`;
  $('aiMcpExample').textContent = `Claude Code:\n  claude mcp add --transport http server-forge ${location.origin}/mcp --header "Authorization: Bearer th_…"\n\nOther apps (JSON config):\n  { "mcpServers": { "server-forge": { "type": "http", "url": "${location.origin}/mcp", "headers": { "Authorization": "Bearer th_…" } } } }`;
}

async function addAccount(engine, system) {
  try {
    const r = await sf().api('POST', '/api/ai/accounts', { engine, system });
    if (r.signIn?.authUrl) window.open(r.signIn.authUrl, '_blank', 'noopener');
    if (r.signIn?.error) sf().toast(r.signIn.error, true);
    else if (r.signIn?.window) sf().toast('A Claude Code sign-in window opened on this system. Finish signing in in the browser.');
    else if (system) sf().toast(r.account?.loggedIn ? 'Added.' : "Added, but it isn't signed in on this system.", !r.account?.loggedIn);
    await loadInfo();
    renderAccounts();
  } catch (err) {
    sf().toast(err.message, true);
  }
}

async function accountAction(id, act) {
  try {
    if (act === 'login') {
      const r = await sf().api('POST', `/api/ai/accounts/${id}/login`);
      if (r.authUrl) window.open(r.authUrl, '_blank', 'noopener');
      else sf().toast('A Claude Code sign-in window opened on this system. Finish signing in in the browser.');
    } else if (act === 'refresh') await sf().api('POST', `/api/ai/accounts/${id}/refresh`);
    else if (act === 'rename') {
      const a = ai.info.accounts.find((x) => x.id === id);
      const name = await sf().ask('Name for this account:', a?.name ?? '');
      if (!name) return;
      await sf().api('PUT', `/api/ai/accounts/${id}`, { name });
    } else if (act === 'remove') {
      if (!(await sf().confirmBox('Remove this account from Server Forge? Its sign-in here is removed too (this system\'s own Claude Code / Codex sign-in is left alone).', 'Remove'))) return;
      await sf().api('DELETE', `/api/ai/accounts/${id}`);
    }
    await loadInfo();
    renderAccounts();
  } catch (err) {
    sf().toast(err.message, true);
  }
}

async function saveSettings(patch) {
  try {
    await sf().api('PUT', '/api/ai/settings', patch);
    await loadInfo();
    if (!$('aiView').hidden) showTab(ai.tab);
    sf().toast('Saved.');
  } catch (err) {
    sf().toast(err.message, true);
  }
}

// ---------- player helper ----------

const LEVEL = { player: 'Player', read: 'Staff (read-only)', full: 'Staff (full)', owner: 'Owner (no restrictions)' };

function renderHelperPicker() {
  const bedrock = [...sf().state.servers.values()].filter((s) => s.game === 'bedrock' && !String(s.id).startsWith('n~') && !s.archivedAt);
  $('hlpServer').innerHTML = bedrock.length ? bedrock.map((s) => `<option value="${esc(s.id)}"${s.id === ai.helperServer ? ' selected' : ''}>${esc(s.name)}</option>`).join('') : '<option value="">No Bedrock servers on this system</option>';
  ai.helperServer = bedrock.some((s) => s.id === ai.helperServer) ? ai.helperServer : (bedrock[0]?.id ?? null);
  if (ai.helperServer) $('hlpServer').value = ai.helperServer;
  loadHelper();
}

async function loadHelper() {
  $('hlpBody').hidden = !ai.helperServer;
  if (!ai.helperServer) return;
  try {
    ai.helper = await sf().api('GET', `/api/ai/helper/${ai.helperServer}`);
    renderHelper(true);
  } catch (err) {
    sf().toast(err.message, true);
  }
}

function renderHelper(all = false) {
  const st = ai.helper;
  if (!st) return;
  const c = st.config;
  $('hlpEnabled').checked = !!c.enabled;
  const s = $('hlpStatus');
  s.className = `hlp-status ${st.status.state}`;
  s.textContent = `${st.status.state}${st.status.detail ? `: ${st.status.detail}` : ''}${st.busy ? ' · answering…' : ''}${st.queue ? ` · ${st.queue} waiting` : ''}`;
  $('hlpStats').innerHTML = [`${st.stats.questions} questions`, `${st.stats.replies} replies`, `${st.stats.commands} commands`, `${st.stats.blocked} refused`, `${st.stats.alerts} alerts`].map((x) => `<span>${esc(x)}</span>`).join(' · ') + ' (since Server Forge started)';
  $('hlpPending').innerHTML = st.pending.map((p) => `Waiting for ${esc(p.who)} to confirm: <code>${esc(p.command)}</code>`).join('<br>');
  const keep = (id, v) => {
    if (all || document.activeElement !== $(id)) $(id).value = v ?? '';
  };
  if (all) {
    $('hlpAccount').innerHTML = accountOptions(c.account, { blank: 'Pick an account' });
    $('hlpBkAccount').innerHTML = accountOptions(c.backup?.account ?? '', { blank: 'None' });
    const eng = (id) => ai.info.accounts.find((a) => a.id === id)?.engine;
    $('hlpModel').innerHTML = modelOptions(eng(c.account), c.model);
    $('hlpBkModel').innerHTML = modelOptions(eng(c.backup?.account), c.backup?.model ?? 'default');
    keep('hlpEffort', c.effort);
    keep('hlpMax5', c.maxFiveHour);
    keep('hlpMaxW', c.maxWeekly);
    keep('hlpTrigger', c.trigger);
    keep('hlpName', c.botName);
    keep('hlpCooldown', c.cooldownSec);
    keep('hlpTags', c.staffTags.join(', '));
    keep('hlpStaff', c.staff.map((p) => [p.name, p.xuid, p.level, p.role ?? ''].join(', ').replace(/, $/, '')).join('\n'));
    keep('hlpFacts', c.facts.join('\n'));
    keep('hlpDcKey', c.discord.keyId);
    keep('hlpDcOwners', c.discord.owners.map((o) => o.id).join(', '));
    keep('hlpDcStaff', c.discord.staff.map((x) => `${x.id} = ${x.name}`).join('\n'));
  }
  $('hlpUsage').innerHTML = [c.account, c.backup?.account]
    .filter(Boolean)
    .map((id, i) => {
      const a = ai.info.accounts.find((x) => x.id === id);
      return a ? `<div class="small-text"><b>${i ? 'Backup' : 'Main'}:</b> ${esc(a.name)}</div>${limitBars(a.limits, c.maxFiveHour, c.maxWeekly)}` : '';
    })
    .join('');
  $('hlpDcSeen').innerHTML = st.discordSenders?.length ? st.discordSenders.map((x) => `<code>${esc(x.name)}: ${esc(x.id)}</code>`).join(' ') : 'none yet';
  if (all) {
    $('hlpRude').innerHTML = Object.entries(st.rudeModes ?? {}).map(([v, label]) => `<option value="${esc(v)}">${esc(label)}</option>`).join('');
    $('hlpRude').value = c.whenRude ?? 'polite';
    $('hlpRoastSwear').checked = !!c.roastSwearing;
    $('hlpListAddons').checked = c.listAddons !== false;
    $('hlpAudience').value = c.audience ?? 'asker';
    keep('hlpPersonality', c.personality);
    keep('hlpRudeNotes', c.rudeNotes);
    keep('hlpReplyRules', c.replyRules);
    keep('hlpMaxChars', c.maxReplyChars);
    syncRudeRow();
  }
  renderDocs(st);
  renderHelperLog();
}

// ---------- personality ----------

const PERSONAS = {
  friendly: 'Warm, upbeat and patient, like a helpful staff member who loves this server. Explain things simply, and get excited when players discover something cool.',
  sassy: 'Confident and a little sassy: playful teasing, dry one-liners and the odd eye-roll, but you always give the real answer. Never mean to someone who is just asking for help.',
  pirate: "Talk like a cheerful pirate (\"arr\", \"matey\", \"ye\"), calling the server your ship and diamonds your treasure. Keep the pirate talk light so the actual answer stays easy to read.",
  formal: 'Polite, calm and professional, like a staff member on duty. Short, clear answers without jokes or slang.',
};

function syncRudeRow() {
  $('hlpRoastSwearRow').hidden = $('hlpRude').value !== 'roast';
}

// ---------- knowledge documents ----------

function renderDocs(st) {
  const body = $('hlpDocs');
  const docs = st.knowledge ?? [];
  $('hlpDocCount').textContent = docs.length ? `(${docs.length})` : '';
  if (!docs.length) {
    body.innerHTML = '<tr><td colspan="5" class="muted">No documents yet. Add one per add-on, rank list, menu or rule set, so the helper answers from your server instead of guessing.</td></tr>';
    return;
  }
  body.innerHTML = docs
    .map((d) => {
      const long = d.size > st.docLimit;
      return `<tr data-doc="${esc(d.id)}">
        <td><b>${esc(d.title)}</b>${d.about ? `<div class="muted small-text">${esc(d.about)}</div>` : ''}</td>
        <td><span class="kind ${d.level === 'staff' ? 'before-restore' : 'manual'}">${d.level === 'staff' ? 'Staff only' : 'Public'}</span></td>
        <td class="${long ? 'warn-text' : ''}" title="${long ? `The helper reads the first ${st.docLimit.toLocaleString()} characters: split this one up.` : ''}">${(d.size / 1024).toFixed(d.size < 10240 ? 1 : 0)} KB${long ? ' ⚠' : ''}</td>
        <td>${d.updated ? esc(new Date(d.updated).toLocaleDateString()) : ''}</td>
        <td class="actions"><button class="small" data-act="edit">Edit</button> <button class="small red ghost" data-act="delete">Delete</button></td>
      </tr>`;
    })
    .join('');
}

function openDocEditor(doc = null) {
  ai.docEditing = doc?.id ?? null;
  $('hlpDocEditor').hidden = false;
  $('hlpDocEditTitle').textContent = doc ? `Editing ${doc.id.split('/')[1]}` : 'New document';
  $('hlpDocName').value = doc ? doc.id.split('/')[1] : '';
  $('hlpDocLevel').value = doc?.id.startsWith('staff/') ? 'staff' : 'public';
  $('hlpDocText').value = doc?.content ?? '';
  docChars();
  $('hlpDocEditor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  (doc ? $('hlpDocText') : $('hlpDocName')).focus();
}

function closeDocEditor() {
  ai.docEditing = null;
  $('hlpDocEditor').hidden = true;
}

function docChars() {
  const n = $('hlpDocText').value.length;
  const limit = ai.helper?.docLimit ?? 14000;
  $('hlpDocChars').textContent = `${n.toLocaleString()} / ${limit.toLocaleString()} characters the helper reads`;
  $('hlpDocChars').className = `small-text ${n > limit ? 'warn-text' : 'muted'}`;
}

async function saveDoc() {
  const name = $('hlpDocName').value.trim();
  const level = $('hlpDocLevel').value;
  if (!name) return sf().toast('Give the document a name.', true);
  const safe = name.replace(/[^A-Za-z0-9 _.\-]/g, '').replace(/\.(md|txt)$/i, '');
  const newId = `${level}/${safe}`;
  if (!ai.docEditing || ai.docEditing !== newId) {
    if (ai.helper.knowledge.some((d) => d.id === newId) && !(await sf().confirmBox(`There's already a ${level === 'staff' ? 'staff' : 'public'} document called "${safe}". Replace it?`, 'Replace'))) return;
  }
  try {
    ai.helper = await sf().api('PUT', `/api/ai/helper/${ai.helperServer}/docs`, { name, level, content: $('hlpDocText').value });
    // Renamed or moved to the other level: the old file goes.
    if (ai.docEditing && ai.docEditing !== newId) ai.helper = await sf().api('DELETE', `/api/ai/helper/${ai.helperServer}/docs?doc=${encodeURIComponent(ai.docEditing)}`);
    closeDocEditor();
    renderHelper();
    sf().toast('Document saved.');
  } catch (err) {
    sf().toast(err.message, true);
  }
}

async function uploadDocs(files) {
  let saved = 0;
  for (const f of files) {
    if (!/\.(md|txt)$/i.test(f.name)) {
      sf().toast(`${f.name}: only .md and .txt files.`, true);
      continue;
    }
    if (f.size > 100_000) {
      sf().toast(`${f.name} is larger than 100 KB: split it into smaller documents.`, true);
      continue;
    }
    try {
      ai.helper = await sf().api('PUT', `/api/ai/helper/${ai.helperServer}/docs`, { name: f.name, level: 'public', content: await f.text() });
      saved++;
    } catch (err) {
      sf().toast(`${f.name}: ${err.message}`, true);
    }
  }
  renderHelper();
  if (saved) sf().toast(`Added ${saved} document${saved === 1 ? '' : 's'} as Public. Edit one to make it staff-only.`);
}

function renderHelperLog() {
  const only = $('hlpOnlyAlerts').checked;
  const rows = (ai.helper?.log ?? []).filter((e) => !only || ['alert', 'blocked', 'error'].includes(e.kind)).slice(-150).reverse();
  $('hlpLog').innerHTML = rows.length
    ? rows
        .map((e) => {
          const who = e.player ? `${e.player}${e.level ? ` · ${LEVEL[e.level] ?? e.level}` : ''}: ` : '';
          const extra = (e.checks?.length ? ` [${e.checks.join(', ')}]` : '') + (e.via ? ` (${e.via})` : '');
          return `<div class="hlp-e ${esc(e.kind)}${e.dry ? ' dry' : ''}"><span>${esc(new Date(e.t).toLocaleTimeString())}</span><span class="k">${esc(e.kind)}${e.dry ? ' (test)' : ''}</span><span>${esc(who + (e.text ?? '') + extra)}</span></div>`;
        })
        .join('')
    : '<div class="muted small-text">Nothing yet.</div>';
}

async function saveHelper(patch, msg = 'Saved.') {
  try {
    ai.helper = await sf().api('PUT', `/api/ai/helper/${ai.helperServer}`, patch);
    renderHelper(true);
    if (msg) sf().toast(msg);
  } catch (err) {
    sf().toast(err.message, true);
    loadHelper();
  }
}

// ---------- wiring ----------

function wire() {
  if (!window.sf) return setTimeout(wire, 50);
  $('btnAi').addEventListener('click', () => open('chat'));
  $('btnCloseAi').addEventListener('click', () => sf().backToServers());
  for (const b of document.querySelectorAll('#aiTabs [data-aitab]')) b.addEventListener('click', () => showTab(b.dataset.aitab));
  $('btnAiTurnOn').addEventListener('click', () => saveSettings({ enabled: true }));
  $('aiSettingsToggle').addEventListener('change', () => saveSettings({ enabled: $('aiSettingsToggle').checked }));
  $('btnAiOpenFromSettings').addEventListener('click', () => open('accounts'));

  $('btnAiNew').addEventListener('click', async () => {
    try {
      const s = await sf().api('POST', '/api/ai/sessions', { serverId: sf().state.selected ?? undefined });
      await loadSessions(s.id);
      $('aiText').focus();
    } catch (err) {
      sf().toast(err.message, true);
    }
  });
  $('aiSessionList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sid]');
    if (b) openSession(b.dataset.sid).catch((err) => sf().toast(err.message, true));
  });
  $('aiForm').addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage();
  });
  $('aiText').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!$('btnAiSend').hidden) sendMessage();
    }
  });
  $('btnAiStop').addEventListener('click', () => ai.current && sf().api('POST', `/api/ai/sessions/${ai.current.id}/stop`).catch((err) => sf().toast(err.message, true)));
  $('aiTitle').addEventListener('change', () => patchSession({ title: $('aiTitle').value }));
  $('aiAccount').addEventListener('change', () => patchSession({ accountId: $('aiAccount').value, model: 'default' }));
  $('aiModel').addEventListener('change', () => patchSession({ model: $('aiModel').value }));
  $('aiEffort').addEventListener('change', () => patchSession({ effort: $('aiEffort').value }));
  $('aiServer').addEventListener('change', () => {
    const o = $('aiServer').selectedOptions[0];
    patchSession({ serverId: $('aiServer').value || null, serverName: o?.textContent ?? '' });
  });
  $('btnAiClear').addEventListener('click', async () => {
    try {
      await sf().api('POST', `/api/ai/sessions/${ai.current.id}/clear`);
      await openSession(ai.current.id);
    } catch (err) {
      sf().toast(err.message, true);
    }
  });
  $('btnAiDelete').addEventListener('click', async () => {
    if (!ai.current || !(await sf().confirmBox(`Delete the chat "${ai.current.title}"?`, 'Delete'))) return;
    await sf().api('DELETE', `/api/ai/sessions/${ai.current.id}`).catch((err) => sf().toast(err.message, true));
    ai.current = null;
    loadSessions();
  });

  $('btnAiSaveSettings').addEventListener('click', () => saveSettings({ enabled: $('aiEnabled').checked, who: $('aiWho').value, maxShort: Number($('aiMaxShort').value), maxLong: Number($('aiMaxLong').value), defaultAccount: $('aiDefault').value || null }));
  $('aiEnabled').addEventListener('change', () => saveSettings({ enabled: $('aiEnabled').checked }));
  $('btnAddClaude').addEventListener('click', () => addAccount('claude', false));
  $('btnAddChatgpt').addEventListener('click', () => addAccount('codex', false));
  $('btnAddClaudeSys').addEventListener('click', () => addAccount('claude', true));
  $('btnAddCodexSys').addEventListener('click', () => addAccount('codex', true));
  $('aiAccountList').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) accountAction(b.closest('[data-aid]').dataset.aid, b.dataset.act);
  });

  $('hlpServer').addEventListener('change', () => {
    ai.helperServer = $('hlpServer').value;
    loadHelper();
  });
  $('hlpEnabled').addEventListener('change', () => saveHelper({ enabled: $('hlpEnabled').checked }, $('hlpEnabled').checked ? 'Player helper is on.' : 'Player helper is off.'));
  for (const [sel, model] of [['hlpAccount', 'hlpModel'], ['hlpBkAccount', 'hlpBkModel']]) {
    $(sel).addEventListener('change', () => {
      const eng = ai.info.accounts.find((a) => a.id === $(sel).value)?.engine;
      $(model).innerHTML = modelOptions(eng, 'default');
    });
  }
  $('hlpSave').addEventListener('click', () =>
    saveHelper({
      account: $('hlpAccount').value || null,
      model: $('hlpModel').value,
      effort: $('hlpEffort').value,
      backup: $('hlpBkAccount').value ? { account: $('hlpBkAccount').value, model: $('hlpBkModel').value, effort: $('hlpEffort').value } : null,
      maxFiveHour: Number($('hlpMax5').value),
      maxWeekly: Number($('hlpMaxW').value),
      trigger: $('hlpTrigger').value,
      botName: $('hlpName').value,
      prefix: `§b[${$('hlpName').value.trim() || 'Forge'}]§r `,
      cooldownSec: Number($('hlpCooldown').value),
    }),
  );
  $('hlpSaveStaff').addEventListener('click', () => {
    const staff = $('hlpStaff')
      .value.split('\n')
      .map((l) => l.split(',').map((x) => x.trim()))
      .filter((p) => p[0] && p[1])
      .map(([name, xuid, level, role]) => ({ name, xuid, level: /^full$/i.test(level ?? '') ? 'full' : 'read', role: role || undefined }));
    const owners = $('hlpDcOwners').value.split(/[\s,]+/).filter(Boolean).map((id) => ({ id }));
    const dstaff = $('hlpDcStaff').value.split('\n').map((l) => l.split('=').map((x) => x.trim())).filter(([id, name]) => id && name).map(([id, name]) => ({ id, name }));
    saveHelper({ staff, staffTags: $('hlpTags').value.split(/[\s,]+/).filter(Boolean), facts: $('hlpFacts').value.split('\n'), discord: { keyId: $('hlpDcKey').value, owners, staff: dstaff } }, null).then(() => {
      const got = ai.helper?.config.staff.length ?? 0;
      sf().toast(got < staff.length ? `Saved ${got} of ${staff.length} staff: check names and Xbox IDs (numbers only).` : `Saved ${got} staff.`, got < staff.length);
    });
  });
  $('hlpCheckGo').addEventListener('click', async () => {
    const name = $('hlpCheckWho').value.trim();
    if (!name) return;
    $('hlpCheckOut').textContent = 'Checking…';
    try {
      const r = await sf().api('POST', `/api/ai/helper/${ai.helperServer}/verify`, { name });
      $('hlpCheckOut').textContent = `${name}: ${LEVEL[r.level]} (${r.checks.join(', ')})`;
    } catch (err) {
      $('hlpCheckOut').textContent = `Failed: ${err.message}`;
    }
  });
  $('hlpDocs').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-act]');
    const row = e.target.closest('[data-doc]');
    if (!b || !row) return;
    const id = row.dataset.doc;
    try {
      if (b.dataset.act === 'edit') openDocEditor(await sf().api('GET', `/api/ai/helper/${ai.helperServer}/docs?doc=${encodeURIComponent(id)}`));
      else if (await sf().confirmBox(`Delete the document "${id.split('/')[1]}"? The helper stops using it straight away.`, 'Delete')) {
        ai.helper = await sf().api('DELETE', `/api/ai/helper/${ai.helperServer}/docs?doc=${encodeURIComponent(id)}`);
        if (ai.docEditing === id) closeDocEditor();
        renderHelper();
      }
    } catch (err) {
      sf().toast(err.message, true);
    }
  });
  $('hlpDocSave').addEventListener('click', saveDoc);
  $('hlpDocNew').addEventListener('click', () => openDocEditor());
  $('hlpDocCancel').addEventListener('click', closeDocEditor);
  $('hlpDocText').addEventListener('input', docChars);
  $('hlpDocUpload').addEventListener('click', () => $('hlpDocFiles').click());
  $('hlpDocFiles').addEventListener('change', async () => {
    const files = [...$('hlpDocFiles').files];
    $('hlpDocFiles').value = '';
    if (files.length) await uploadDocs(files);
  });
  for (const b of document.querySelectorAll('[data-persona]')) {
    b.addEventListener('click', async () => {
      if ($('hlpPersonality').value.trim() && !(await sf().confirmBox('Replace the personality text with this example?', 'Replace'))) return;
      $('hlpPersonality').value = PERSONAS[b.dataset.persona];
    });
  }
  $('hlpRude').addEventListener('change', syncRudeRow);
  $('hlpSaveStyle').addEventListener('click', () =>
    saveHelper(
      {
        personality: $('hlpPersonality').value,
        whenRude: $('hlpRude').value,
        roastSwearing: $('hlpRoastSwear').checked,
        rudeNotes: $('hlpRudeNotes').value,
        replyRules: $('hlpReplyRules').value,
        maxReplyChars: Number($('hlpMaxChars').value),
        listAddons: $('hlpListAddons').checked,
        audience: $('hlpAudience').value,
      },
      'Personality saved.',
    ),
  );
  const test = async () => {
    const q = $('hlpTestQ').value.trim();
    if (!q) return;
    const out = $('hlpTestOut');
    out.hidden = false;
    out.textContent = 'Asking…';
    $('hlpTestGo').disabled = true;
    try {
      const r = await sf().api('POST', `/api/ai/helper/${ai.helperServer}/test`, { who: $('hlpTestWho').value, level: $('hlpTestLevel').value, engine: $('hlpTestEngine').value || null, tags: $('hlpTestTags').value, text: q });
      out.textContent = r.reply ?? '(no reply: see Activity below)';
    } catch (err) {
      out.textContent = `Failed: ${err.message}`;
    } finally {
      $('hlpTestGo').disabled = false;
    }
  };
  $('hlpTestGo').addEventListener('click', test);
  $('hlpTestQ').addEventListener('keydown', (e) => e.key === 'Enter' && test());
  $('hlpOnlyAlerts').addEventListener('change', renderHelperLog);

  window.addEventListener('sf-ai', (e) => {
    const { type, data } = e.detail;
    if (type === 'ai') onAiEvent(data);
    else if (type === 'ai-accounts' && !$('aiView').hidden) {
      loadInfo().then(() => {
        if (ai.tab === 'accounts') renderAccounts();
        else if (ai.tab === 'chat') renderLimits();
      });
    } else if (type === 'ai-helper' && !$('aiView').hidden && ai.tab === 'helper' && data.serverId === ai.helperServer) {
      sf().api('GET', `/api/ai/helper/${ai.helperServer}`).then((st) => {
        ai.helper = st;
        renderHelper(false);
      });
    }
  });

  // Show the AI button once signed in (and keep it current).
  const tryInfo = () => {
    if (!sf().state.user) return setTimeout(tryInfo, 500);
    loadInfo().catch(() => setTimeout(tryInfo, 5000));
  };
  tryInfo();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
else wire();
