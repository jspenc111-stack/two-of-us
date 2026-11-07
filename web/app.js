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
  const JAR_TEXT_MAX = 280;
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
    too_long: 'That is a little too long.',
    empty: 'Write something first.',
    forbidden: 'You can only change your own notes.',
    not_found: 'That note is no longer in the jar.',
  };

  // Screens. Tabs sit at the bottom; the others open on top and close with Back.
  const VIEWS = {
    today: 'view-today',
    jar: 'view-jar',
    'jar-all': 'view-jar-all',
    'jar-form': 'view-jar-form',
    settings: 'view-settings',
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
    blocked: false, // showing a message instead of the app
    offline: false, // the last request couldn't reach the back end
    tab: 'today',
    sub: null, // a screen opened on top of a tab
    jar: null, // jar notes, newest first
    jarLoadedAt: 0,
    jarLoading: null,
    jarFilter: 'all',
    pulledId: null,
    draft: null, // the jar note being written: { id, text, forPartner }
    formError: '',
    saving: false,
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

  // Replaces an element's contents, skipping empty parts (null, false).
  function fill(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
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

  // Asks a yes/no question. Resolves to true only if the confirm button was tapped.
  function confirmSheet(title, confirmLabel, body) {
    return new Promise((resolve) => {
      let answer = false;
      const sheet = showSheet(
        [h('h2', null, title), body ? h('p', { class: 'muted' }, body) : null],
        [
          h('button', { type: 'button', class: 'btn', onclick: () => sheet.close() }, 'Cancel'),
          h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { answer = true; sheet.close(); } }, confirmLabel),
        ]
      );
      sheet.addEventListener('close', () => resolve(answer));
    });
  }

  function jarArt(count) {
    const svg = $('jar-art').content.firstElementChild.cloneNode(true);
    svg.querySelectorAll('.slip').forEach((slip, i) => {
      if (i >= count) slip.setAttribute('display', 'none');
    });
    return svg;
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
    if (app.offline && res.error !== 'server' && res.error !== 'busy') setOffline(false);
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
    if (app.refreshing || app.blocked) return;
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
    $('banner-outdated').hidden = s.version >= EXPECTED_BACKEND_VERSION;
    renderToday();
    if (app.jar && app.jar.length !== s.jarCount) {
      app.jarLoadedAt = 0; // the other person changed the jar
      if (currentView() === 'jar' || currentView() === 'jar-all') loadJar();
    }
    if (currentView() === 'jar') renderJar();
  }

  function errorText(err) {
    return COPY[err && err.code] || COPY.offline;
  }

  // Problems with what was typed get a short message. Anything else means the
  // back end couldn't be reached: show the banner and grey out the last data.
  function handleError(err) {
    const code = err && err.code;
    if (code === 'unauthorized') return showMessage('badkey');
    if (code === 'forbidden' || code === 'not_found') loadJar(true);
    if (Object.prototype.hasOwnProperty.call(COPY, code)) return toast(COPY[code]);
    setOffline(true);
  }

  function friendlyDate(ms) {
    const d = new Date(ms);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(today.getDate() - 1);
    if (d.toDateString() === today.toDateString()) return 'today';
    if (d.toDateString() === yesterday.toDateString()) return 'yesterday';
    return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function setOffline(on) {
    if (app.blocked) return; // a message is showing instead of the app
    app.offline = on;
    $('banner-offline').hidden = !on;
    $('main').classList.toggle('is-stale', on && !!app.data);
    $('last-updated').textContent = on && app.loadedAt ? 'Last updated ' + friendlyDate(app.loadedAt) : '';
    if (!app.data && currentView() === 'today') renderToday();
  }

  function retry() {
    refresh();
    if (currentView() === 'jar' || currentView() === 'jar-all') loadJar(true);
  }

  // -------------------------------------------------------------------------
  // Today
  // -------------------------------------------------------------------------

  function renderToday() {
    const view = $('view-today');
    const d = app.data;
    if (!d) {
      // Nothing loaded yet: placeholders while loading, or just the banner when offline.
      view.setAttribute('aria-busy', String(!app.offline));
      fill(view, app.offline ? null : todaySkeleton());
      return;
    }
    view.removeAttribute('aria-busy');
    fill(view,
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
  // Gratitude jar
  // -------------------------------------------------------------------------

  function names() {
    return app.data ? app.data.names : { me: 'You', partner: 'Your partner' };
  }

  function jarCount() {
    if (app.jar) return app.jar.length;
    return app.data ? app.data.jarCount : null;
  }

  function loadJar(force) {
    if (app.jarLoading) return app.jarLoading;
    if (!force && app.jar && Date.now() - app.jarLoadedAt < REFRESH_AFTER_MS) return Promise.resolve();
    app.jarLoading = (async () => {
      try {
        const res = await api('jarList');
        app.jar = res.notes;
        app.jarLoadedAt = Date.now();
        if (app.data) app.data.jarCount = res.notes.length;
      } catch (err) {
        handleError(err);
      } finally {
        app.jarLoading = null;
        if (currentView() === 'jar') renderJar();
        if (currentView() === 'jar-all') renderJarAll();
      }
    })();
    return app.jarLoading;
  }

  function renderJar() {
    const count = jarCount();
    const pulled = app.jar && app.jar.find((n) => n.id === app.pulledId);
    let countText = '';
    if (count === 0) countText = 'The jar is empty';
    else if (count === 1) countText = '1 note';
    else if (count > 1) countText = count + ' notes';
    fill($('view-jar'),
      h('div', { class: 'card jar-hero' },
        jarArt(count || 0),
        h('p', { class: 'jar-count' }, countText),
        count === 0 ? h('p', { class: 'muted' }, "Drop in something you're grateful for.") : null
      ),
      h('button', { type: 'button', class: 'btn btn-primary btn-block btn-big', onclick: () => openJarForm(null) }, '+ Add to the jar'),
      h('div', { class: 'jar-buttons' },
        h('button', { type: 'button', class: 'btn', disabled: count === 0, onclick: pullOne }, pulled ? 'Pull another' : 'Pull one out'),
        h('button', { type: 'button', class: 'btn', disabled: count === 0, onclick: () => openSub('jar-all') }, 'See all')
      ),
      pulled ? noteCard(pulled, { pulled: true }) : null
    );
  }

  async function pullOne() {
    if (!app.jar) await loadJar(true);
    const notes = app.jar || [];
    if (!notes.length) return;
    let pick = notes[Math.floor(Math.random() * notes.length)];
    while (notes.length > 1 && pick.id === app.pulledId) pick = notes[Math.floor(Math.random() * notes.length)];
    app.pulledId = pick.id;
    renderJar();
    focusLater('pulled-note');
  }

  function noteDate(ymd) {
    const sameYear = app.data && ymd.slice(0, 4) === app.data.today.slice(0, 4);
    return formatDay(ymd, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function noteCard(n, opts) {
    const who = names();
    const forText = n.forPartner ? (n.mine ? 'for ' + who.partner : 'for you') : null;
    return h('article', {
      class: 'note-card' + (opts.pulled ? ' is-pulled' : ''),
      id: opts.pulled ? 'pulled-note' : null,
      tabindex: opts.pulled ? '-1' : null,
    },
    h('p', { class: 'note-text' }, n.text),
    h('p', { class: 'note-meta' },
      h('span', { class: 'note-author' }, n.mine ? who.me : who.partner),
      h('span', { 'aria-hidden': 'true' }, '·'),
      h('span', null, noteDate(n.date)),
      forText ? h('span', { class: 'tag' }, forText) : null
    ),
    opts.actions && n.mine
      ? h('div', { class: 'note-actions' },
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => openJarForm(n) }, 'Edit'),
        h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => deleteJarNote(n) }, 'Delete'))
      : null
    );
  }

  function renderJarAll(focusChip) {
    const view = $('view-jar-all');
    const filters = [['all', 'Everyone'], ['mine', 'Mine'], ['partner', names().partner]];
    const chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Show notes from' },
      filters.map(([value, label]) => h('button', {
        type: 'button',
        class: 'chip',
        'aria-pressed': String(app.jarFilter === value),
        onclick: () => {
          app.jarFilter = value;
          renderJarAll(true);
        },
      }, label)));
    if (!app.jar) {
      fill(view, chips, h('div', { class: 'note-list', 'aria-label': 'Loading' },
        [1, 2, 3].map(() => h('div', { class: 'note-card' }, h('div', { class: 'skel skel-line' }), h('div', { class: 'skel skel-line short' })))));
      return;
    }
    const notes = app.jar.filter((n) => app.jarFilter === 'all' || (app.jarFilter === 'mine') === n.mine);
    const list = [];
    let month = '';
    for (const n of notes) {
      if (n.date.slice(0, 7) !== month) {
        month = n.date.slice(0, 7);
        list.push(h('h2', { class: 'month' }, formatDay(month + '-01', { month: 'long', year: 'numeric' })));
      }
      list.push(noteCard(n, { actions: true }));
    }
    fill(view, chips, notes.length ? h('div', { class: 'note-list' }, list) : h('p', { class: 'muted empty' }, 'No notes here yet.'));
    if (focusChip) view.querySelector('.chip[aria-pressed="true"]').focus();
  }

  function openJarForm(note) {
    const id = note ? note.id : null;
    // A draft for the same note is kept (for example after a failed save), so nothing typed is lost.
    if (!app.draft || app.draft.id !== id) {
      app.draft = note ? { id, text: note.text, forPartner: note.forPartner } : { id: null, text: '', forPartner: false };
    }
    app.formError = '';
    openSub('jar-form');
    focusLater('jar-text');
  }

  function renderJarForm() {
    const d = app.draft || (app.draft = { id: null, text: '', forPartner: false });
    const count = h('span', { class: 'counter', id: 'jar-count' }, counterText(d.text.length, JAR_TEXT_MAX));
    const save = h('button', { type: 'submit', class: 'btn btn-primary', disabled: !d.text.trim() || app.saving }, app.saving ? 'Saving…' : 'Save');
    const textarea = h('textarea', {
      id: 'jar-text',
      class: 'textarea',
      rows: 5,
      maxlength: JAR_TEXT_MAX,
      placeholder: "Something you're grateful for…",
      'aria-label': 'Your note',
      'aria-describedby': 'jar-count',
      oninput: () => {
        d.text = textarea.value;
        count.textContent = counterText(d.text.length, JAR_TEXT_MAX);
        save.disabled = !d.text.trim() || app.saving;
      },
    });
    textarea.value = d.text;
    const toggle = h('input', { type: 'checkbox', role: 'switch', id: 'jar-for', onchange: () => { d.forPartner = toggle.checked; } });
    toggle.checked = d.forPartner;
    fill($('view-jar-form'), h('form', {
      class: 'card form-card',
      novalidate: true,
      onsubmit: (e) => {
        e.preventDefault();
        saveJarNote();
      },
    },
    textarea,
    h('div', { class: 'row between' },
      h('label', { class: 'switch', for: 'jar-for' }, toggle, h('span', null, 'For ' + names().partner)),
      count
    ),
    app.formError ? h('p', { class: 'form-error', role: 'alert' }, app.formError) : null,
    h('div', { class: 'row' },
      save,
      h('button', { type: 'button', class: 'btn btn-quiet', onclick: closeSub }, 'Cancel')
    )));
  }

  async function saveJarNote() {
    const d = app.draft;
    if (!d || !d.text.trim() || app.saving) return;
    app.saving = true;
    app.formError = '';
    renderJarForm();
    try {
      const params = { text: d.text, forPartner: d.forPartner };
      const res = d.id ? await write('jarEdit', Object.assign({ id: d.id }, params)) : await write('jarAdd', params);
      if (app.jar) app.jar = d.id ? app.jar.map((n) => (n.id === d.id ? res.note : n)) : [res.note].concat(app.jar);
      if (app.data) app.data.jarCount = res.jarCount;
      app.draft = null;
      app.saving = false;
      toast(d.id ? 'Saved' : 'Added to the jar');
      closeSub();
    } catch (err) {
      app.saving = false;
      if (err.code === 'unauthorized') return showMessage('badkey');
      if (err.code === 'forbidden' || err.code === 'not_found') {
        app.draft = null;
        loadJar(true);
        toast(errorText(err));
        return closeSub();
      }
      if (!Object.prototype.hasOwnProperty.call(COPY, err.code)) setOffline(true);
      app.formError = errorText(err); // the typed text stays in the form
      renderJarForm();
    }
  }

  async function deleteJarNote(n) {
    if (!(await confirmSheet('Remove this note?', 'Remove'))) return;
    try {
      const res = await write('jarDelete', { id: n.id });
      if (app.jar) app.jar = app.jar.filter((x) => x.id !== n.id);
      if (app.pulledId === n.id) app.pulledId = null;
      if (app.data) app.data.jarCount = res.jarCount;
      if (currentView() === 'jar-all') renderJarAll();
      toast('Removed');
    } catch (err) {
      handleError(err);
    }
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  function renderSettings() {
    const who = names();
    fill($('view-settings'),
      h('section', { class: 'card' },
        h('h2', { class: 'card-title' }, 'People'),
        h('dl', { class: 'facts' },
          h('div', null, h('dt', null, 'You'), h('dd', null, who.me)),
          h('div', null, h('dt', null, 'Partner'), h('dd', null, who.partner))
        ),
        h('p', { class: 'hint' }, 'Names are set in the helper script (Apps Script), not here.')
      ),
      h('section', { class: 'card' },
        h('h2', { class: 'card-title' }, 'Your data'),
        h('p', { class: 'card-sub' }, 'Download all moods and jar notes as a .json file, as a personal backup.'),
        h('button', { type: 'button', class: 'btn btn-block card-btn', id: 'export-btn', onclick: exportAll }, 'Export everything')
      ),
      h('section', { class: 'card' },
        h('h2', { class: 'card-title' }, 'This phone'),
        h('p', { class: 'card-sub' }, 'Your personal link works like a password. Keep a screen lock on your phone.'),
        h('button', { type: 'button', class: 'btn btn-block card-btn', onclick: forgetPhone }, 'Forget this phone')
      ),
      h('p', { class: 'version' },
        'App version ' + APP_VERSION + ' · Helper version ' + (app.data ? app.data.version : '…'))
    );
  }

  // Asks the back end for everything and hands it to the phone as a file download.
  async function exportAll() {
    const btn = $('export-btn');
    btn.disabled = true;
    btn.textContent = 'Preparing…';
    try {
      const res = await api('export');
      delete res.ok;
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = h('a', { href: url, download: 'two-of-us-backup-' + res.exportedOn + '.json', hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      toast('Backup downloaded');
    } catch (err) {
      handleError(err);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Export everything';
    }
  }

  async function forgetPhone() {
    const ok = await confirmSheet('Forget this phone?', 'Forget', "You'll need your personal setup link to use the app here again.");
    if (!ok) return;
    if (!app.demo) {
      try {
        localStorage.removeItem(STORE_KEY);
      } catch (err) {
        // Nothing saved, nothing to remove.
      }
    }
    Object.assign(app, { link: null, data: null, jar: null, draft: null, pulledId: null, sub: null });
    app.noteEditor = { open: false, text: '' };
    showMessage('setup');
  }

  // -------------------------------------------------------------------------
  // Moving between screens
  // -------------------------------------------------------------------------

  function currentView() {
    return app.sub || app.tab;
  }

  function show() {
    if (app.blocked) return;
    const view = currentView();
    for (const [name, id] of Object.entries(VIEWS)) $(id).hidden = name !== view;
    $('view-message').hidden = true;
    $('tabbar').hidden = !!app.sub;
    $('back-btn').hidden = !app.sub;
    $('settings-btn').hidden = !!app.sub;
    let title = 'Two of Us';
    if (view === 'settings') title = 'Settings';
    if (view === 'jar-all') title = 'All notes';
    if (view === 'jar-form') title = app.draft && app.draft.id ? 'Edit note' : 'Add to the jar';
    $('title').textContent = title;
    document.querySelectorAll('.tab').forEach((tab) => {
      if (tab.dataset.tab === app.tab) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    });
    if (view === 'today') renderToday();
    if (view === 'jar') renderJar();
    if (view === 'jar-all') renderJarAll();
    if (view === 'jar-form') renderJarForm();
    if (view === 'settings') renderSettings();
  }

  function setTab(tab) {
    app.tab = tab;
    show();
    window.scrollTo(0, 0);
    if (tab === 'jar') loadJar();
  }

  // Screens on top of a tab get a browser history entry, so the phone's Back gesture closes them.
  function openSub(name) {
    app.sub = name;
    history.pushState({ sub: name }, '');
    show();
    window.scrollTo(0, 0);
    if (name === 'jar-all') loadJar();
  }

  function closeSub() {
    if (app.sub) history.back();
  }

  // -------------------------------------------------------------------------
  // Messages instead of the app (not set up yet, old link)
  // -------------------------------------------------------------------------

  function showMessage(kind) {
    app.blocked = true;
    document.querySelectorAll('.view').forEach((v) => {
      v.hidden = true;
    });
    $('tabbar').hidden = true;
    $('back-btn').hidden = true;
    $('settings-btn').hidden = true;
    $('banner-offline').hidden = true;
    $('banner-outdated').hidden = true;
    $('main').classList.remove('is-stale');
    $('title').textContent = 'Two of Us';
    const view = $('view-message');
    const kids = [jarArt(kind === 'setup' ? 3 : 0), h('p', { class: 'message-text' }, COPY[kind])];
    if (kind === 'setup') {
      kids.push(h('p', { class: 'message-sub' }, 'Each of you has your own link. It comes from the person who set up the app.'));
      if (!app.demo) kids.push(h('a', { class: 'link', href: '?demo' }, 'Preview with made-up data'));
    }
    if (kind === 'badkey' && (app.link || app.demo)) {
      kids.push(h('button', { type: 'button', class: 'btn', onclick: forgetPhone }, 'Forget this phone'));
    }
    fill(view, ...kids);
    view.hidden = false;
  }

  function showApp() {
    app.blocked = false;
    if (history.state && history.state.sub) history.replaceState(null, '');
    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.tab)));
    $('back-btn').addEventListener('click', closeSub);
    $('settings-btn').addEventListener('click', () => openSub('settings'));
    $('retry-btn').addEventListener('click', retry);
    window.addEventListener('popstate', (e) => {
      const sub = e.state && e.state.sub;
      app.sub = VIEWS[sub] ? sub : null;
      show();
    });
    show();
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
    refresh();

    // Makes the app open fast and installable. It stores app files only, never data (see sw.js).
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - app.loadedAt > REFRESH_AFTER_MS) refresh();
    });
    window.addEventListener('online', refresh);
  }

  // Pure helpers, exposed so tests can check them.
  window.TwoOfUsApp = { parseSetupHash, isBackendUrl, isKey, APP_VERSION, EXPECTED_BACKEND_VERSION };

  if (typeof document !== 'undefined' && document.getElementById('main')) start();
})();
