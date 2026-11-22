// The database page (docs/db-admin-tool-spec.md). Owner only: every function it calls refuses anyone else.
// Everything people wrote is drawn with textContent, never as HTML. The address names only the screen and the table,
// never an id, an email or search words (people and chats opened are held in memory).
'use strict';
(function () {
  const PROJECT = 'https://slzjsgvneuejncfveull.supabase.co';
  const KEY = 'sb_publishable_qox-597XKBQfi_zA0mbc2A_BRllX6t0'; // the app's public key, as in the app itself
  const IDLE_WARN_MS = 14 * 60 * 1000;
  const IDLE_OUT_MS = 15 * 60 * 1000;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const app = document.getElementById('app');
  if (window.top !== window.self) { app.textContent = 'This page does not run inside a frame.'; return; }

  const sb = window.supabase.createClient(PROJECT, KEY, {
    auth: { storage: window.sessionStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Small helpers

  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'disabled' || k === 'checked' || k === 'selected') e[k] = !!v;
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      e.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }
  const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };
  const fmtTime = (s) => {
    const d = new Date(s);
    if (isNaN(d)) return String(s);
    return d.toLocaleString('en-GB', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'short', year: 'numeric',
                                        hour: '2-digit', minute: '2-digit' });
  };
  const isTime = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(v);

  const MESSAGES = {
    only_owner: 'This page is for the owner only.',
    changed_meanwhile: 'It changed since you loaded it. Reload and try again.',
    wrong_value: 'That value isn\'t one the database accepts here.',
    not_editable: 'That can\'t be changed directly here.',
    report_needed: 'Deleted messages and earlier wordings open only from a report about that message or chat.',
    already_there: 'It\'s already on the list.',
    already_changed_back: 'That change was already changed back.',
    cannot_change_back: 'That can\'t be changed back.',
    one_chat_id: 'Give a chat id or a grown-ups\' chat id, not both.',
    no_row: 'That row isn\'t there any more.',
    no_file: 'No file there.',
    could_not_log: 'Nothing changed: the log couldn\'t be written. Try again.',
    could_not_delete: 'Stopped while deleting files. Try again: it finishes the job.',
    could_not_save: 'Stopped while saving. Try again.',
    not_the_owner: 'Staff actions stay off the owner and the owner\'s children.',
    not_yourself: 'Not on your own account.',
    session_ended: 'Your sign-in ended. Sign in again.',
    no_answer: 'No answer from the server. Look in the change log to see whether it happened before trying again.',
    report_not_about_this: 'That report is about another chat.',
  };
  function codeOf(message) {
    const m = String(message || '').match(/[a-z]+(_[a-z]+)+/);
    return m ? m[0] : String(message || 'failed');
  }
  const say = (code) => MESSAGES[code] || code;

  // Calls to the database carry x-kido-via: dbtool, so the Admin actions they run are marked in the log. Whether the
  // browser accepts that header is checked once, at start, with a call that changes nothing (start()). A call is never
  // sent twice by itself: after no answer, the log says whether it happened.
  let viaHeader = true;
  async function rpc(fn, args) {
    let q = sb.rpc(fn, args || {});
    if (viaHeader) q = q.setHeader('x-kido-via', 'dbtool');
    const { data, error } = await q;
    if (error && /fetch|network|load failed/i.test(error.message || '')) {
      throw new Error('no_answer');
    }
    if (error) {
      const code = codeOf(error.message);
      if (code === 'session_ended' || code === 'only_owner') signOut(say(code));
      throw new Error(code);
    }
    return data;
  }
  async function edge(body) {
    const { data, error } = await sb.functions.invoke('admin', {
      body, headers: { 'x-region': 'eu-central-1', 'x-kido-via': 'dbtool' },
    });
    if (error) {
      let code = 'failed';
      try { code = (await error.context.json()).error || code; } catch (_) { /* not JSON */ }
      throw new Error(code);
    }
    return data;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // State

  const state = {
    tables: [], byName: {}, settings: [], tv: {},          // table views: filters, order, offset
    personId: null, chatId: null, chatReport: null, chatAround: null, findId: null, searchText: '',
    busy: false, lastActivity: Date.now(), warned: false,
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Dialogs and toasts

  function dialog(title, body, buttons) {
    return new Promise((resolve) => {
      const close = (v) => { overlay.remove(); resolve(v); };
      const overlay = el('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true' },
        el('div', { class: 'dialog' }, el('h3', { text: title }), body,
          el('div', { class: 'buttons' }, buttons.map((b) =>
            el('button', { class: b.class, text: b.label, onclick: async () => {
              if (b.check) { const ok = await b.check(); if (!ok) return; }
              close(b.value);
            } })))));
      overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(null); });
      document.body.append(overlay);
      const first = overlay.querySelector('input, textarea, select, button.primary, button.danger');
      if (first) first.focus();
    });
  }
  async function confirmLines(title, lines, label, danger) {
    const body = el('div', { class: 'lines' }, (lines || []).map((l) => el('div', { text: l })));
    return (await dialog(title, body, [{ label: 'Cancel', value: false },
      { label: label || 'Go ahead', value: true, class: danger ? 'danger' : 'primary' }])) === true;
  }
  async function ask(title, label, initial, opts) {
    const input = opts && opts.multiline ? el('textarea', {}) : el('input', { type: 'text' });
    input.value = initial || '';
    const err = el('div', { class: 'err' });
    input.addEventListener('input', () => { err.textContent = ''; });
    const body = el('div', {}, opts && opts.hint ? el('div', { class: 'muted', text: opts.hint }) : null, input, err);
    const ok = await dialog(title, body, [{ label: 'Cancel', value: false },
      { label, value: true, class: opts && opts.danger ? 'danger' : 'primary', check: () => {
        const v = input.value.trim();
        if (!v) { err.textContent = 'Enter something first.'; return false; }
        if (opts && opts.must && v !== opts.must) { err.textContent = 'Type it exactly as shown.'; return false; }
        if (opts && opts.test && !opts.test(v)) { err.textContent = opts.testMessage || 'That doesn\'t look right.'; return false; }
        return true;
      } }]);
    return ok ? input.value.trim() : null;
  }
  function toast(text, kind) {
    const n = el('div', { class: 'note ' + (kind || ''), text });
    const main = document.querySelector('.main');
    if (main) main.prepend(n);
    setTimeout(() => n.remove(), 9000);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Running an action safely (spec section 7): preview, re-read, one at a time, retry, checks afterwards.

  function setBusy(b) {
    state.busy = b;
    document.querySelectorAll('button.act').forEach((x) => { x.disabled = b; });
  }
  // a = { label, danger, preview: {action, args} | null, lines: [], reread: async () => string, snapshot: string,
  //       run: async () => result, checks: [action names], after: () => void, askText: {must, hint} }
  // What an action is about, as the first line of its confirmation (OA, 22 Nov 2026: "Yes, add it"): the kind of
  // thing, a name the page already shows for it (a title, a nickname; never message text) and the start of its id.
  function targetOf(what, v) {
    v = v || {};
    const name = [v.title, v.real_name, v.display_name, v.name, v.key, v.label].find((x) => typeof x === 'string' && x && x.length <= 120);
    const id = [v.id, v.report_id, v.message_id, v.chat_id].find((x) => typeof x === 'string' && UUID.test(x));
    const extra = [v.is_group === true ? 'group' : null, v.kind && typeof v.kind === 'string' && v.kind.length <= 20 ? v.kind : null,
      v.created_at ? fmtTime(v.created_at) : null].filter(Boolean);
    return [what + (name ? ': ' + name : ''), ...extra, id ? 'id ' + id.slice(0, 8) + '…' : null].filter(Boolean).join(' · ');
  }

  async function runAction(a) {
    if (state.busy) return;
    let lines = (a.lines || []).slice();
    if (a.target) lines.unshift(a.target);
    try {
      if (a.preview) lines = lines.concat((await rpc('dbtool_preview', { p_action: a.preview.action, p_args: a.preview.args })).lines);
    } catch (e) { toast('Couldn\'t count what it would change: ' + say(e.message), 'bad'); return; }
    if (a.askText) {
      const typed = await ask(a.label, a.label, '', { must: a.askText.must, hint: lines.concat([a.askText.hint]).join(' '), danger: true });
      if (typed === null) return;
    } else if (!(await confirmLines(a.label, lines.length ? lines : ['Go ahead?'], a.label, a.danger))) return;
    if (a.reread && a.snapshot !== undefined) {
      try {
        const now = await a.reread();
        if (now !== a.snapshot) {
          if (!(await confirmLines('It changed since you loaded it', ['The row changed (in the app or another tab). Reload to see it, or go ahead anyway.'],
                                   'Go ahead anyway', a.danger))) { if (a.after) a.after(); return; }
        }
      } catch (_) { /* the action itself checks again */ }
    }
    setBusy(true);
    let failed = null;
    try { await a.run(); } catch (e) { failed = e.message; }
    setBusy(false);
    if (failed) {
      const retry = await dialog('It didn\'t finish', el('div', {}, el('div', { text: say(failed) }),
        el('div', { class: 'muted', text: 'The log says how far it got. Running it again finishes the job.' })),
        [{ label: 'Close', value: false }, { label: 'Try again', value: true, class: 'primary' }]);
      if (retry) { setBusy(true); try { await a.run(); failed = null; } catch (e) { failed = e.message; } setBusy(false); }
      if (failed) toast('Still not done: ' + say(failed), 'bad');
    }
    if (!failed) toast(a.label + ': done.', 'ok');
    if (a.checks && a.checks.length) {
      try {
        const res = await rpc('dbtool_consistency', { p_only: a.checks });
        const found = res.filter((r) => r.found > 0);
        toast(found.length ? 'Checks afterwards: ' + found.map((r) => r.what + ' (' + r.found + ')').join('; ')
                           : 'Checks afterwards: nothing wrong.', found.length ? 'warn' : 'ok');
      } catch (_) { /* the check is a courtesy */ }
    }
    if (a.after) a.after();
  }
  const actBtn = (label, handler, cls) => el('button', { class: 'act ' + (cls || ''), text: label, disabled: state.busy, onclick: handler });

  // ---------------------------------------------------------------------------------------------------------------
  // Showing values

  function namesNode(v, names) {
    const n = names && names[v];
    return n ? el('span', { class: 'cellname', text: n }) : null;
  }
  // A cell's value as shown (hidden and masked values as placeholders). onReveal(cellNode) shows a hidden value.
  function valueNode(v, names, onReveal) {
    if (v === null || v === undefined) return el('span', { class: 'muted', text: '—' });
    if (typeof v === 'object' && !Array.isArray(v) && v.hidden) {
      const label = v.hidden === 'text' ? '(text, ' + v.len + ' characters)' : '(' + ({ place: 'location', file: 'file', data: 'data' }[v.hidden] || v.hidden) + ')';
      const box = el('span', {}, el('span', { class: 'hidden-val', text: label }));
      if (onReveal) box.append(' ', el('button', { class: 'small', text: 'Show', title: 'Shows this one value; logged',
                                                     onclick: (e) => { e.stopPropagation(); onReveal(box, v.hidden); } }));
      return box;
    }
    if (typeof v === 'object' && !Array.isArray(v) && 'masked' in v && Object.keys(v).length === 1) {
      return el('span', { class: 'pill', text: v.masked ? 'set' : 'not set', title: 'A secret: never shown' });
    }
    if (Array.isArray(v)) {
      if (v.length === 0) return el('span', { class: 'muted', text: '[]' });
      return el('span', {}, v.map((x, i) => [i ? ', ' : '', typeof x === 'string' ? x : JSON.stringify(x), typeof x === 'string' ? namesNode(x, names) : null]));
    }
    if (typeof v === 'object') return el('span', { class: 'mono', text: JSON.stringify(v) });
    if (typeof v === 'boolean') return el('span', { text: v ? 'yes' : 'no' });
    if (isTime(v)) return el('span', { text: fmtTime(v), title: v });
    if (typeof v === 'string' && UUID.test(v)) return el('span', {}, el('span', { class: 'mono', text: v.slice(0, 8) + '…', title: v }), namesNode(v, names));
    return el('span', { text: String(v) });
  }
  function showRevealed(box, res) {
    clear(box);
    if (res.kind === 'file') {
      box.append(el('span', { class: 'pill logged', text: 'logged' }));
      return;
    }
    const v = res.value;
    box.append(el('span', { text: typeof v === 'string' ? v : JSON.stringify(v) }), ' ', el('span', { class: 'pill logged', text: 'logged' }));
  }
  // report: the report this reveal is for (a chat opened from a report). Earlier wordings ask for one.
  async function revealInto(box, table, key, column, kind, report) {
    try {
      if (table === 'message_versions' && !report) {
        report = await ask('Which report is this for?', 'Show', '', { test: (x) => UUID.test(x), testMessage: 'A report id like 0f1e…',
          hint: 'Deleted messages and earlier wordings open only from a report about that message or chat.' });
        if (report === null) return;
      }
      if (kind === 'file') {
        const r = await edge({ action: 'dbtool_file', table, key, column, report: report || null });
        clear(box);
        const name = String(column);
        // Shown in place, never as a link to open: a storage address (with ids in it) would stay in the history.
        const save = el('button', { class: 'small', text: 'Save the file', onclick: async (e) => {
          e.stopPropagation();
          try {
            const blob = await (await fetch(r.url)).blob();
            const a = el('a', { href: URL.createObjectURL(blob), download: name.replace(/_path$/, '') });
            document.body.append(a); a.click(); a.remove();
          } catch (_) { toast('The link has run out: show it again.', 'bad'); }
        } });
        const pv = el('div', { class: 'preview' });
        if (/strokes/.test(name)) { /* a drawing's strokes: save only */ }
        else if (/audio/.test(name)) pv.append(el('audio', { controls: true, src: r.url }));
        else pv.append(el('img', { src: r.url, alt: 'file', onerror: (e) => { e.target.replaceWith(el('video', { controls: true, src: r.url })); } }));
        box.append(save, ' ', el('span', { class: 'pill logged', text: 'logged' }), pv);
      } else {
        showRevealed(box, await rpc('dbtool_reveal', { p_table: table, p_key: key, p_column: column, p_report: report || null }));
      }
    } catch (e) {
      if (e.message === 'report_needed' && !report) {
        const r = await ask('Which report is this for?', 'Show', '', { test: (x) => UUID.test(x), testMessage: 'A report id like 0f1e…',
          hint: 'A deleted message, an earlier wording or a deleted pin\'s place opens only from a report about that message or chat.' });
        if (r !== null) return revealInto(box, table, key, column, kind, r);
        return;
      }
      toast(say(e.message), 'bad');
    }
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Sign-in, idle sign-out, frame

  // The screen goes first: signing out asks the server, and a stalled network must not leave a table, a chat or a
  // revealed value on show past the idle time (outside review of 22 Nov 2026, #11). The sign-in kept in this tab
  // goes next, whatever the server answers; ending it on the server gets 5 seconds.
  async function signOut(reason) {
    document.querySelectorAll('.overlay').forEach((o) => o.remove());
    state.tables = [];
    renderSignIn(reason);
    const ending = sb.auth.signOut({ scope: 'local' }).catch(() => { /* gone already */ });
    await Promise.race([ending, new Promise((ok) => setTimeout(ok, 5000))]);
    try { window.sessionStorage.clear(); } catch (_) { /* nothing kept */ }
  }
  function renderSignIn(message) {
    clear(app);
    const email = el('input', { type: 'email', autocomplete: 'username', id: 'email' });
    const pass = el('input', { type: 'password', autocomplete: 'current-password', id: 'password' });
    const err = el('div', { class: 'err', text: message || '' });
    const go = async () => {
      err.textContent = '';
      if (!email.value || !pass.value) { err.textContent = 'Enter your email and password.'; return; }
      const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      pass.value = '';
      if (error) { err.textContent = 'That email and password didn\'t work.'; return; }
      start();
    };
    pass.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    app.append(el('div', { class: 'signin' }, el('h1', { text: 'KidoChat database' }),
      el('div', { class: 'muted', text: 'For the owner only. Sign in with your KidoChat account.' }),
      el('label', { for: 'email', text: 'Email' }), email, el('label', { for: 'password', text: 'Password' }), pass,
      el('button', { class: 'primary', text: 'Sign in', onclick: go }), err));
    email.focus();
  }
  ['click', 'keydown', 'pointerdown'].forEach((t) => document.addEventListener(t, () => {
    state.lastActivity = Date.now();
    if (state.warned) { state.warned = false; const b = document.getElementById('idle-banner'); if (b) b.remove(); }
  }, true));
  setInterval(() => {
    if (!state.tables.length) return;
    const idle = Date.now() - state.lastActivity;
    const cd = document.querySelector('.countdown');
    if (cd) cd.textContent = 'signs out in ' + Math.max(0, Math.ceil((IDLE_OUT_MS - idle) / 60000)) + ' min';
    if (idle >= IDLE_OUT_MS) { signOut('Signed out after 15 minutes without use.'); return; }
    if (idle >= IDLE_WARN_MS && !state.warned) {
      state.warned = true;
      const top = document.querySelector('.top');
      if (top) top.after(el('div', { class: 'banner', id: 'idle-banner' }, 'Signing out in 1 minute.',
        el('button', { text: 'Stay signed in', onclick: () => { state.lastActivity = Date.now(); } })));
    }
  }, 10000);

  async function start() {
    try {
      try {
        state.tables = await rpc('dbtool_tables');
      } catch (e) {
        if (e.message !== 'no_answer') throw e;
        viaHeader = false;  // the browser refused the header: a read, so asking again is safe
        state.tables = await rpc('dbtool_tables');
        setTimeout(() => toast('Calls are not marked via: dbtool (the browser refused the header).', 'warn'), 500);
      }
    } catch (e) {
      if (e.message !== 'only_owner' && e.message !== 'session_ended') signOut(say(e.message));
      return;
    }
    state.byName = Object.fromEntries(state.tables.map((t) => [t.table, t]));
    state.lastActivity = Date.now();
    renderFrame();
    route();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The frame: top bar, left column, main

  const VIEWS = [['overview', 'Overview'], ['people', 'People'], ['families', 'Families'], ['groups', 'Groups'],
                 ['reports', 'Reports'], ['consents', 'Consents'], ['admins', 'Admins'], ['filter', 'Filter'],
                 ['announce', 'Announcements']];
  const LISTS = [['signins', 'Sign-ins'], ['files', 'Stored files'], ['migrations', 'Migrations'], ['jobs', 'Scheduled jobs']];
  const TOOLS = [['usage', 'Free-plan usage'], ['retention', 'Retention check'], ['consistency', 'Consistency'], ['log', 'Change log']];

  function renderFrame() {
    clear(app);
    const search = el('input', { class: 'search', type: 'search', placeholder: 'Find an id or a person' });
    search.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const q = search.value.trim();
      if (!q) return;
      if (UUID.test(q)) { state.findId = q.toLowerCase(); go('#/find'); } else { state.searchText = q; go('#/view/people'); }
      search.value = '';
    });
    const nav = el('nav', { class: 'nav', id: 'nav' });
    app.append(
      el('div', { class: 'top' },
        el('button', { class: 'menu-btn', text: 'Menu', onclick: () => nav.classList.toggle('open') }),
        el('span', { class: 'name', text: 'KidoChat database' }), search,
        el('span', { class: 'countdown muted', text: 'signs out in 15 min' }), el('span', { class: 'who muted', text: 'Owner' }),
        el('button', { text: 'Sign out', onclick: () => signOut('Signed out.') })),
      el('div', { class: 'layout' }, nav, el('main', { class: 'main', id: 'main' })));
    nav.append(el('div', { class: 'group', text: 'Admin views' }), ...VIEWS.map(([k, l]) => navBtn('#/view/' + k, l)));
    const groups = {};
    state.tables.forEach((t) => { (groups[t.group] = groups[t.group] || []).push(t); });
    nav.append(el('div', { class: 'group', text: 'Tables (' + state.tables.length + ')' }));
    Object.keys(groups).forEach((g) => {
      nav.append(el('details', { open: g === 'Staff and app' ? 'open' : null }, el('summary', { text: g + ' (' + groups[g].length + ')' }),
        groups[g].map((t) => navBtn('#/table/' + t.table, t.table))));
    });
    nav.append(el('div', { class: 'group', text: 'Lists' }), ...LISTS.map(([k, l]) => navBtn('#/list/' + k, l)));
    nav.append(el('div', { class: 'group', text: 'Tools' }), ...TOOLS.map(([k, l]) => navBtn('#/tool/' + k, l)));
  }
  function navBtn(hash, label) {
    return el('button', { 'data-hash': hash, text: label, onclick: () => { document.getElementById('nav').classList.remove('open'); go(hash); } });
  }
  function go(hash) { if (location.hash === hash) route(); else location.hash = hash; }
  window.addEventListener('hashchange', () => { if (state.tables.length) route(); });

  async function route() {
    const h = location.hash || '#/view/overview';
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.hash === h));
    const main = clear(document.getElementById('main'));
    main.append(el('div', { class: 'muted', text: 'Loading…' }));
    const [, kind, name] = h.split('/');
    let node;
    try {
      if (kind === 'table' && state.byName[name]) node = await viewTable(name);
      else if (kind === 'view' && VIEW_FNS[name]) node = await VIEW_FNS[name]();
      else if (kind === 'list' && LIST_FNS[name]) node = await LIST_FNS[name]();
      else if (kind === 'tool' && TOOL_FNS[name]) node = await TOOL_FNS[name]();
      else if (kind === 'find' && state.findId) node = await viewFind();
      else if (kind === 'person' && state.personId) node = await viewPerson();
      else if (kind === 'chat' && state.chatId) node = await viewChat();
      else node = await VIEW_FNS.overview();
    } catch (e) {
      node = el('div', { class: 'note bad', text: say(e.message) });
    }
    clear(main).append(node);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Table view

  const TARGET_WORDS = { children: 'Kid', parents: 'Grown-up', chats: 'Chat', adult_chats: 'Chat between grown-ups',
    messages: 'Message', adult_messages: 'Message between grown-ups', reports: 'Report', game_rounds: 'KidoFool round',
    game_guesses: 'KidoFool guess', announcements: 'Announcement' };

  function tableActions(t, row, refresh) {
    const v = row.v;
    const out = [];
    const snap = JSON.stringify(v);
    const reread = async () => {
      const filters = t.masked_key ? [] : t.key.map((k) => ({ col: k, op: 'eq', value: String(row.key[k]) }));
      const r = await rpc('dbtool_rows', { p_table: t.table, p_filters: filters, p_offset: 0, p_limit: 1 });
      return r.rows.length ? JSON.stringify(r.rows[0].v) : 'gone';
    };
    // a: base action fields; reread/snapshot added for table rows
    const target = targetOf(TARGET_WORDS[t.table] || 'Row in ' + t.table, v);
    const A = (o) => Object.assign({ reread: t.masked_key ? null : reread, snapshot: snap, after: refresh, target }, o);
    personActions(t.table === 'children' || t.table === 'parents' ? v.id : null, t.table === 'children', A, out);
    if (['contacts', 'adult_kid_friends', 'adult_connections'].includes(t.table)) {
      out.push(actBtn('End friendship', () => runAction(A({ label: 'End friendship', danger: true, checks: ['end_chat'],
        run: () => rpc('admin_end_friendship', { p_id: v.id }) })), 'danger'));
    }
    if (t.table === 'chats' || t.table === 'adult_chats') chatActions(v.id, t.table === 'chats' ? v : null, A, out, !!v.frozen_at);
    if (t.table === 'chat_members' && !v.left_at) {
      out.push(actBtn('Take out of the group', () => runAction(A({ label: 'Take out of the group', danger: true,
        checks: ['remove_from_group'], run: () => rpc('admin_remove_from_group', { p_chat: v.chat_id, p_person: v.child_id }) })), 'danger'));
    }
    if (t.table === 'messages' || t.table === 'adult_messages') messageActions(t.table, v, A, out);
    if (t.table === 'reports') reportActions(v, A, out);
    if (t.table === 'parental_consents' && v.status === 'pending') consentActions(v.id, A, out);
    if (t.table === 'admins' && !v.is_owner) {
      out.push(actBtn('Remove admin', () => runAction(A({ label: 'Remove admin', danger: true,
        run: () => rpc('admin_remove_admin', { p_user: v.user_id }) })), 'danger'));
    }
    if (t.table === 'game_rounds') {
      out.push(actBtn(v.card_hidden_at ? 'Show the card' : 'Hide the card', () => runAction(A({ label: v.card_hidden_at ? 'Show the card' : 'Hide the card',
        run: () => rpc('admin_game_hide', { p_round: v.id, p_guess: null, p_hide: !v.card_hidden_at, p_card: true }) }))));
      out.push(actBtn(v.item_hidden_at ? 'Show the drawing or answer' : 'Hide the drawing or answer', () => runAction(A({
        label: v.item_hidden_at ? 'Show the drawing or answer' : 'Hide the drawing or answer',
        run: () => rpc('admin_game_hide', { p_round: v.id, p_guess: null, p_hide: !v.item_hidden_at, p_card: false }) }))));
    }
    if (t.table === 'game_guesses') {
      out.push(actBtn(v.hidden_at ? 'Show the guess' : 'Hide the guess', () => runAction(A({ label: v.hidden_at ? 'Show the guess' : 'Hide the guess',
        run: () => rpc('admin_game_hide', { p_round: v.round_id, p_guess: v.id, p_hide: !v.hidden_at, p_card: false }) }))));
    }
    // Direct edits (section 5)
    if (t.table === 'announcements') {
      ['title_en', 'body_en', 'title_he', 'body_he'].forEach((c) => out.push(actBtn('Edit ' + c, async () => {
        const nv = await ask('Edit ' + c, 'Next', v[c], { multiline: c.startsWith('body') });
        if (nv === null || nv === v[c]) return;
        runAction({ label: 'Change ' + c, lines: ['Old: ' + v[c], 'New: ' + nv, 'People who already saw it won\'t see the correction.'],
          run: () => rpc('dbtool_edit', { p_table: 'announcements', p_key: { id: v.id }, p_column: c, p_old: v[c], p_new: nv }),
          checks: ['dbtool_edit'], after: refresh, target });
      })));
    }
    if (t.can_remove) {
      out.push(actBtn('Remove', async () => {
        let lines = [];
        if (t.table === 'labs_chats' || t.table === 'announcements') {
          try { lines = (await rpc('dbtool_effect', { p_table: t.table, p_change: { id: v.id } })).lines; } catch (_) { /* none */ }
        }
        if (t.table === 'blocked_identifiers') lines.push('That email or number can sign up again.');
        runAction({ label: 'Remove this row', danger: true, lines, target,
          run: () => rpc('dbtool_remove', { p_table: t.table, p_key: row.key }), checks: ['dbtool_edit'], after: refresh });
      }, 'danger'));
    }
    return out;
  }

  function personActions(id, isKid, A, out) {
    if (!id) return;
    out.push(actBtn('Person page', () => { state.personId = id; go('#/person'); }));
    out.push(actBtn('Rename', async () => {
      const n = await ask('New nickname', 'Next', '', { test: (x) => x.length <= 60, testMessage: 'At most 60 characters.' });
      if (n !== null) runAction(A({ label: 'Rename to "' + n + '"', run: () => edge({ action: 'rename', person: id, name: n }) }));
    }));
    out.push(actBtn('Full name', async () => {
      const n = await ask('New full name', 'Next', '', { test: (x) => x.split(/\s+/).length >= 2 && x.length <= 100,
                                                          testMessage: 'Two words or more, at most 100 characters.' });
      if (n !== null) runAction(A({ label: 'Set the full name', run: () => rpc('admin_set_full_name', { p_id: id, p_full_name: n }) }));
    }));
    out.push(actBtn('Unlock', () => runAction(A({ label: 'Unlock (wrong-code pauses)', run: () => rpc('admin_unlock', { p_id: id }) }))));
    if (isKid) {
      out.push(actBtn('New secret code', async () => {
        const pin = await ask('New 4-digit secret code', 'Next', '', { test: (x) => /^\d{4}$/.test(x), testMessage: 'Four digits.' });
        if (pin !== null) runAction(A({ label: 'Set a new secret code', run: () => edge({ action: 'new_code', person: id, pin }) }));
      }));
    } else {
      out.push(actBtn('Password reset email', () => runAction(A({ label: 'Send a password reset email', run: () => edge({ action: 'password_reset', person: id }) }))));
    }
    out.push(actBtn('Sign out everywhere', () => runAction(A({ label: 'Sign out everywhere', danger: true, run: () => edge({ action: 'sign_out_all', person: id }) })), 'danger'));
    out.push(actBtn('Remove photo', () => runAction(A({ label: 'Remove the photo', danger: true, checks: ['remove_photo'],
      run: () => edge({ action: 'remove_photo', person: id }) })), 'danger'));
    out.push(actBtn('Suspend', () => runAction(A({ label: 'Suspend', danger: true, preview: { action: 'suspend', args: { person: id } },
      checks: ['suspend'], run: () => edge({ action: 'suspend', person: id, suspend: true }) })), 'danger'));
    out.push(actBtn('Lift suspension', () => runAction(A({ label: 'Lift the suspension', checks: ['suspend'],
      run: () => edge({ action: 'suspend', person: id, suspend: false }) }))));
    out.push(actBtn('Delete everything they wrote', () => runAction(A({ label: 'Delete everything they wrote', danger: true,
      preview: { action: 'delete_all_from', args: { person: id } }, checks: ['delete_all_from'],
      run: () => edge({ action: 'delete_all_from', person: id }) })), 'danger'));
    out.push(actBtn('Export', () => runAction(A({ label: 'Export their data', lines: ['A copy of what they could see, as a file, for that person only.'],
      run: async () => {
        const data = await rpc('admin_export', { p_id: id });
        const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })),
                            download: 'kidochat-export.json' });
        document.body.append(a); a.click(); a.remove();
      } }))));
    out.push(actBtn('Delete account', () => runAction(A({ label: 'Delete the account', danger: true,
      preview: { action: 'delete_account', args: { person: id } }, checks: ['delete_account'],
      run: () => edge({ action: 'delete_account', person: id, block: false }) })), 'danger'));
    out.push(actBtn('Delete and block', () => runAction(A({ label: 'Delete the account and block its email or number', danger: true,
      preview: { action: 'delete_account', args: { person: id } }, checks: ['delete_account'],
      run: () => edge({ action: 'delete_account', person: id, block: true }) })), 'danger'));
  }

  // chat: the chats row, null for a chat between two grown-ups (no kids' actions there); frozen: either kind's
  // frozen_at, so a frozen grown-up chat offers Unfreeze (outside review of 22 Nov 2026, #12).
  function chatActions(id, chat, A, out, frozen) {
    out.push(actBtn('Open the chat', () => { state.chatId = id; state.chatReport = null; state.chatAround = null; go('#/chat'); }));
    out.push(actBtn(frozen ? 'Unfreeze' : 'Freeze', () => runAction(A({ label: frozen ? 'Unfreeze the chat' : 'Freeze the chat',
      run: () => rpc('admin_freeze_chat', { p_chat: id, p_frozen: !frozen }) }))));
    if (chat) {
      out.push(actBtn('Hide from the kids', () => runAction(A({ label: 'Hide the whole chat from the kids', danger: true,
        preview: { action: 'clear_chat', args: { chat: id, mode: 'hide' } }, checks: ['clear_chat'],
        run: () => edge({ action: 'clear_chat', chat: id, mode: 'hide' }) })), 'danger'));
      out.push(actBtn('End the chat', () => runAction(A({ label: 'End the chat', danger: true, checks: ['end_chat'],
        run: () => rpc('admin_end_chat', { p_chat: id }) })), 'danger'));
    }
    out.push(actBtn('Delete every message', () => runAction(A({ label: 'Delete every message for everyone', danger: true,
      preview: { action: 'clear_chat', args: { chat: id, mode: 'delete' } }, checks: ['clear_chat'],
      run: () => edge({ action: 'clear_chat', chat: id, mode: 'delete' }) })), 'danger'));
    if (chat && chat.is_group) {
      out.push(actBtn('Rename group', async () => {
        const n = await ask('New group name', 'Next', chat.title || '', { test: (x) => x.length <= 100, testMessage: 'At most 100 characters.' });
        if (n !== null) runAction(A({ label: 'Rename the group', run: () => rpc('admin_rename_group', { p_chat: id, p_title: n }) }));
      }));
      out.push(actBtn('Clear group picture', () => runAction(A({ label: 'Clear the group\'s picture', run: () => rpc('admin_clear_group_picture', { p_chat: id }) }))));
      if (!chat.closed_at) {
        out.push(actBtn('Close the group', () => runAction(A({ label: 'Close (delete) the group', danger: true,
          preview: { action: 'delete_group', args: { chat: id } }, run: () => rpc('admin_delete_group', { p_chat: id }) })), 'danger'));
      } else {
        out.push(actBtn('Delete for good', () => runAction(A({ label: 'Delete the closed group for good', danger: true,
          preview: { action: 'delete_group_for_good', args: { chat: id } }, checks: ['delete_group_for_good'],
          askText: { must: chat.title || 'delete', hint: 'Type the group\'s name to confirm: ' + (chat.title || 'delete') },
          run: () => edge({ action: 'delete_group_for_good', chat: id }) })), 'danger'));
      }
    }
  }

  function messageActions(table, v, A, out) {
    out.push(actBtn('Open in the chat', () => { state.chatId = v.chat_id; state.chatReport = null; state.chatAround = v.id; go('#/chat'); }));
    if (table === 'messages') {
      out.push(actBtn(v.hidden_at ? 'Show to the kids' : 'Hide from the kids', () => runAction(A({
        label: v.hidden_at ? 'Show it to the kids again' : 'Hide it from the kids',
        run: () => rpc('admin_hide_messages', { p_ids: [v.id], p_hide: !v.hidden_at }) }))));
    }
    out.push(actBtn('Delete', () => runAction(A({ label: 'Delete it for everyone', danger: true,
      preview: { action: 'delete_messages', args: { ids: [v.id] } }, checks: ['delete_messages'],
      run: () => edge({ action: 'delete_messages', ids: [v.id] }) })), 'danger'));
    out.push(actBtn('Delete all from sender here', () => runAction(A({ label: 'Delete everything the sender wrote in this chat', danger: true,
      preview: { action: 'delete_from_in_chat', args: { person: v.sender_id, chat: v.chat_id } }, checks: ['delete_from_in_chat'],
      run: () => edge({ action: 'delete_from_in_chat', person: v.sender_id, chat: v.chat_id }) })), 'danger'));
    if ((v.media_path || v.audio_path) && !v.media_removed_at && v.kind !== 'doodle') {
      out.push(actBtn('Remove the file', () => runAction(A({ label: 'Remove the file (the message stays, marked)', danger: true,
        checks: ['remove_file'], run: () => edge({ action: 'remove_file', message: v.id }) })), 'danger'));
    }
  }

  function reportActions(r, A, out) {
    out.push(actBtn('Open the chat from this report', () => {
      state.chatId = r.chat_id; state.chatReport = r.id; state.chatAround = r.message_id || null; go('#/chat');
    }));
    out.push(actBtn(r.handled_at ? 'Open again' : 'Mark handled', () => runAction(A({ label: r.handled_at ? 'Open the report again' : 'Mark the report handled',
      run: () => rpc('admin_handle_report', { p_report: r.id || r.report_id, p_handled: !r.handled_at }) }))));
  }

  function consentActions(id, A, out) {
    out.push(actBtn('Approve consent', () => runAction(A({ label: 'Approve the consent', run: () => rpc('admin_decide_consent', { p_consent: id, p_approve: true, p_reason: null }) }))));
    out.push(actBtn('Decline consent', async () => {
      const why = await ask('Why (shown to the parent)', 'Next', '', { test: (x) => x.length <= 500 });
      if (why !== null) runAction(A({ label: 'Decline the consent', danger: true, run: () => rpc('admin_decide_consent', { p_consent: id, p_approve: false, p_reason: why }) }));
    }, 'danger'));
  }

  async function viewTable(name) {
    if (name === 'admin_settings') return viewSettings();
    const t = state.byName[name];
    const st = state.tv[name] = state.tv[name] || { filters: [], order: null, desc: true, offset: 0 };
    const data = await rpc('dbtool_rows', { p_table: name, p_filters: st.filters, p_order: st.order, p_desc: st.desc,
                                            p_offset: st.offset, p_limit: 50 });
    const root = el('div');
    const shownCols = t.columns.filter((c) => c.mode === 'shown' || c.mode === 'editable');
    root.append(el('h2', { text: name }), el('div', { class: 'sub', text: t.group + ' · ' + data.total + ' rows'
      + (t.masked_key ? ' · its key is a secret: rows show a handle' : '') + (name === 'reports' ? ' · children\'s help requests are never listed' : '') }));
    const refresh = () => route();

    // Filters
    const col = el('select', {}, shownCols.map((c) => el('option', { value: c.name, text: c.name })));
    const op = el('select', {}, [['eq', 'is'], ['contains', 'contains'], ['between', 'between (times)'], ['null', 'is empty'], ['not_null', 'is not empty']]
      .map(([v, l]) => el('option', { value: v, text: l })));
    const val = el('input', { type: 'text', placeholder: 'value' });
    const val2 = el('input', { type: 'text', placeholder: 'to (for between)' });
    const addFilter = () => {
      const f = { col: col.value, op: op.value };
      if (op.value === 'between') { f.from = val.value || null; f.to = val2.value || null; } else if (op.value === 'eq' || op.value === 'contains') f.value = val.value;
      st.filters.push(f); st.offset = 0; refresh();
    };
    root.append(el('div', { class: 'bar' }, 'Filter:', col, op, val, val2, el('button', { text: 'Add', onclick: addFilter }),
      st.filters.map((f, i) => el('span', { class: 'pill' }, f.col + ' ' + f.op + ' ' + (f.value ?? [f.from, f.to].filter(Boolean).join('–')),
        el('button', { class: 'link', text: '×', 'aria-label': 'Remove filter', onclick: () => { st.filters.splice(i, 1); st.offset = 0; refresh(); } })))));
    const ord = el('select', {}, el('option', { value: '', text: 'default order' }), shownCols.map((c) => el('option', { value: c.name, text: c.name, selected: st.order === c.name })));
    ord.addEventListener('change', () => { st.order = ord.value || null; st.offset = 0; refresh(); });
    const dir = el('button', { text: st.desc ? 'newest first' : 'oldest first', onclick: () => { st.desc = !st.desc; refresh(); } });
    root.append(el('div', { class: 'bar' }, 'Sort:', ord, dir));

    // Add (direct edits)
    if (t.can_add) {
      root.append(el('div', { class: 'bar' }, actBtn(name === 'labs_chats' ? 'Add a chat to the old trial list' : 'Ban a question', async () => {
        if (name === 'labs_chats') {
          const id = await ask('Chat id or grown-ups\' chat id', 'Next', '', { test: (x) => UUID.test(x), testMessage: 'An id like 0f1e…' });
          if (id === null) return;
          const kindSel = await dialog('Which kind of chat?', el('div', { text: 'Is this a chat with a child in it, or a chat between two grown-ups?' }),
            [{ label: 'Cancel', value: null }, { label: 'Grown-ups\' chat', value: 'adult_chat_id' }, { label: 'Chat', value: 'chat_id', class: 'primary' }]);
          if (!kindSel) return;
          runAction({ label: 'Add the chat to the old trial list', lines: ['Unused since 20 Nov 2026: Doodle and KidoFool are in every chat (the labs_enabled setting).'],
            run: () => rpc('dbtool_add', { p_table: 'labs_chats', p_row: { [kindSel]: id.toLowerCase() } }), checks: ['dbtool_edit'], after: refresh });
        } else {
          const q = await ask('The question, as KidoFool asked it', 'Next', '');
          if (q !== null) runAction({ label: 'Ban the question', lines: ['"' + q + '" won\'t be asked again.'],
            run: () => rpc('dbtool_add', { p_table: 'game_banned_questions', p_row: { question: q } }), after: refresh });
        }
      })));
    }

    // The grid
    const table = el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, t.columns.map((c) => el('th', { text: c.name, title: c.mode })))));
    const body = el('tbody');
    const panel = el('div');
    data.rows.forEach((row) => {
      const tr = el('tr', { class: 'row' }, t.columns.map((c) => el('td', {}, valueNode(row.v[c.name], data.names,
        t.masked_key ? null : (box, kind) => revealInto(box, name, row.key, c.name, kind)))));
      tr.addEventListener('click', () => {
        body.querySelectorAll('tr.sel').forEach((x) => x.classList.remove('sel'));
        tr.classList.add('sel');
        clear(panel).append(rowPanel(t, row, data.names, refresh));
        panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
      body.append(tr);
    });
    table.append(body);
    root.append(el('div', { class: 'scroll' }, table));
    root.append(el('div', { class: 'bar' },
      el('button', { text: 'Earlier page', disabled: st.offset === 0, onclick: () => { st.offset = Math.max(0, st.offset - 50); refresh(); } }),
      el('span', { class: 'muted', text: data.total ? (st.offset + 1) + '–' + Math.min(st.offset + 50, data.total) + ' of ' + data.total : 'No rows' }),
      el('button', { text: 'Next page', disabled: st.offset + 50 >= data.total, onclick: () => { st.offset += 50; refresh(); } })));
    root.append(panel);
    return root;
  }

  function rowPanel(t, row, names, refresh) {
    const fields = el('div', { class: 'fields' });
    t.columns.forEach((c) => {
      fields.append(el('div', { class: 'k', text: c.name }), el('div', { class: 'v' }, valueNode(row.v[c.name], names,
        t.masked_key ? null : (box, kind) => revealInto(box, t.table, row.key, c.name, kind))));
    });
    const idOfRow = row.v.id && UUID.test(String(row.v.id)) ? row.v.id : null;
    return el('div', { class: 'panel' }, el('h3', { text: t.table + ' row' }), fields,
      el('div', { class: 'actions' }, tableActions(t, row, refresh),
        idOfRow ? el('button', { text: 'Where this id appears', onclick: () => { state.findId = idOfRow; go('#/find'); } }) : null));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Settings (admin_settings, section 5)

  async function viewSettings() {
    const list = await rpc('dbtool_settings');
    const root = el('div', {}, el('h2', { text: 'admin_settings' }),
      el('div', { class: 'sub', text: 'Each setting takes exactly the type its readers expect. Removing one goes back to its default.' }));
    const refresh = () => route();
    list.forEach((s) => {
      const cur = s.set ? s.value : null;
      const line = el('div', { class: 'line' },
        el('div', { class: 'grow' }, el('div', {}, el('b', { text: s.key }), ' ', el('span', { class: 'muted', text: '(' + s.type + (s.min !== null && s.min !== undefined ? ', ' + s.min + '–' + s.max : '') + ')' })),
          el('div', {}, 'Value: ', el('span', { class: 'mono', text: s.set ? JSON.stringify(s.value) : 'not set' }), ' · default ',
            el('span', { class: 'mono', text: JSON.stringify(s.default) }), s.updated_at ? ' · changed ' + fmtTime(s.updated_at) : ''),
          s.warning ? el('div', { class: 'muted', text: s.warning }) : null),
        s.editable ? actBtn('Edit', async () => {
          let nv;
          if (s.type === 'boolean') {
            nv = await dialog('Change ' + s.key, el('div', { text: 'Now: ' + (s.set ? JSON.stringify(s.value) : 'not set (default ' + JSON.stringify(s.default) + ')') }),
              [{ label: 'Cancel', value: null }, { label: 'false', value: false }, { label: 'true', value: true, class: 'primary' }]);
            if (nv === null || nv === undefined) return;
          } else {
            const txt = await ask('Change ' + s.key, 'Next', s.set ? String(s.value) : '', {
              test: (x) => /^\d+$/.test(x) && (s.min === null || +x >= s.min) && (s.max === null || +x <= s.max),
              testMessage: 'A whole number' + (s.min !== null ? ' from ' + s.min + ' to ' + s.max : '') + '.' });
            if (txt === null) return;
            nv = parseInt(txt, 10);
          }
          let effect = { lines: [], ask_twice: false };
          try { effect = await rpc('dbtool_effect', { p_table: 'admin_settings', p_change: { key: s.key, new: nv } }); } catch (_) { /* none */ }
          const lines = ['Old: ' + (s.set ? JSON.stringify(s.value) : 'not set') + ' → New: ' + JSON.stringify(nv)].concat(effect.lines);
          if (effect.ask_twice && !(await confirmLines('Change ' + s.key + '?', lines, 'Yes, change it', true))) return;
          runAction({ label: 'Change ' + s.key, lines, danger: effect.ask_twice, checks: ['dbtool_edit'], after: refresh,
            run: () => rpc('dbtool_edit', { p_table: 'admin_settings', p_key: { key: s.key }, p_column: 'value', p_old: cur, p_new: nv }) });
        }) : el('span', { class: 'pill', text: 'locked' }),
        s.editable && s.set ? actBtn('Back to default', async () => {
          let effect = { lines: [] };
          try { effect = await rpc('dbtool_effect', { p_table: 'admin_settings', p_change: { key: s.key, new: null } }); } catch (_) { /* none */ }
          runAction({ label: 'Put ' + s.key + ' back to its default', lines: ['Default: ' + JSON.stringify(s.default)].concat(effect.lines),
            checks: ['dbtool_edit'], after: refresh,
            run: () => rpc('dbtool_edit', { p_table: 'admin_settings', p_key: { key: s.key }, p_column: 'value', p_old: cur, p_new: null }) });
        }) : null);
      root.append(line);
    });
    if (list.some((s) => s.key === 'filter_price')) {
      root.append(el('div', { class: 'note', text: 'filter_price is set on the Filter screen.' }));
    }
    return root;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Generic list rendering for the Admin views' results

  function listTable(rows, opts) {
    if (!rows || !rows.length) return el('div', { class: 'muted', text: (opts && opts.empty) || 'Nothing here.' });
    const cols = (opts && opts.cols) || Object.keys(rows[0]).filter((k) => !/session_id|selfie_path|avatar|pending_selfie/.test(k));
    const table = el('table', { class: 'grid' }, el('thead', {}, el('tr', {}, cols.map((c) => el('th', { text: c })))));
    const body = el('tbody');
    rows.forEach((r) => {
      const tr = el('tr', { class: opts && opts.onclick ? 'row' : '' }, cols.map((c) => el('td', {}, valueNode(r[c], null, null))));
      if (opts && opts.onclick) tr.addEventListener('click', () => opts.onclick(r));
      body.append(tr);
    });
    table.append(body);
    return el('div', { class: 'scroll' }, table);
  }
  const openPerson = (id) => { state.personId = id; go('#/person'); };

  const VIEW_FNS = {
    async overview() {
      const d = await rpc('admin_dashboard');
      const root = el('div', {}, el('h2', { text: 'Overview' }), el('div', { class: 'sub', text: 'As in the app\'s Admin.' }));
      root.append(el('div', { class: 'cards' }, Object.entries(d).filter(([, v]) => typeof v === 'number')
        .map(([k, v]) => el('div', { class: 'card' }, el('div', { class: 'muted', text: k.replace(/_/g, ' ') }), el('div', { class: 'n', text: String(v) })))));
      const b = await rpc('admin_app_builds');
      root.append(el('h3', { text: 'App versions' }), listTable(b.summary || [], { empty: 'No builds reported.' }),
        el('div', { class: 'muted', text: (b.not_reported ?? '?') + ' accounts never reported a build.' }));
      root.append(el('h3', { text: 'Who runs which build' }), listTable(b.people || [], { cols: ['name', 'kind', 'platform', 'build', 'seen_at'], onclick: (r) => openPerson(r.id) }));
      return root;
    },
    async people() {
      const root = el('div', {}, el('h2', { text: 'People' }));
      const q = el('input', { type: 'search', placeholder: 'Name, full name or email' });
      q.value = state.searchText || '';
      const chip = el('select', {}, [['', 'everyone'], ['kids', 'Kids'], ['adults', 'Grown-ups'], ['suspended', 'Suspended'], ['paused', 'Sign-in paused']]
        .map(([v, l]) => el('option', { value: v, text: l })));
      const out = el('div');
      const load = async () => {
        state.searchText = q.value.trim();
        clear(out).append(el('div', { class: 'muted', text: 'Loading…' }));
        try {
          const rows = await rpc('admin_search', { p_q: q.value.trim(), p_filter: chip.value || null });
          clear(out).append(listTable(rows, { cols: ['name', 'full_name', 'is_kid', 'has_kids', 'email', 'suspended', 'paused', 'is_admin'], onclick: (r) => openPerson(r.id) }));
        } catch (e) { clear(out).append(el('div', { class: 'note bad', text: say(e.message) })); }
      };
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
      chip.addEventListener('change', load);
      root.append(el('div', { class: 'bar' }, q, chip, el('button', { text: 'Search', onclick: load })), out);
      load();
      return root;
    },
    async families() {
      const rows = await rpc('admin_families', { p_q: '' });
      const root = el('div', {}, el('h2', { text: 'Families' }));
      rows.forEach((f) => root.append(el('div', { class: 'panel' },
        [...(f.parents || []), ...(f.kids || [])].map((p) => el('button', { class: 'link', text: (p.name || '?') + (p.full_name ? ' (' + p.full_name + ')' : '') + (p.is_kid ? ' · kid' : ''), onclick: () => openPerson(p.id) })))));
      return root;
    },
    async groups() {
      const rows = await rpc('admin_groups', { p_q: '' });
      const open = rows.filter((g) => !g.closed), closed = rows.filter((g) => g.closed);
      const openChat = (r) => { state.chatId = r.chat_id; state.chatReport = null; state.chatAround = null; go('#/chat'); };
      return el('div', {}, el('h2', { text: 'Groups' }),
        listTable(open, { cols: ['title', 'kind', 'members', 'frozen', 'last_at'], onclick: openChat }),
        closed.length ? el('details', {}, el('summary', { text: 'Show ' + closed.length + ' closed groups' }),
          listTable(closed, { cols: ['title', 'kind', 'members', 'last_at'], onclick: openChat })) : null);
    },
    async reports() {
      const root = el('div', {}, el('h2', { text: 'Reports' }), el('div', { class: 'sub', text: 'Children\'s help requests are never shown here.' }));
      for (const open of [true, false]) {
        const rows = await rpc('admin_reports', { p_open: open });
        root.append(el('h3', { text: open ? 'Open' : 'Handled' }));
        if (!rows.length) { root.append(el('div', { class: 'muted', text: 'None.' })); continue; }
        rows.forEach((r) => {
          const out = [];
          const A = (o) => Object.assign({ after: () => route(), target: targetOf('Report', { id: r.report_id, created_at: r.created_at }) }, o);
          reportActions({ id: r.report_id, chat_id: r.chat_id, message_id: r.message_id, handled_at: r.handled_at }, A, out);
          root.append(el('div', { class: 'panel' },
            el('div', {}, fmtTime(r.created_at), ' · ', (r.kind || ''), ' · reason ',
              valueNode(r.reason ? { hidden: 'text', len: r.reason.length } : null, null,
                (box) => revealInto(box, 'reports', { id: r.report_id }, 'reason', 'text', r.report_id))),
            el('div', { class: 'muted', text: 'From ' + ((r.reporter && r.reporter.name) || '?') + ' about ' + ((r.sender && r.sender.name) || '?') }),
            el('div', {}, valueNode(r.body ? { hidden: 'text', len: r.body.length } : null, null,
              (box) => revealInto(box, 'reports', { id: r.report_id }, 'body', 'text', r.report_id))),
            el('div', { class: 'actions' }, out)));
        });
      }
      return root;
    },
    async consents() {
      const root = el('div', {}, el('h2', { text: 'Consents' }));
      for (const pending of [true, false]) {
        const d = await rpc('admin_consents', { p_pending: pending });
        const rows = Array.isArray(d) ? d : (d && d.items) || [];
        root.append(el('h3', { text: pending ? 'Waiting' : 'Decided' }));
        if (!rows.length) { root.append(el('div', { class: 'muted', text: 'None.' })); continue; }
        rows.forEach((c) => {
          const out = [];
          if (pending) consentActions(c.id, (o) => Object.assign({ after: () => route(), target: targetOf('Consent form', { id: c.id }) }, o), out);
          root.append(el('div', { class: 'panel' }, listTable([c], { cols: Object.keys(c).filter((k) => k !== 'signature_path') }), el('div', { class: 'actions' }, out)));
        });
      }
      return root;
    },
    async admins() {
      const rows = await rpc('admin_list_admins');
      const root = el('div', {}, el('h2', { text: 'Admins' }));
      rows.forEach((r) => {
        const out = [];
        if (!r.owner) out.push(actBtn('Remove admin', () => runAction({ label: 'Remove admin', danger: true, after: () => route(), run: () => rpc('admin_remove_admin', { p_user: r.user_id }) }), 'danger'));
        root.append(el('div', { class: 'line' }, el('div', { class: 'grow' }, el('b', { text: (r.card && r.card.name) || r.user_id }), r.owner ? ' · owner' : ''),
          el('button', { text: 'Person page', onclick: () => openPerson(r.user_id) }), out));
      });
      root.append(el('div', { class: 'bar' }, actBtn('Add admin', async () => {
        const who = await ask('Add an admin', 'Next', '', { hint: 'Their email, as in the app\'s Admin.' });
        if (who !== null) runAction({ label: 'Make ' + who + ' an admin', lines: ['A second person with access to the data brings new duties (security procedure).'],
          danger: true, after: () => route(), run: () => rpc('admin_add_admin', { p_who: who }) });
      })));
      return root;
    },
    async filter() {
      const u = await rpc('admin_filter_usage');
      const s = await rpc('admin_filter_stats', { p_days: 7 });
      const root = el('div', {}, el('h2', { text: 'Filter' }));
      root.append(el('h3', { text: 'Usage' }), el('pre', { class: 'mono', text: JSON.stringify(u, null, 2) }));
      root.append(el('h3', { text: 'Last 7 days' }), el('pre', { class: 'mono', text: JSON.stringify(s, null, 2) }));
      root.append(el('div', { class: 'actions' },
        actBtn('Run the check set', () => runAction({ label: 'Run the filter\'s check set', lines: ['Sends the curated cases to the live model (costs a little).'],
          run: async () => { const r = await edge({ action: 'filter_check' }); toast('Filter check: ' + JSON.stringify(r).slice(0, 300)); } })),
        actBtn('Set the price', async () => {
          const i = await ask('Price per million input tokens', 'Next', '', { test: (x) => /^\d+(\.\d+)?$/.test(x) });
          if (i === null) return;
          const o = await ask('Price per million output tokens', 'Next', '', { test: (x) => /^\d+(\.\d+)?$/.test(x) });
          if (o === null) return;
          runAction({ label: 'Set the filter price', after: () => route(), run: () => rpc('admin_set_filter_price', { p_input: +i, p_output: +o }) });
        })));
      return root;
    },
    async announce() {
      const root = el('div', {}, el('h2', { text: 'Announcements' }),
        el('div', { class: 'sub', text: 'Posting is the app\'s action; correcting or deleting one is on the announcements table.' }));
      root.append(el('div', { class: 'actions' }, actBtn('Post an announcement', async () => {
        const te = await ask('Title (English)', 'Next', '', { test: (x) => x.length <= 100 }); if (te === null) return;
        const be = await ask('Text (English)', 'Next', '', { multiline: true, test: (x) => x.length <= 2000 }); if (be === null) return;
        const th = await ask('Title (Hebrew)', 'Next', '', { test: (x) => x.length <= 100 }); if (th === null) return;
        const bh = await ask('Text (Hebrew)', 'Next', '', { multiline: true, test: (x) => x.length <= 2000 }); if (bh === null) return;
        const push = await dialog('Tell every grown-up?', el('div', { text: 'A push with no content: "News from KidoChat".' }),
          [{ label: 'Cancel', value: null }, { label: 'Post without a push', value: 'no' }, { label: 'Post and push', value: 'yes', class: 'primary' }]);
        if (!push) return;
        runAction({ label: 'Post the announcement', lines: [te, push === 'yes' ? 'With a push to every grown-up.' : 'Without a push.'],
          after: () => go('#/table/announcements'),
          run: async () => { await rpc('admin_post_announcement', { p_title_en: te, p_body_en: be, p_title_he: th, p_body_he: bh });
                             if (push === 'yes') await edge({ action: 'announce' }); } });
      })), el('button', { text: 'The announcements table', onclick: () => go('#/table/announcements') }));
      return root;
    },
  };

  async function viewPerson() {
    const id = state.personId;
    const p = await rpc('admin_person', { p_id: id });
    const counts = await rpc('admin_sent_counts', { p_id: id });
    const root = el('div', {}, el('h2', { text: (p.name || '?') + (p.is_kid ? ' · kid' : ' · grown-up') }),
      el('div', { class: 'sub', text: 'Sent ' + (counts && counts.week !== undefined ? counts.week + ' messages in the last 7 days, ' + counts.total + ' in all' : JSON.stringify(counts)) }));
    const out = [];
    const reread = async () => JSON.stringify(await rpc('admin_person', { p_id: id }));
    const snap = JSON.stringify(p);
    const target = targetOf(p.is_kid ? 'Kid' : 'Grown-up', { id, name: p.name });
    personActions(id, p.is_kid, (o) => Object.assign({ reread, snapshot: snap, after: () => route(), target }, o), out);
    root.append(el('div', { class: 'actions' }, out.filter((b) => b.textContent !== 'Person page')));
    if (p.is_kid && p.pending_selfie) {
      root.append(el('div', { class: 'panel' }, el('h3', { text: 'Photo waiting' }),
        valueNode({ hidden: 'file' }, null, (box) => revealInto(box, 'children', { id }, 'selfie_pending_path', 'file')),
        el('div', { class: 'actions' },
          actBtn('Approve photo', () => runAction({ label: 'Approve the photo', target, after: () => route(), run: () => rpc('admin_decide_selfie', { p_child: id, p_approve: true, p_path: p.pending_selfie }) })),
          actBtn('Reject photo', () => runAction({ label: 'Reject the photo', danger: true, target, after: () => route(), run: () => rpc('admin_decide_selfie', { p_child: id, p_approve: false, p_path: p.pending_selfie }) }), 'danger'))));
    }
    const devices = p.devices || [];
    if (devices.length) {
      root.append(el('h3', { text: 'Phones' }));
      devices.forEach((d) => root.append(el('div', { class: 'line' },
        el('div', { class: 'grow', text: (d.label || 'a phone') + (d.signed_in ? ' · signed in' : '') + (d.last_seen ? ' · ' + fmtTime(d.last_seen) : '') }),
        d.session_id ? actBtn('Sign out this phone', () => runAction({ label: 'Sign out this phone', danger: true, target: target + ' · ' + (d.label || 'a phone'), after: () => route(),
          run: () => rpc('admin_end_session', { p_person: id, p_session: d.session_id }) }), 'danger') : null)));
    }
    const rest = Object.fromEntries(Object.entries(p).filter(([k]) => !['devices', 'chats', 'groups', 'friends', 'adult_friends', 'parents', 'selfie_path', 'pending_selfie', 'avatar'].includes(k)));
    root.append(el('h3', { text: 'Details' }), listTable([rest]));
    for (const k of ['parents', 'friends', 'adult_friends', 'chats', 'groups']) {
      const rows = p[k];
      if (!Array.isArray(rows) || !rows.length) continue;
      root.append(el('h3', { text: k.replace('_', ' ') }), listTable(rows, {
        onclick: (r) => { if (r.chat_id) { state.chatId = r.chat_id; state.chatReport = null; state.chatAround = null; go('#/chat'); } else if (r.id) openPerson(r.id); } }));
    }
    root.append(el('div', { class: 'actions' }, el('button', { text: 'Where this id appears', onclick: () => { state.findId = id; go('#/find'); } })));
    return root;
  }

  async function viewChat() {
    const chat = state.chatId, report = state.chatReport;
    await rpc('dbtool_chat_opened', { p_chat: chat, p_report: report });
    let before = null;
    const root = el('div', {}, el('h2', { text: 'Chat' }),
      el('div', { class: 'sub', text: report ? 'Opened from a report · logged once' : 'Logged once' }));
    const list = el('div');
    const more = el('button', { text: 'Show earlier messages' });
    const load = async (first) => {
      const rows = await rpc('admin_chat_messages', { p_chat: chat, p_before: before, p_around: first ? state.chatAround : null, p_limit: 100 });
      const nodes = rows.map((m) => el('div', { class: 'msg' + ((state.chatAround && m.id === state.chatAround) ? ' reported' : '') },
        el('span', { class: 'muted', text: fmtTime(m.created_at) + ' · ' }), el('b', { text: (m.sender_name || m.name || '?') + ' ' }),
        el('span', { text: m.body || (m.kind ? '(' + m.kind + ')' : '') }),
        m.hidden_at ? el('span', { class: 'pill warn', text: 'hidden from the kids' }) : null,
        m.status && m.status !== 'delivered' ? el('span', { class: 'pill', text: m.status }) : null));
      if (rows.length) before = rows[0].created_at;
      list.prepend(...nodes);
      if (rows.length < 100) more.remove();
    };
    more.addEventListener('click', () => load(false));
    root.append(more, list);
    await load(true);
    const out = [];
    const isGroup = await rpc('dbtool_rows', { p_table: 'chats', p_filters: [{ col: 'id', op: 'eq', value: chat }], p_offset: 0, p_limit: 1 });
    const chatRow = isGroup.rows[0] ? isGroup.rows[0].v : null;
    let frozenAt = chatRow ? chatRow.frozen_at : null;
    if (!chatRow) {
      const adult = await rpc('dbtool_rows', { p_table: 'adult_chats', p_filters: [{ col: 'id', op: 'eq', value: chat }], p_offset: 0, p_limit: 1 });
      frozenAt = adult.rows[0] ? adult.rows[0].v.frozen_at : null;
    }
    const target = targetOf(chatRow ? 'Chat' : 'Chat between grown-ups', Object.assign({}, chatRow, { id: chat, kind: null }));
    chatActions(chat, chatRow, (o) => Object.assign({ after: () => route(), target }, o), out, !!frozenAt);
    root.append(el('div', { class: 'actions' }, out.filter((b) => b.textContent !== 'Open the chat')));
    return root;
  }

  async function viewFind() {
    const hits = await rpc('dbtool_find_id', { p_id: state.findId });
    const root = el('div', {}, el('h2', { text: 'Where this id appears' }), el('div', { class: 'sub mono', text: state.findId }));
    if (!hits.length) root.append(el('div', { class: 'muted', text: 'Nowhere.' }));
    hits.forEach((h) => root.append(el('div', { class: 'line' },
      el('div', { class: 'grow' }, el('b', { text: h.table }), ' · ', h.column, ' · ', h.keys.length + (h.keys.length === 20 ? '+' : '') + ' rows'),
      state.byName[h.table] ? el('button', { text: 'Show them', onclick: () => {
        const c = state.byName[h.table].columns.find((x) => x.name === h.column);
        state.tv[h.table] = { filters: [{ col: h.column, op: c && c.type === '_uuid' ? 'contains' : 'eq', value: state.findId }], order: null, desc: true, offset: 0 };
        go('#/table/' + h.table);
      } }) : h.table === 'admin_log' ? el('button', { text: 'Open the log', onclick: () => go('#/tool/log') }) : null)));
    if (UUID.test(state.findId)) root.append(el('div', { class: 'actions' }, el('button', { text: 'Person page', onclick: () => openPerson(state.findId) })));
    return root;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Lists outside public

  const LIST_FNS = {
    async signins() {
      const root = el('div', {}, el('h2', { text: 'Sign-ins' }), el('div', { class: 'sub', text: 'Never passwords or tokens.' }));
      const q = el('input', { type: 'search', placeholder: 'Email or phone' });
      const out = el('div');
      const load = async () => { clear(out).append(listTable(await rpc('dbtool_auth_users', { p_search: q.value.trim(), p_offset: 0 }),
        { onclick: (r) => openPerson(r.id) })); };
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(); });
      root.append(el('div', { class: 'bar' }, q, el('button', { text: 'Search', onclick: load })), out);
      await load();
      return root;
    },
    async files() {
      const root = el('div', {}, el('h2', { text: 'Stored files' }), el('div', { class: 'sub', text: 'Names, sizes and dates. Open a file from its row in a table (logged).' }));
      const bucket = el('select', {}, ['media', 'voice', 'selfies', 'avatars', 'consents'].map((b) => el('option', { value: b, text: b })));
      const prefix = el('input', { type: 'text', placeholder: 'folder (a person\'s or a chat\'s id)' });
      const out = el('div');
      const load = async () => { clear(out).append(listTable(await rpc('dbtool_files', { p_bucket: bucket.value, p_prefix: prefix.value.trim(), p_offset: 0 }))); };
      bucket.addEventListener('change', load);
      root.append(el('div', { class: 'bar' }, bucket, prefix, el('button', { text: 'List', onclick: load })), out);
      await load();
      return root;
    },
    async migrations() {
      return el('div', {}, el('h2', { text: 'Migrations' }), el('div', { class: 'sub', text: 'Which are live on the server.' }),
        listTable(await rpc('dbtool_migrations'), { empty: 'Not available here.' }));
    },
    async jobs() {
      const d = await rpc('dbtool_jobs');
      return el('div', {}, el('h2', { text: 'Scheduled jobs' }), listTable(d.jobs, { empty: 'Not available here.' }),
        el('h3', { text: 'Last runs' }), listTable(d.runs, { empty: 'None.' }));
    },
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Tools

  const TOOL_FNS = {
    async usage() {
      const u = await rpc('dbtool_usage');
      const meter = (label, mb, limit) => {
        const pct = limit ? Math.round((mb / limit) * 100) : 0;
        return el('div', { class: 'card' }, el('div', {}, el('b', { text: label }), ' ', el('span', { class: 'muted', text: mb + ' of ' + limit + ' MB · ' + pct + '%' })),
          (() => { const bar = el('div'); bar.style.width = Math.min(100, pct) + '%'; if (pct >= 80) bar.className = 'high'; return el('div', { class: 'meter' }, bar); })());
      };
      return el('div', {}, el('h2', { text: 'Free-plan usage' }), el('div', { class: 'sub', text: 'Warning at 80%. Users and data sent out: the Supabase dashboard.' }),
        el('div', { class: 'cards' }, meter('Database', u.database_mb, u.database_limit_mb), meter('Files', u.files_mb, u.files_limit_mb)),
        el('h3', { text: 'Largest tables' }), listTable(u.tables), el('h3', { text: 'Buckets' }), listTable(u.buckets, { empty: 'No files.' }));
    },
    async retention() {
      const rows = await rpc('dbtool_retention');
      return el('div', {}, el('h2', { text: 'Retention check' }), el('div', { class: 'sub', text: 'Rows past a promised keeping period (never their contents). Not zero: a cleanup didn\'t run or a promise isn\'t kept.' }),
        rows.map((r) => el('div', { class: 'line' }, el('div', { class: 'grow' }, el('div', { text: r.what }), el('div', { class: 'muted', text: r.promised })),
          r.overdue > 0 ? el('span', { class: 'pill warn', text: r.overdue + ' overdue · oldest ' + fmtTime(r.oldest) }) : el('span', { class: 'pill ok', text: '0' }))));
    },
    async consistency() {
      const rows = await rpc('dbtool_consistency', { p_only: null });
      return el('div', {}, el('h2', { text: 'Consistency' }), el('div', { class: 'sub', text: 'Read-only. A problem is fixed through an action or a reviewed migration, never here.' }),
        rows.map((r) => el('div', { class: 'line' }, el('div', { class: 'grow' }, el('div', { text: r.what }), el('div', { class: 'muted', text: 'Fix: ' + r.fix })),
          r.found > 0 ? el('details', {}, el('summary', { text: r.found + ' found' }), el('pre', { class: 'mono', text: r.keys.map((k) => JSON.stringify(k)).join('\n') }))
                      : el('span', { class: 'pill ok', text: '0' }))));
    },
    async log() {
      const root = el('div', {}, el('h2', { text: 'Change log' }), el('div', { class: 'sub', text: 'Read-only, kept 2 years, never message text.' }));
      const action = el('input', { type: 'text', placeholder: 'action (e.g. dbtool_edit)' });
      const out = el('div');
      let before = null;
      const more = el('button', { text: 'Older' });
      const undone = new Set();
      const render = (rows) => rows.forEach((r) => {
        if (r.details && r.details.undoes) undone.add(Number(r.details.undoes));
        const canBack = ['dbtool_edit', 'dbtool_add', 'dbtool_remove'].includes(r.action) && !(r.details && r.details.undoes) && !undone.has(Number(r.id))
                        && !(r.action === 'dbtool_remove' && r.details && r.details.table === 'announcements')
                        && !(r.action === 'dbtool_edit' && r.details && r.details.table === 'announcements');
        out.append(el('div', { class: 'line' },
          el('div', { class: 'grow' }, el('div', {}, el('b', { text: r.action }), ' · ', fmtTime(r.at), ' · ', r.admin_name || ''),
            el('div', { class: 'mono', text: JSON.stringify(r.details) })),
          canBack ? actBtn('Change back', async () => {
            let lines = ['Makes the reverse change, if the value hasn\'t changed since.'];
            let twice = false;
            const d = r.details || {};
            try {
              if (r.action === 'dbtool_edit' && d.table === 'admin_settings') {
                const eff = await rpc('dbtool_effect', { p_table: 'admin_settings', p_change: { key: d.key && d.key.key, new: d.old } });
                lines = ['Back to ' + JSON.stringify(d.old) + ' (now ' + JSON.stringify(d.new) + ').'].concat(eff.lines);
                twice = eff.ask_twice;
              } else if (r.action === 'dbtool_add' && d.table === 'labs_chats' && d.new) {
                lines = lines.concat((await rpc('dbtool_effect', { p_table: 'labs_chats', p_change: { id: d.new.id } })).lines);
              }
            } catch (_) { /* the change back itself checks */ }
            if (twice && !(await confirmLines('Change back?', lines, 'Yes, change it back', true))) return;
            runAction({ label: 'Change back', lines, danger: twice, checks: ['dbtool_edit'], after: () => route(),
                        run: () => rpc('dbtool_change_back', { p_log: r.id }) });
          }) : null));
      });
      const load = async (reset) => {
        if (reset) { clear(out); before = null; undone.clear(); }
        const rows = await rpc('dbtool_log', { p_before: before, p_action: action.value.trim() || null, p_limit: 100 });
        render(rows);
        if (rows.length) before = rows[rows.length - 1].id;
        more.disabled = rows.length < 100;
      };
      more.addEventListener('click', () => load(false));
      action.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(true); });
      root.append(el('div', { class: 'bar' }, action, el('button', { text: 'Filter', onclick: () => load(true) })), out, more);
      await load(true);
      return root;
    },
  };

  // ---------------------------------------------------------------------------------------------------------------

  sb.auth.getSession().then(({ data }) => { if (data && data.session) start(); else renderSignIn(); });
})();
