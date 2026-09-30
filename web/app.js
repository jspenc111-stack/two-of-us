/* Two of Us: the app. Plain JavaScript, no build step, no libraries.
 *
 * Privacy rules (SPEC section 8) this file must keep:
 *  - The phone stores only the back end address + personal key (localStorage, STORE_KEY).
 *    Moods and notes stay in memory while the app is open.
 *  - User text is always inserted as text (h() and text nodes), never as HTML.
 *  - Data goes only to the Apps Script address from the setup link.
 */
(function () {
  'use strict';

  const APP_VERSION = '1.0.0';
  // Must match VERSION in apps-script/Code.gs (a test checks this).
  const EXPECTED_BACKEND_VERSION = 1;
  const STORE_KEY = 'two-of-us-link';
  const MOOD_NOTE_MAX = 140;
  const REQUEST_TIMEOUT_MS = 20000;
  const REFRESH_AFTER_MS = 15000;

  const MOODS = [
    { value: 'great', label: 'Great', emoji: '😄' },
    { value: 'good', label: 'Good', emoji: '🙂' },
    { value: 'okay', label: 'Okay', emoji: '😐' },
    { value: 'rough', label: 'Rough', emoji: '😔' },
  ];

  const COPY = {
    offline: "Can't reach the jar right now. Try again in a moment.",
    setup: 'Open your personal setup link to get started.',
    badkey: 'This link no longer works. Ask for a new setup link.',
    badlink: "This setup link isn't complete. Ask for a new setup link.",
  };

  // Everything the app knows lives here, in memory only.
  const app = {
    link: null, // { url, key } from the setup link
    demo: null, // pretend back end in demo mode
    data: null, // the last `state` from the back end
    loadedAt: 0,
    refreshing: false,
    pendingWrites: 0,
    noteEditor: { open: false, text: '' },
  };

  // -------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------

  const $ = (id) => document.getElementById(id);

  // Builds an element. Strings become text nodes, so user text is never read as HTML.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  function moodInfo(value) {
    return MOODS.find((m) => m.value === value) || { value, label: value, emoji: '•' };
  }

  // Dates arrive as "yyyy-MM-dd" (decided by the server). Shown as dates only, never times.
  function formatDay(ymd, options) {
    const p = String(ymd).split('-').map(Number);
    const d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
    return d.toLocaleDateString(undefined, Object.assign({ timeZone: 'UTC' }, options));
  }

  function counterText(length, max) {
    return length + ' / ' + max;
  }

  let toastTimer = 0;
  function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function focusLater(id) {
    requestAnimationFrame(() => {
      const el = $(id);
      if (el) el.focus();
    });
  }

  // A small pop-up card. Closes with the buttons, the back gesture or a tap outside.
  function showSheet(content, actions) {
    const dialog = h('dialog', { class: 'sheet' }, content, h('div', { class: 'sheet-actions' }, actions));
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    return dialog;
  }

  // -------------------------------------------------------------------------
  // The saved link (the only thing stored on the phone)
  // -------------------------------------------------------------------------

  function isBackendUrl(url) {
    return typeof url === 'string' && /^https:\/\/script\.google\.com\/[^\s?#|]+\/exec$/.test(url);
  }

  function isKey(key) {
    return typeof key === 'string' && /^[A-Za-z0-9]{32,}$/.test(key);
  }

  // "#setup=<backend-url>|<key>" (the whole value may be URL-encoded).
  // Returns { url, key }, { bad: true } for a broken link, or null when there's no setup link.
  function parseSetupHash(hash) {
    if (typeof hash !== 'string' || hash.indexOf('#setup=') !== 0) return null;
    let raw = hash.slice('#setup='.length);
    try {
      raw = decodeURIComponent(raw);
    } catch (err) {
      return { bad: true };
    }
    const cut = raw.lastIndexOf('|');
    const url = raw.slice(0, cut).trim();
    const key = raw.slice(cut + 1).trim();
    if (cut < 0 || !isBackendUrl(url) || !isKey(key)) return { bad: true };
    return { url, key };
  }

  function loadLink() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (saved && isBackendUrl(saved.url) && isKey(saved.key)) return { url: saved.url, key: saved.key };
    } catch (err) {
      // Storage blocked or unreadable: treat as not set up.
    }
    return null;
  }

  function saveLink(link) {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ url: link.url, key: link.key }));
      return true;
    } catch (err) {
      return false;
    }
  }

  // -------------------------------------------------------------------------
  // Talking to the back end
  // -------------------------------------------------------------------------

  class ApiError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  // Reads use GET, writes use POST with a text/plain body. Both avoid a CORS "preflight" check
  // that Apps Script can't answer. Nothing is cached: responses are read once and kept in memory.
  async function api(action, params, method) {
    let res;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      if (app.demo) {
        res = await app.demo.request(action, params || {});
      } else {
        const payload = Object.assign({ action, key: app.link.key }, params);
        const common = { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal };
        const response = method === 'POST'
          ? await fetch(app.link.url, Object.assign(common, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
          }))
          : await fetch(app.link.url + '?' + new URLSearchParams(payload), common);
        if (!response.ok) throw new ApiError('network', 'HTTP ' + response.status);
        res = await response.json();
      }
    } catch (err) {
      throw err instanceof ApiError ? err : new ApiError('network', String((err && err.message) || err));
    } finally {
      clearTimeout(timer);
    }
    if (!res || typeof res !== 'object') throw new ApiError('network', 'Unexpected reply');
    if (res.error) throw new ApiError(res.error, res.message);
    return res;
  }

  // Writes go one at a time, in the order they were tapped.
  let writeQueue = Promise.resolve();
  function write(action, params) {
    app.pendingWrites++;
    const run = writeQueue.then(() => api(action, params, 'POST'));
    writeQueue = run.catch(() => {}).then(() => {
      app.pendingWrites--;
    });
    return run;
  }

  async function refresh() {
    if (app.refreshing) return;
    app.refreshing = true;
    try {
      const s = await api('state');
      // Don't let an older read overwrite a tap that is still being saved.
      if (app.pendingWrites === 0) applyState(s);
    } catch (err) {
      handleError(err);
    } finally {
      app.refreshing = false;
    }
  }

  function applyState(s) {
    app.data = s;
    app.loadedAt = Date.now();
    renderToday();
  }

  function handleError(err) {
    const code = err && err.code;
    if (code === 'unauthorized') return showMessage('badkey');
    if (code === 'too_long') return toast('That note is a little too long.');
    toast(COPY.offline);
  }

  // -------------------------------------------------------------------------
  // Today
  // -------------------------------------------------------------------------

  function renderToday() {
    const view = $('view-today');
    const d = app.data;
    if (!d) {
      view.setAttribute('aria-busy', 'true');
      view.replaceChildren(todaySkeleton());
      return;
    }
    view.removeAttribute('aria-busy');
    view.replaceChildren(
      h('p', { class: 'date-line' }, formatDay(d.today, { weekday: 'long', month: 'long', day: 'numeric' })),
      myMoodCard(d),
      partnerCard(d),
      weekCard(d)
    );
  }

  function todaySkeleton() {
    const cells = (n, cls) => Array.from({ length: n }, () => h('div', { class: 'skel ' + cls }));
    return h('div', { 'aria-label': 'Loading' },
      h('div', { class: 'skel skel-line short' }),
      h('div', { class: 'card' }, h('div', { class: 'skel skel-line short' }), h('div', { class: 'mood-grid' }, cells(4, 'skel-block'))),
      h('div', { class: 'card' }, h('div', { class: 'skel skel-line short' }), h('div', { class: 'skel skel-line' })),
      h('div', { class: 'card' }, h('div', { class: 'skel skel-line short' }), h('div', { class: 'week-row' }, cells(7, 'skel-cell')))
    );
  }

  function myMoodCard(d) {
    const me = d.moods.me;
    return h('section', { class: 'card', 'aria-labelledby': 'you-title' },
      h('h2', { class: 'card-title', id: 'you-title' }, 'You'),
      h('p', { class: 'card-sub' }, me ? 'Tap another to change it.' : 'How are you today?'),
      h('div', { class: 'mood-grid', role: 'group', 'aria-labelledby': 'you-title' },
        MOODS.map((m) => h('button', {
          type: 'button',
          class: 'mood-btn mood-' + m.value,
          'aria-pressed': String(!!me && me.mood === m.value),
          onclick: () => chooseMood(m.value),
        },
        h('span', { class: 'mood-emoji', 'aria-hidden': 'true' }, m.emoji),
        h('span', { class: 'mood-label' }, m.label),
        h('span', { class: 'mood-check', 'aria-hidden': 'true' }, '✓')))
      ),
      noteArea(me)
    );
  }

  function noteArea(me) {
    const ed = app.noteEditor;
    if (!ed.open) {
      return h('div', { class: 'note-area' },
        me && me.note ? h('p', { class: 'my-note' }, '“' + me.note + '”') : null,
        h('div', { class: 'row' },
          h('button', { type: 'button', class: 'btn btn-quiet', onclick: openNoteEditor }, me && me.note ? 'Edit note' : 'Add a note'),
          me ? h('button', { type: 'button', class: 'btn btn-quiet', onclick: clearMood }, 'Clear my mood') : null
        )
      );
    }
    const count = h('span', { class: 'counter', id: 'note-count' }, counterText(ed.text.length, MOOD_NOTE_MAX));
    const input = h('input', {
      type: 'text',
      id: 'note-input',
      class: 'input',
      maxlength: MOOD_NOTE_MAX,
      value: ed.text,
      placeholder: 'A few words, if you like',
      autocomplete: 'off',
      enterkeyhint: 'done',
      'aria-label': 'Note with your mood',
      'aria-describedby': 'note-count',
      oninput: () => {
        ed.text = input.value;
        count.textContent = counterText(input.value.length, MOOD_NOTE_MAX);
      },
      onkeydown: (e) => {
        if (e.key === 'Enter' && me) {
          e.preventDefault();
          saveNote();
        }
      },
    });
    return h('div', { class: 'note-editor' },
      input,
      h('div', { class: 'row between' },
        h('span', { class: 'hint' }, me ? '' : 'Pick a mood above to save this note with it.'),
        count
      ),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'btn btn-primary', disabled: !me, onclick: saveNote }, 'Save note'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: closeNoteEditor }, 'Cancel')
      )
    );
  }

  function partnerCard(d) {
    const p = d.moods.partner;
    const info = p && moodInfo(p.mood);
    return h('section', { class: 'card', 'aria-labelledby': 'partner-title' },
      h('h2', { class: 'card-title', id: 'partner-title' }, d.names.partner),
      p
        ? [
          h('div', { class: 'partner-mood' },
            h('span', { class: 'big-emoji', 'aria-hidden': 'true' }, info.emoji),
            h('span', { class: 'partner-label' }, info.label)),
          p.note ? h('p', { class: 'partner-note' }, '“' + p.note + '”') : null,
        ]
        : h('p', { class: 'muted partner-empty' }, "Hasn't checked in yet")
    );
  }

  function weekCard(d) {
    const row = (who, name) => [
      h('h3', { class: 'week-name' }, name),
      h('div', { class: 'week-row' }, d.days.map((day) => weekCell(d, day, who, name))),
    ];
    return h('section', { class: 'card', 'aria-labelledby': 'week-title' },
      h('h2', { class: 'card-title', id: 'week-title' }, 'Last 7 days'),
      h('div', { class: 'week-row week-head', 'aria-hidden': 'true' },
        d.days.map((day) => h('span', { class: day.date === d.today ? 'is-today' : null }, formatDay(day.date, { weekday: 'narrow' })))),
      row('me', 'You'),
      row('partner', d.names.partner)
    );
  }

  function weekCell(d, day, who, name) {
    const entry = day[who];
    const info = entry && moodInfo(entry.mood);
    const when = day.date === d.today ? 'Today' : formatDay(day.date, { weekday: 'long', month: 'short', day: 'numeric' });
    return h('button', {
      type: 'button',
      class: 'week-cell' + (info ? '' : ' is-empty') + (day.date === d.today ? ' is-today' : ''),
      'aria-label': when + ', ' + name + ': ' + (info ? info.label : 'no check-in'),
      onclick: () => openDay(day),
    }, info ? info.emoji : '');
  }

  function openDay(day) {
    const d = app.data;
    const line = (name, entry) => {
      const info = entry && moodInfo(entry.mood);
      return h('div', { class: 'day-line' },
        h('span', { class: 'day-emoji', 'aria-hidden': 'true' }, info ? info.emoji : ''),
        h('div', null,
          h('p', { class: 'day-who' }, name + (info ? ': ' + info.label : '')),
          info
            ? (entry.note ? h('p', { class: 'day-note' }, '“' + entry.note + '”') : null)
            : h('p', { class: 'muted' }, 'No check-in')
        )
      );
    };
    const sheet = showSheet(
      [
        h('h2', null, formatDay(day.date, { weekday: 'long', month: 'long', day: 'numeric' })),
        line('You', day.me),
        line(d.names.partner, day.partner),
      ],
      h('button', { type: 'button', class: 'btn', onclick: () => sheet.close() }, 'Close')
    );
  }

  function openNoteEditor() {
    const me = app.data && app.data.moods.me;
    app.noteEditor = { open: true, text: (me && me.note) || '' };
    renderToday();
    focusLater('note-input');
  }

  function closeNoteEditor() {
    app.noteEditor = { open: false, text: '' };
    renderToday();
  }

  function saveNote() {
    const me = app.data && app.data.moods.me;
    if (me) chooseMood(me.mood);
  }

  // Shows the choice straight away, then saves it. Last tap wins.
  async function chooseMood(mood) {
    const d = app.data;
    if (!d) return;
    const before = JSON.stringify(d);
    const params = { mood };
    if (app.noteEditor.open) params.note = app.noteEditor.text;
    const old = d.moods.me;
    const entry = { mood, note: params.note !== undefined ? params.note.trim() : (old ? old.note : '') };
    d.moods.me = entry;
    d.days[d.days.length - 1].me = entry;
    renderToday();
    try {
      const s = await write('setMood', params);
      if (params.note !== undefined) app.noteEditor = { open: false, text: '' };
      applyState(s);
      toast(params.note !== undefined ? 'Note saved' : 'Saved');
    } catch (err) {
      app.data = JSON.parse(before); // undo; any typed note stays in the editor
      renderToday();
      handleError(err);
    }
  }

  async function clearMood() {
    const d = app.data;
    if (!d) return;
    const before = JSON.stringify(d);
    d.moods.me = null;
    d.days[d.days.length - 1].me = null;
    renderToday();
    try {
      applyState(await write('clearMood'));
      toast('Cleared');
    } catch (err) {
      app.data = JSON.parse(before);
      renderToday();
      handleError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Messages instead of the app (not set up yet, old link)
  // -------------------------------------------------------------------------

  function showMessage(kind) {
    document.querySelectorAll('.view').forEach((v) => {
      v.hidden = true;
    });
    const view = $('view-message');
    const kids = [h('p', { class: 'message-text' }, COPY[kind])];
    if (kind === 'setup') {
      kids.push(h('p', { class: 'message-sub' }, 'Each of you has your own link. It comes from the person who set up the app.'));
      if (!app.demo) kids.push(h('a', { class: 'link', href: '?demo' }, 'Preview with made-up data'));
    }
    view.replaceChildren(...kids);
    view.hidden = false;
  }

  function showApp() {
    $('view-message').hidden = true;
    $('view-today').hidden = false;
  }

  // -------------------------------------------------------------------------
  // Start
  // -------------------------------------------------------------------------

  function start() {
    const params = new URLSearchParams(location.search);
    const setup = parseSetupHash(location.hash);
    if (location.hash) {
      // Take the setup link out of the address bar (and browser history) straight away.
      history.replaceState(null, '', location.pathname + location.search);
    }

    if (params.has('demo')) {
      const scenario = params.get('demo') || '';
      $('demo-pill').hidden = false;
      app.demo = window.TwoOfUsDemo.create(scenario);
      if (scenario === 'setup') return showMessage('setup');
    } else {
      if (setup && setup.bad) return showMessage('badlink');
      if (setup && saveLink(setup)) toast('This phone is set up.');
      app.link = setup && !setup.bad ? setup : loadLink();
      if (!app.link) return showMessage('setup');
    }

    showApp();
    renderToday();
    refresh();

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - app.loadedAt > REFRESH_AFTER_MS) refresh();
    });
    window.addEventListener('online', refresh);
  }

  // Pure helpers, exposed so tests can check them.
  window.TwoOfUsApp = { parseSetupHash, isBackendUrl, isKey, APP_VERSION, EXPECTED_BACKEND_VERSION };

  if (typeof document !== 'undefined' && document.getElementById('main')) start();
})();
