#!/usr/bin/env node
// Two of Us tests. Run with: node tests/run.js
// Uses only Node's built-in modules (no npm packages).
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

// Every file in the repo (except .git), as paths relative to the repo root.
function repoFiles(dir = ROOT, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) repoFiles(full, out);
    else out.push(path.relative(ROOT, full).split(path.sep).join('/'));
  }
  return out;
}

const BINARY = /\.(png|jpe?g|gif|webp|ico|zip|gz|pdf)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|heic|bmp)$/i;

// ---------------------------------------------------------------------------
// Repo hygiene and privacy
// ---------------------------------------------------------------------------

// Patterns that would mean something private slipped into this public repo.
const SECRET_PATTERNS = [
  ['Apps Script web app URL', /script\.google\.com\/(?:a\/macros\/[^\s/]+|macros)\/s\/[A-Za-z0-9_-]{10,}/],
  ['Apps Script deployment ID', /AKfy[A-Za-z0-9_-]{20,}/],
  ['Apps Script project ID', /script\.google\.com\/(?:home\/projects|d)\/[A-Za-z0-9_-]{20,}/],
  ['Google Sheet ID', /docs\.google\.com\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}/],
  ['Google API key', /AIza[0-9A-Za-z_-]{35}/],
  ['Google OAuth token', /ya29\.[0-9A-Za-z_-]{20,}/],
  ['long hex string (looks like a key)', /\b[0-9a-f]{32,}\b/i],
  ['UUID (looks like a key or ID)', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ['filled-in setup link', /#setup=[^\s<>"'`]*(?:\||%7C)[A-Za-z0-9]{16,}/i],
  ['email address', /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/],
  ['real GitHub Pages address', /https?:\/\/[A-Za-z0-9-]+\.github\.io/],
];

test('no secrets, links or emails committed', () => {
  const problems = [];
  for (const file of repoFiles()) {
    if (BINARY.test(file)) continue;
    const text = read(file);
    text.split('\n').forEach((line, i) => {
      for (const [label, re] of SECRET_PATTERNS) {
        if (re.test(line)) problems.push(`${file}:${i + 1} ${label}`);
      }
    });
  }
  assert.deepStrictEqual(problems, [], 'Possible secrets:\n' + problems.join('\n'));
});

test('no screenshots or photos committed (only app icons)', () => {
  const images = repoFiles().filter((f) => IMAGE.test(f) && !f.startsWith('web/icons/'));
  assert.deepStrictEqual(images, []);
});

test('Pages workflow publishes the web/ folder only from main', () => {
  const wf = read('.github/workflows/pages.yml');
  assert.match(wf, /path:\s*web\s*$/m);
  assert.match(wf, /refs\/heads\/main/);
  assert.match(wf, /node tests\/run\.js/);
});

// ---------------------------------------------------------------------------
// Fake Google services, so Code.gs can run in Node's `vm`
// ---------------------------------------------------------------------------

// Made-up keys, built at runtime so no key-like text sits in this file.
const KEY_A = 'sam'.padEnd(40, 'x');
const KEY_B = 'alex'.padEnd(40, 'y');
const FAKE_WEB_APP = 'https://script.google.com/macros/s/FAKE/exec';

// What a real Sheet does to a written value: a leading apostrophe forces plain
// text (and is dropped), otherwise dates, numbers and formulas get converted.
function sheetStore(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith("'")) return value.slice(1);
  if (value.startsWith('=')) return { formula: value };
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(value + 'T00:00:00Z');
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    Object.assign(this, { sheet, row, col, numRows, numCols });
  }
  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const src = this.sheet.rows[this.row - 1 + r] || [];
      const line = [];
      for (let c = 0; c < this.numCols; c++) {
        const v = src[this.col - 1 + c];
        line.push(v === undefined ? '' : v);
      }
      out.push(line);
    }
    return out;
  }
  setValues(values) {
    if (values.length !== this.numRows || values.some((v) => v.length !== this.numCols)) {
      throw new Error('setValues: data size does not match the range');
    }
    values.forEach((line, r) => {
      const idx = this.row - 1 + r;
      while (this.sheet.rows.length <= idx) this.sheet.rows.push([]);
      line.forEach((v, c) => {
        this.sheet.rows[idx][this.col - 1 + c] = sheetStore(v);
      });
    });
    return this;
  }
  setFontWeight() {
    return this;
  }
}

class FakeSheet {
  constructor(name) {
    this.name = name;
    this.rows = [];
    this.frozen = 0;
  }
  getName() {
    return this.name;
  }
  getLastRow() {
    return this.rows.length;
  }
  getLastColumn() {
    return this.rows.reduce((m, r) => Math.max(m, r.length), 0);
  }
  getRange(row, col, numRows = 1, numCols = 1) {
    return new FakeRange(this, row, col, numRows, numCols);
  }
  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(1, this.getLastRow()), Math.max(1, this.getLastColumn()));
  }
  appendRow(values) {
    this.rows.push(Array.from(values, sheetStore));
    return this;
  }
  deleteRow(row) {
    if (row < 1 || row > this.rows.length) throw new Error('deleteRow: row out of range');
    this.rows.splice(row - 1, 1);
  }
  setFrozenRows(n) {
    this.frozen = n;
  }
}

// `now` is a fake clock. Code.gs sees it through `new Date()`.
function makeEnv(opts = {}) {
  const env = {
    now: Date.parse(opts.now || '2026-09-30T15:00:00Z'),
    props: Object.assign(
      { KEY_A, KEY_B, NAME_A: 'Sam', NAME_B: 'Alex', TIMEZONE: 'America/New_York', SITE_URL: 'https://example.test/two-of-us/' },
      opts.props
    ),
    sheets: {},
    logs: [],
    lock: { held: false, waits: 0, releases: 0, busy: false },
    webAppUrl: opts.webAppUrl === undefined ? FAKE_WEB_APP : opts.webAppUrl,
  };
  for (const k of Object.keys(env.props)) if (env.props[k] == null) delete env.props[k];

  const spreadsheet = {
    getSheetByName: (name) => env.sheets[name] || null,
    insertSheet: (name) => (env.sheets[name] = new FakeSheet(name)),
  };
  const scriptProps = {
    getProperty: (k) => (Object.prototype.hasOwnProperty.call(env.props, k) ? env.props[k] : null),
    getProperties: () => Object.assign({}, env.props),
    setProperty(k, v) {
      env.props[k] = String(v);
      return scriptProps;
    },
    deleteProperty(k) {
      delete env.props[k];
      return scriptProps;
    },
  };

  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(env.now);
      else super(...args);
    }
    static now() {
      return env.now;
    }
  }

  env.globals = {
    SpreadsheetApp: { getActiveSpreadsheet: () => spreadsheet, flush() {} },
    PropertiesService: { getScriptProperties: () => scriptProps },
    LockService: {
      getScriptLock: () => ({
        waitLock() {
          if (env.lock.busy) throw new Error('Lock timeout');
          env.lock.held = true;
          env.lock.waits++;
        },
        releaseLock() {
          env.lock.held = false;
          env.lock.releases++;
        },
      }),
    },
    Utilities: {
      formatDate(date, tz, format) {
        if (format !== 'yyyy-MM-dd') throw new Error('Fake formatDate only knows yyyy-MM-dd, got ' + format);
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
        const get = (type) => parts.find((p) => p.type === type).value;
        return `${get('year')}-${get('month')}-${get('day')}`;
      },
      getUuid: () => crypto.randomUUID(),
    },
    ContentService: {
      MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
      createTextOutput: (text) => ({
        text,
        mime: null,
        setMimeType(m) {
          this.mime = m;
          return this;
        },
        getContent() {
          return this.text;
        },
      }),
    },
    Logger: { log: (msg) => env.logs.push(String(msg)) },
    ScriptApp: {
      getService: () => ({ getUrl: () => env.webAppUrl }),
    },
    Date: FakeDate,
  };
  env.sheet = (name) => env.sheets[name];
  return env;
}

// Loads Code.gs into a fresh sandbox. Returns its functions plus API helpers.
function loadBackend(opts = {}) {
  const env = makeEnv(opts);
  const ctx = vm.createContext(Object.assign({}, env.globals));
  vm.runInContext(read('apps-script/Code.gs'), ctx, { filename: 'Code.gs' });
  const unwrap = (out) => {
    assert.strictEqual(out.mime, 'application/json');
    return JSON.parse(out.getContent());
  };
  const b = {
    env,
    ctx,
    get: (key, action, params = {}) => unwrap(ctx.doGet({ parameter: Object.assign({ action, key }, params) })),
    post: (key, action, params = {}) =>
      unwrap(ctx.doPost({ postData: { type: 'text/plain', contents: JSON.stringify(Object.assign({ action, key }, params)) } })),
    rows: (name) => env.sheet(name).rows.slice(1),
  };
  if (opts.setup !== false) {
    ctx.setup();
    env.logs.length = 0;
  }
  return b;
}

function ymd(offsetDays, from = '2026-09-30') {
  const d = new Date(from + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Back end: setup, keys, links
// ---------------------------------------------------------------------------

test('setup adds the Moods and Jar tabs with headers', () => {
  const b = loadBackend();
  assert.deepStrictEqual(b.env.sheet('Moods').rows[0], ['date', 'person', 'mood', 'note', 'updatedAt']);
  assert.deepStrictEqual(b.env.sheet('Jar').rows[0], ['id', 'date', 'person', 'text', 'forPartner', 'createdAt', 'updatedAt']);
  assert.strictEqual(b.env.sheet('Moods').frozen, 1);
});

test('setup makes two different keys when missing and logs both links', () => {
  const b = loadBackend({ props: { KEY_A: null, KEY_B: null }, setup: false });
  b.ctx.setup();
  const { KEY_A: a, KEY_B: bKey } = b.env.props;
  assert.match(a, /^[A-Za-z0-9]{32,}$/);
  assert.match(bKey, /^[A-Za-z0-9]{32,}$/);
  assert.notStrictEqual(a, bKey);
  const log = b.env.logs.join('\n');
  assert.ok(log.includes('Personal link for Sam'));
  assert.ok(log.includes('Personal link for Alex'));
  const links = log.match(/https:\/\/example\.test\/two-of-us\/#setup=\S+/g);
  assert.strictEqual(links.length, 2);
  const decoded = decodeURIComponent(links[0].split('#setup=')[1]);
  assert.strictEqual(decoded, FAKE_WEB_APP + '|' + a);
  assert.strictEqual(b.env.props.TIMEZONE, 'America/New_York');
});

test('setup is safe to run twice (keeps keys and data)', () => {
  const b = loadBackend();
  b.post(KEY_A, 'setMood', { mood: 'good' });
  b.ctx.setup();
  assert.strictEqual(b.env.props.KEY_A, KEY_A);
  assert.strictEqual(b.env.props.KEY_B, KEY_B);
  assert.strictEqual(b.rows('Moods').length, 1);
  assert.strictEqual(b.env.sheet('Moods').rows[0][0], 'date');
});

test('getLinks explains what to do when SITE_URL or the web app address is missing', () => {
  const noSite = loadBackend({ props: { SITE_URL: null } });
  noSite.ctx.getLinks();
  assert.match(noSite.env.logs.join('\n'), /SITE_URL/);
  assert.doesNotMatch(noSite.env.logs.join('\n'), /#setup=/);

  const noUrl = loadBackend({ webAppUrl: null });
  noUrl.ctx.getLinks();
  assert.match(noUrl.env.logs.join('\n'), /WEB_APP_URL/);

  const override = loadBackend({ webAppUrl: null, props: { WEB_APP_URL: 'https://script.google.com/macros/s/OTHER/exec' } });
  override.ctx.getLinks();
  assert.match(override.env.logs.join('\n'), /#setup=https%3A%2F%2Fscript\.google\.com%2Fmacros%2Fs%2FOTHER%2Fexec%7C/);
});

test('resetKeys makes new keys and old links stop working', () => {
  const b = loadBackend();
  b.ctx.resetKeys();
  assert.notStrictEqual(b.env.props.KEY_A, KEY_A);
  assert.notStrictEqual(b.env.props.KEY_B, KEY_B);
  assert.deepStrictEqual(b.get(KEY_A, 'state'), { error: 'unauthorized' });
  assert.strictEqual(b.get(b.env.props.KEY_A, 'state').names.me, 'Sam');
  assert.match(b.env.logs.join('\n'), /#setup=/);
});

// ---------------------------------------------------------------------------
// Back end: keys and requests
// ---------------------------------------------------------------------------

test('unknown, missing or empty key is rejected with no data', () => {
  const b = loadBackend({ props: { KEY_B: null } });
  for (const key of ['nope', 'wrong'.padEnd(40, 'z'), '', undefined, KEY_A.toUpperCase()]) {
    assert.deepStrictEqual(b.get(key, 'state'), { error: 'unauthorized' });
    assert.deepStrictEqual(b.post(key, 'setMood', { mood: 'good' }), { error: 'unauthorized' });
  }
  assert.strictEqual(b.rows('Moods').length, 0);
});

test('each key maps to the right person', () => {
  const b = loadBackend();
  const a = b.get(KEY_A, 'state');
  const bb = b.get(KEY_B, 'state');
  assert.deepStrictEqual(a.names, { me: 'Sam', partner: 'Alex' });
  assert.deepStrictEqual(bb.names, { me: 'Alex', partner: 'Sam' });
  b.post(KEY_A, 'setMood', { mood: 'great' });
  assert.strictEqual(b.rows('Moods')[0][1], 'A');
  assert.strictEqual(b.get(KEY_B, 'state').moods.partner.mood, 'great');
  assert.strictEqual(b.get(KEY_B, 'state').moods.me, null);
});

test('bad requests are rejected', () => {
  const b = loadBackend();
  assert.strictEqual(b.get(KEY_A, 'nope').error, 'bad_request');
  assert.strictEqual(b.get(KEY_A, 'setMood', { mood: 'good' }).error, 'bad_request'); // writes need POST
  assert.strictEqual(b.post(KEY_A, 'state').error, 'bad_request');
  assert.strictEqual(b.post(KEY_A, 'toString').error, 'bad_request');
  const raw = JSON.parse(b.ctx.doPost({ postData: { contents: 'not json' } }).getContent());
  assert.strictEqual(raw.error, 'bad_request');
  assert.strictEqual(JSON.parse(b.ctx.doGet(undefined).getContent()).error, 'unauthorized');
});

// ---------------------------------------------------------------------------
// Back end: moods
// ---------------------------------------------------------------------------

test('mood: one per person per day, a new tap replaces it', () => {
  const b = loadBackend();
  b.post(KEY_A, 'setMood', { mood: 'great' });
  const s = b.post(KEY_A, 'setMood', { mood: 'okay' });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.moods.me.mood, 'okay');
  const rows = b.rows('Moods');
  assert.strictEqual(rows.length, 1);
  assert.deepStrictEqual(rows[0].slice(0, 3), ['2026-09-30', 'A', 'okay']);
  b.post(KEY_B, 'setMood', { mood: 'rough' });
  assert.strictEqual(b.rows('Moods').length, 2);
});

test('mood: invalid value rejected, nothing saved', () => {
  const b = loadBackend();
  for (const mood of ['meh', '', 'GREAT', undefined, 'great ']) {
    assert.strictEqual(b.post(KEY_A, 'setMood', { mood }).error, 'bad_request');
  }
  assert.strictEqual(b.rows('Moods').length, 0);
});

test('mood note: trimmed, max 140, kept when left out, replaced when sent', () => {
  const b = loadBackend();
  assert.strictEqual(b.post(KEY_A, 'setMood', { mood: 'good', note: '  ' + 'x'.repeat(141) + '  ' }).error, 'too_long');
  assert.strictEqual(b.rows('Moods').length, 0);
  const s = b.post(KEY_A, 'setMood', { mood: 'good', note: '  ' + 'n'.repeat(140) + '  ' });
  assert.strictEqual(s.moods.me.note, 'n'.repeat(140));
  assert.strictEqual(b.post(KEY_A, 'setMood', { mood: 'okay' }).moods.me.note, 'n'.repeat(140));
  assert.strictEqual(b.post(KEY_A, 'setMood', { mood: 'okay', note: 'Line one\nline two' }).moods.me.note, 'Line one line two');
  assert.strictEqual(b.post(KEY_A, 'setMood', { mood: 'okay', note: '' }).moods.me.note, '');
});

test('text is stored as plain text (never a date or a formula)', () => {
  const b = loadBackend();
  const s = b.post(KEY_A, 'setMood', { mood: 'good', note: '=IMPORTXML("x")' });
  assert.strictEqual(s.moods.me.note, '=IMPORTXML("x")');
  b.post(KEY_B, 'setMood', { mood: 'good', note: '2026-01-02' });
  assert.strictEqual(b.get(KEY_B, 'state').moods.me.note, '2026-01-02');
  assert.strictEqual(typeof b.rows('Moods')[0][0], 'string');
});

test('mood: clear removes only your own mood for today', () => {
  const b = loadBackend();
  b.post(KEY_A, 'setMood', { mood: 'good' });
  b.post(KEY_B, 'setMood', { mood: 'okay' });
  const s = b.post(KEY_A, 'clearMood');
  assert.strictEqual(s.moods.me, null);
  assert.strictEqual(s.moods.partner.mood, 'okay');
  assert.deepStrictEqual(b.rows('Moods').map((r) => r[1]), ['B']);
});

test('mood: the server decides the date in TIMEZONE (day boundary)', () => {
  // 03:30 UTC on 10 March is still 23:30 on 9 March in New York.
  const b = loadBackend({ now: '2026-03-10T03:30:00Z' });
  let s = b.post(KEY_A, 'setMood', { mood: 'good', date: '2020-01-01' }); // a date from the phone is ignored
  assert.strictEqual(s.today, '2026-03-09');
  b.env.now = Date.parse('2026-03-10T04:30:00Z'); // 00:30 in New York: a new day
  s = b.post(KEY_A, 'setMood', { mood: 'rough' });
  assert.strictEqual(s.today, '2026-03-10');
  assert.deepStrictEqual(b.rows('Moods').map((r) => [r[0], r[2]]), [['2026-03-09', 'good'], ['2026-03-10', 'rough']]);
  assert.strictEqual(s.days[5].me.mood, 'good');

  const tokyo = loadBackend({ now: '2026-03-10T03:30:00Z', props: { TIMEZONE: 'Asia/Tokyo' } });
  assert.strictEqual(tokyo.get(KEY_A, 'state').today, '2026-03-10');
});

test('state returns the right 7-day window, oldest first', () => {
  const b = loadBackend();
  const moods = b.env.sheet('Moods');
  for (const off of [-8, -7, -6, -3, 0, 1]) moods.rows.push([ymd(off), 'A', 'good', 'day ' + off, new Date()]);
  moods.rows.push([ymd(-2), 'B', 'rough', '', new Date()]);
  moods.rows.push([new Date(ymd(-1) + 'T12:00:00Z'), 'B', 'great', 'typed by hand', new Date()]); // a real date cell
  moods.rows.push([ymd(-5), 'B', 'unknown-mood', '', new Date()]);

  const s = b.get(KEY_A, 'state');
  assert.strictEqual(s.today, '2026-09-30');
  assert.deepStrictEqual(s.days.map((d) => d.date), [-6, -5, -4, -3, -2, -1, 0].map((o) => ymd(o)));
  assert.deepStrictEqual(s.days.map((d) => d.me && d.me.note), ['day -6', null, null, 'day -3', null, null, 'day 0']);
  assert.deepStrictEqual(s.days.map((d) => d.partner && d.partner.mood), [null, null, null, null, 'rough', 'great', null]);
  assert.deepStrictEqual(s.moods.me, { mood: 'good', note: 'day 0' });
  assert.strictEqual(s.version, vm.runInContext('VERSION', b.ctx));
  assert.strictEqual(s.jarCount, 0);
});

test('writes hold the lock, and a busy lock saves nothing', () => {
  const b = loadBackend();
  b.post(KEY_A, 'setMood', { mood: 'good' });
  b.post(KEY_A, 'clearMood');
  assert.strictEqual(b.env.lock.waits, 2);
  assert.strictEqual(b.env.lock.releases, 2);
  assert.strictEqual(b.env.lock.held, false);
  b.env.lock.busy = true;
  assert.strictEqual(b.post(KEY_A, 'setMood', { mood: 'good' }).error, 'busy');
  assert.strictEqual(b.rows('Moods').length, 0);
});

test('requests never write moods or notes to the log', () => {
  const b = loadBackend();
  b.post(KEY_A, 'setMood', { mood: 'rough', note: 'private words' });
  b.get(KEY_B, 'state');
  b.post(KEY_A, 'clearMood');
  assert.deepStrictEqual(b.env.logs, []);
});

// ---------------------------------------------------------------------------
// Back end: gratitude jar
// ---------------------------------------------------------------------------

test('jar: add saves author, date, text and "for partner"', () => {
  const b = loadBackend();
  const res = b.post(KEY_A, 'jarAdd', { text: '  The sunset tonight\nand you  ', forPartner: true });
  assert.strictEqual(res.ok, true);
  assert.deepStrictEqual(Object.assign({}, res.note, { id: 'x' }), { id: 'x', date: '2026-09-30', mine: true, text: 'The sunset tonight\nand you', forPartner: true });
  assert.strictEqual(res.jarCount, 1);
  const row = b.rows('Jar')[0];
  assert.deepStrictEqual(row.slice(0, 5), [res.note.id, '2026-09-30', 'A', 'The sunset tonight\nand you', true]);
  b.post(KEY_B, 'jarAdd', { text: 'Soup', forPartner: false });
  assert.strictEqual(b.rows('Jar')[1][4], false);
  assert.notStrictEqual(b.rows('Jar')[1][0], res.note.id);
  assert.strictEqual(b.get(KEY_B, 'state').jarCount, 2);
});

test('jar: length limits (1 to 280 characters after trimming)', () => {
  const b = loadBackend();
  for (const text of ['', '   ', '\n\n', undefined]) assert.strictEqual(b.post(KEY_A, 'jarAdd', { text }).error, 'empty');
  assert.strictEqual(b.post(KEY_A, 'jarAdd', { text: 'x'.repeat(281) }).error, 'too_long');
  assert.strictEqual(b.rows('Jar').length, 0);
  assert.strictEqual(b.post(KEY_A, 'jarAdd', { text: ' ' + 'x'.repeat(280) + ' ' }).note.text.length, 280);
  const id = b.rows('Jar')[0][0];
  assert.strictEqual(b.post(KEY_A, 'jarEdit', { id, text: 'y'.repeat(281) }).error, 'too_long');
  assert.strictEqual(b.post(KEY_A, 'jarEdit', { id, text: ' ' }).error, 'empty');
  assert.strictEqual(b.rows('Jar')[0][3], 'x'.repeat(280));
  assert.strictEqual(b.post(KEY_A, 'jarAdd', { text: '=HYPERLINK("x")' }).note.text, '=HYPERLINK("x")');
  assert.strictEqual(b.rows('Jar')[1][3], '=HYPERLINK("x")');
});

test('jar: list is newest first and both people see every note', () => {
  const b = loadBackend({ now: '2026-09-01T15:00:00Z' });
  b.post(KEY_A, 'jarAdd', { text: 'first' });
  b.env.now = Date.parse('2026-09-20T15:00:00Z');
  b.post(KEY_B, 'jarAdd', { text: 'second', forPartner: true });
  b.env.now += 60000;
  b.post(KEY_A, 'jarAdd', { text: 'third' });
  b.env.now = Date.parse('2026-09-30T15:00:00Z');
  b.post(KEY_B, 'jarAdd', { text: 'fourth' });

  const a = b.get(KEY_A, 'jarList');
  assert.strictEqual(a.ok, true);
  assert.deepStrictEqual(a.notes.map((n) => n.text), ['fourth', 'third', 'second', 'first']);
  assert.deepStrictEqual(a.notes.map((n) => n.mine), [false, true, false, true]);
  assert.deepStrictEqual(a.notes.map((n) => n.date), ['2026-09-30', '2026-09-20', '2026-09-20', '2026-09-01']);
  assert.strictEqual(a.notes[2].forPartner, true);
  const bList = b.get(KEY_B, 'jarList');
  assert.deepStrictEqual(bList.notes.map((n) => n.mine), [true, false, true, false]);
  assert.deepStrictEqual(b.get('nope', 'jarList'), { error: 'unauthorized' });
});

test('jar: edit and delete your own notes only (checked on the server)', () => {
  const b = loadBackend();
  const mine = b.post(KEY_A, 'jarAdd', { text: 'mine' }).note;
  const theirs = b.post(KEY_B, 'jarAdd', { text: 'theirs' }).note;

  const edited = b.post(KEY_A, 'jarEdit', { id: mine.id, text: 'mine, edited', forPartner: true });
  assert.deepStrictEqual(Object.assign({}, edited.note), { id: mine.id, date: '2026-09-30', mine: true, text: 'mine, edited', forPartner: true });
  assert.strictEqual(b.rows('Jar')[0][2], 'A');

  assert.strictEqual(b.post(KEY_A, 'jarEdit', { id: theirs.id, text: 'hijack' }).error, 'forbidden');
  assert.strictEqual(b.post(KEY_A, 'jarDelete', { id: theirs.id }).error, 'forbidden');
  assert.strictEqual(b.rows('Jar')[1][3], 'theirs');
  assert.strictEqual(b.post(KEY_A, 'jarEdit', { id: 'missing', text: 'x' }).error, 'not_found');
  assert.strictEqual(b.post(KEY_A, 'jarDelete', { id: '' }).error, 'not_found');
  assert.strictEqual(b.post('nope', 'jarDelete', { id: mine.id }).error, 'unauthorized');

  assert.deepStrictEqual(b.post(KEY_A, 'jarDelete', { id: mine.id }), { ok: true, jarCount: 1 });
  assert.deepStrictEqual(b.rows('Jar').map((r) => r[3]), ['theirs']);
  assert.strictEqual(b.post(KEY_B, 'jarDelete', { id: theirs.id }).jarCount, 0);
  assert.strictEqual(b.env.lock.held, false);
});

// ---------------------------------------------------------------------------
// Back end: export
// ---------------------------------------------------------------------------

test('export: everything from both people, dates only (no times)', () => {
  const b = loadBackend();
  b.post(KEY_A, 'setMood', { mood: 'good', note: 'a note' });
  b.post(KEY_B, 'setMood', { mood: 'rough' });
  b.post(KEY_B, 'jarAdd', { text: 'thanks', forPartner: true });
  const ex = b.get(KEY_A, 'export');
  assert.strictEqual(ex.ok, true);
  assert.deepStrictEqual(ex.people, { A: 'Sam', B: 'Alex' });
  assert.strictEqual(ex.exportedOn, '2026-09-30');
  assert.deepStrictEqual(ex.moods, [
    { date: '2026-09-30', person: 'A', name: 'Sam', mood: 'good', note: 'a note' },
    { date: '2026-09-30', person: 'B', name: 'Alex', mood: 'rough', note: '' },
  ]);
  assert.deepStrictEqual(ex.jar.map((n) => [n.person, n.name, n.text, n.forPartner]), [['B', 'Alex', 'thanks', true]]);
  assert.ok(!/T\d\d:\d\d/.test(JSON.stringify(ex)), 'no times in the export');
  assert.deepStrictEqual(b.get('nope', 'export'), { error: 'unauthorized' });
  assert.strictEqual(b.post(KEY_A, 'export').error, 'bad_request');
  assert.deepStrictEqual(b.env.logs, []);
});

// ---------------------------------------------------------------------------
// Back end: least privilege
// ---------------------------------------------------------------------------

test('appsscript.json: V8, only the current-Sheet scope, web app runs as owner for anyone', () => {
  const m = JSON.parse(read('apps-script/appsscript.json'));
  assert.strictEqual(m.runtimeVersion, 'V8');
  assert.deepStrictEqual(m.oauthScopes, ['https://www.googleapis.com/auth/spreadsheets.currentonly']);
  assert.deepStrictEqual(m.webapp, { executeAs: 'USER_DEPLOYING', access: 'ANYONE_ANONYMOUS' });
});

test('Code.gs only touches its own Sheet (no openById, Drive, Gmail, Calendar, UrlFetch)', () => {
  const code = read('apps-script/Code.gs');
  for (const banned of ['openById', 'openByUrl', 'DriveApp', 'GmailApp', 'MailApp', 'CalendarApp', 'UrlFetchApp', 'DocumentApp']) {
    assert.ok(!code.includes(banned), 'Code.gs uses ' + banned);
  }
});

test('only setup, getLinks, resetKeys, doGet and doPost are public', () => {
  const code = read('apps-script/Code.gs');
  const names = [...code.matchAll(/^function\s+([A-Za-z0-9_$]+)/gm)].map((m) => m[1]);
  const pub = names.filter((n) => !n.endsWith('_')).sort();
  assert.deepStrictEqual(pub, ['doGet', 'doPost', 'getLinks', 'resetKeys', 'setup']);
});

// ---------------------------------------------------------------------------
// Front end
// ---------------------------------------------------------------------------

const WEB_TEXT = /\.(html|css|js|webmanifest|json)$/;
const webFiles = () => repoFiles().filter((f) => f.startsWith('web/') && WEB_TEXT.test(f));
const webScripts = () => webFiles().filter((f) => f.endsWith('.js'));

// Loads a web script into a sandbox with a bare `window` (no page), for its helpers.
function loadWebScript(file) {
  const ctx = vm.createContext({ window: {}, setTimeout, clearTimeout, URLSearchParams });
  vm.runInContext(read(file), ctx, { filename: file });
  return ctx.window;
}

test('VERSION in Code.gs matches EXPECTED_BACKEND_VERSION in web/app.js', () => {
  const backend = read('apps-script/Code.gs').match(/^const VERSION = (\d+);/m);
  const web = read('web/app.js').match(/const EXPECTED_BACKEND_VERSION = (\d+);/);
  assert.ok(backend && web, 'both version lines must exist');
  assert.strictEqual(web[1], backend[1]);
  assert.strictEqual(loadWebScript('web/app.js').TwoOfUsApp.EXPECTED_BACKEND_VERSION, Number(backend[1]));
});

test('user text is never inserted as HTML', () => {
  for (const file of webScripts()) {
    const code = read(file);
    for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'createContextualFragment']) {
      assert.ok(!code.includes(banned), `${file} uses ${banned}`);
    }
  }
});

test('the app loads nothing from other sites and talks only to Apps Script', () => {
  const allowed = [/^https:\/\/script\.google\.com(\/|\s|$)/, /^https:\/\/\*\.googleusercontent\.com(\s|$)/, /^http:\/\/www\.w3\.org\/2000\/svg$/];
  for (const file of webFiles()) {
    for (const [url] of read(file).matchAll(/(?:https?:)?\/\/[A-Za-z0-9*.-]+\.[A-Za-z]{2,}[^\s'"`)<>;]*/g)) {
      const full = url.startsWith('//') ? 'https:' + url : url;
      assert.ok(allowed.some((re) => re.test(full)), `${file} refers to ${url}`);
    }
    assert.ok(!/@import|@font-face/.test(read(file)), `${file} loads fonts or stylesheets`);
  }
  const html = read('web/index.html');
  assert.match(html, /connect-src 'self' https:\/\/script\.google\.com https:\/\/\*\.googleusercontent\.com;/);
  assert.match(html, /script-src 'self'/);
});

test('the phone stores only the back end address and key', () => {
  for (const file of webScripts()) {
    const code = read(file);
    for (const banned of ['sessionStorage', 'indexedDB', 'document.cookie', 'caches.put', 'openDatabase']) {
      assert.ok(!code.includes(banned), `${file} uses ${banned}`);
    }
    const writes = [...code.matchAll(/localStorage\.setItem\(\s*([^,]*),([^\n]*)/g)].map((m) => m[1] + ' <- ' + m[2].trim());
    if (file === 'web/app.js') {
      assert.deepStrictEqual(writes, ['STORE_KEY <- JSON.stringify({ url: link.url, key: link.key }));']);
    } else {
      assert.deepStrictEqual(writes, [], `${file} writes to localStorage`);
    }
  }
});

test('setup link: reads the address and key, rejects broken links', () => {
  const { parseSetupHash } = loadWebScript('web/app.js').TwoOfUsApp;
  const key = 'k'.repeat(40);
  const plain = parseSetupHash('#setup=' + FAKE_WEB_APP + '|' + key);
  assert.strictEqual(plain.url, FAKE_WEB_APP);
  assert.strictEqual(plain.key, key);
  const encoded = parseSetupHash('#setup=' + encodeURIComponent(FAKE_WEB_APP + '|' + key));
  assert.strictEqual(encoded.url, FAKE_WEB_APP);
  assert.strictEqual(encoded.key, key);
  const workspace = 'https://script.google.com/a/macros/example.test/s/FAKE/exec';
  assert.strictEqual(parseSetupHash('#setup=' + workspace + '|' + key).url, workspace);

  assert.strictEqual(parseSetupHash(''), null);
  assert.strictEqual(parseSetupHash('#other'), null);
  for (const bad of [
    '#setup=',
    '#setup=' + FAKE_WEB_APP,
    '#setup=' + FAKE_WEB_APP + '|short',
    '#setup=https://evil.example/exec|' + key,
    '#setup=http://script.google.com/macros/s/FAKE/exec|' + key,
    '#setup=' + FAKE_WEB_APP + '|' + key + '<b>',
    '#setup=%E0%A4%A',
  ]) {
    assert.strictEqual(parseSetupHash(bad).bad, true, bad);
  }
});

// The demo's pretend back end should answer in the same shape as the real one.
function shape(v) {
  if (Array.isArray(v)) return v.length ? [shape(v[v.length - 1])] : [];
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
  return v === null ? 'null' : typeof v;
}

test('demo mode answers like the real back end (made-up names only)', async () => {
  const fake = loadWebScript('web/demo.js').TwoOfUsDemo.create('');
  const demo = { request: async (action, params) => JSON.parse(JSON.stringify(await fake.request(action, params))) };
  const real = loadBackend();
  real.post(KEY_B, 'setMood', { mood: 'good', note: 'hi' });
  const realState = real.post(KEY_A, 'setMood', { mood: 'okay', note: 'hello' });
  const demoState = await demo.request('setMood', { mood: 'okay', note: 'hello' });
  assert.deepStrictEqual(shape(demoState), shape(realState));
  assert.deepStrictEqual(demoState.names, { me: 'Sam', partner: 'Alex' });
  assert.strictEqual(demoState.version, realState.version);
  assert.strictEqual((await demo.request('setMood', { mood: 'meh' })).error, 'bad_request');
  assert.strictEqual((await demo.request('clearMood')).moods.me, null);

  const realAdd = real.post(KEY_A, 'jarAdd', { text: 'hello', forPartner: true });
  const demoAdd = await demo.request('jarAdd', { text: 'hello', forPartner: true });
  assert.deepStrictEqual(shape(demoAdd), shape(realAdd));
  assert.deepStrictEqual(shape(await demo.request('jarList')), shape(real.get(KEY_A, 'jarList')));
  assert.deepStrictEqual(shape(await demo.request('jarEdit', { id: demoAdd.note.id, text: 'hi' })), shape(real.post(KEY_A, 'jarEdit', { id: realAdd.note.id, text: 'hi' })));
  assert.deepStrictEqual(await demo.request('jarDelete', { id: demoAdd.note.id }), { ok: true, jarCount: 12 });
  const partnerNote = (await demo.request('jarList')).notes.find((n) => !n.mine);
  assert.strictEqual((await demo.request('jarDelete', { id: partnerNote.id })).error, 'forbidden');
  assert.strictEqual((await demo.request('jarAdd', { text: 'x'.repeat(281) })).error, 'too_long');
  const demoExport = await demo.request('export');
  const realExport = real.get(KEY_A, 'export');
  assert.deepStrictEqual(shape(demoExport), shape(realExport));
});

// ---------------------------------------------------------------------------
// Installable app (PWA)
// ---------------------------------------------------------------------------

function pngSize(file) {
  const buf = fs.readFileSync(path.join(ROOT, file));
  assert.strictEqual(buf.toString('ascii', 1, 4), 'PNG', file + ' is not a PNG');
  return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
}

test('manifest: standalone, portrait, colours, 192/512 icons and a maskable icon', () => {
  const m = JSON.parse(read('web/manifest.webmanifest'));
  assert.strictEqual(m.name, 'Two of Us');
  assert.strictEqual(m.short_name, 'Two of Us');
  assert.strictEqual(m.display, 'standalone');
  assert.strictEqual(m.orientation, 'portrait');
  assert.strictEqual(m.start_url, './');
  assert.match(m.theme_color, /^#[0-9a-f]{6}$/i);
  assert.match(m.background_color, /^#[0-9a-f]{6}$/i);
  for (const icon of m.icons) {
    const [w, hgt] = pngSize('web/' + icon.src);
    assert.strictEqual(`${w}x${hgt}`, icon.sizes, icon.src);
  }
  const sizes = (purpose) => m.icons.filter((i) => i.purpose === purpose).map((i) => i.sizes);
  assert.deepStrictEqual(sizes('any'), ['192x192', '512x512']);
  assert.ok(sizes('maskable').includes('512x512'));
  assert.match(read('web/index.html'), /<link rel="manifest" href="manifest\.webmanifest">/);
});

test('service worker keeps app files only and never touches back end requests', async () => {
  const listeners = {};
  const stored = {};
  const deleted = [];
  class FakeRequest {
    constructor(url, opts) {
      this.url = url;
      this.opts = opts;
    }
  }
  const ctx = vm.createContext({
    self: {
      addEventListener: (type, fn) => (listeners[type] = fn),
      location: { origin: 'https://example.test' },
      skipWaiting() {},
      clients: { claim() {} },
    },
    caches: {
      open: async (name) => ({
        addAll: async (reqs) => (stored[name] = reqs.map((r) => r.url)),
        match: async () => undefined,
      }),
      keys: async () => ['two-of-us-v0', 'unrelated'].concat(Object.keys(stored)),
      delete: async (name) => deleted.push(name),
    },
    Request: FakeRequest,
    URL,
    fetch: async () => 'network',
  });
  vm.runInContext(read('web/sw.js'), ctx, { filename: 'sw.js' });
  const CACHE = vm.runInContext('CACHE', ctx);
  assert.match(CACHE, /^two-of-us-v\d+$/);

  let pending;
  listeners.install({ waitUntil: (p) => (pending = p) });
  await pending;
  const cached = stored[CACHE].map((f) => (f === './' ? 'web/index.html' : 'web/' + f.slice(2)));
  for (const f of cached) assert.ok(fs.existsSync(path.join(ROOT, f)), f + ' is listed in sw.js but missing');
  const appFiles = repoFiles().filter((f) => f.startsWith('web/') && f !== 'web/sw.js');
  assert.deepStrictEqual(appFiles.filter((f) => !cached.includes(f)), [], 'every app file is listed in sw.js');

  listeners.activate({ waitUntil: (p) => (pending = p) });
  await pending;
  assert.deepStrictEqual(deleted, ['two-of-us-v0'], 'only old copies of this app are removed');

  const handled = (url, method = 'GET', mode = 'cors') => {
    let called = false;
    listeners.fetch({ request: { url, method, mode }, respondWith: () => (called = true) });
    return called;
  };
  assert.strictEqual(handled(FAKE_WEB_APP + '?action=state'), false);
  assert.strictEqual(handled('https://script.googleusercontent.com/macros/echo?user_content_key=x'), false);
  assert.strictEqual(handled(FAKE_WEB_APP, 'POST'), false);
  assert.strictEqual(handled('https://example.test/two-of-us/', 'POST'), false);
  assert.strictEqual(handled('https://example.test/two-of-us/app.js'), true);
  assert.strictEqual(handled('https://example.test/two-of-us/?demo', 'GET', 'navigate'), true);
  assert.ok(!/\.put\(/.test(read('web/sw.js')), 'sw.js must not store responses at run time');
});

// ---------------------------------------------------------------------------

async function main() {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      passed++;
      console.log('  ✓ ' + t.name);
    } catch (err) {
      failed++;
      console.log('  ✗ ' + t.name);
      const msg = String((err && err.stack) || err).split('\n').slice(0, 12).join('\n      ');
      console.log('      ' + msg);
    }
  }
  console.log('\n' + passed + ' passed' + (failed ? ', ' + failed + ' failed' : ''));
  process.exitCode = failed ? 1 : 0;
}

if (require.main === module) main();

module.exports = { makeEnv, loadBackend, KEY_A, KEY_B };
