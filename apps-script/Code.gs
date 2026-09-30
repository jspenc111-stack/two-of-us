/**
 * Two of Us: back end (Google Apps Script, V8 runtime).
 *
 * Paste this whole file into the Apps Script project that belongs to the
 * "Two of Us — data (private)" Sheet (open the Sheet, then Extensions → Apps Script).
 * README.md has the setup steps. SPEC.md describes the behaviour.
 *
 * Public functions (they show in the Run menu): setup, getLinks, resetKeys, doGet, doPost.
 * Function names ending in "_" are private helpers.
 *
 * Nothing personal is written in this file. Names, keys, timezone and the
 * site address live in Project Settings → Script Properties.
 */

// Bump this (and EXPECTED_BACKEND_VERSION in web/app.js) whenever this file changes.
const VERSION = 1;

const MOODS = ['great', 'good', 'okay', 'rough'];
const MOOD_NOTE_MAX = 140;
const JAR_TEXT_MAX = 280;
const DEFAULT_TIMEZONE = 'America/New_York';

// Sheet tabs and their header rows. People are stored as "A" / "B", never by name.
const SHEETS = {
  Moods: ['date', 'person', 'mood', 'note', 'updatedAt'],
  Jar: ['id', 'date', 'person', 'text', 'forPartner', 'createdAt', 'updatedAt'],
};

// ---------------------------------------------------------------------------
// Public functions you can run from the Apps Script editor
// ---------------------------------------------------------------------------

/** Adds the Moods and Jar tabs (if missing), makes both secret keys, logs both links. Safe to run twice. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(function (name) {
    ensureSheet_(ss, name);
  });

  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TIMEZONE')) props.setProperty('TIMEZONE', DEFAULT_TIMEZONE);
  if (!isKey_(props.getProperty('KEY_A'))) props.setProperty('KEY_A', newKey_());
  if (!isKey_(props.getProperty('KEY_B'))) props.setProperty('KEY_B', newKey_());

  Logger.log('Setup done: the Moods and Jar tabs are ready and both secret keys exist.');
  ['NAME_A', 'NAME_B', 'SITE_URL'].forEach(function (name) {
    if (!props.getProperty(name)) Logger.log('Reminder: add the Script Property ' + name + '.');
  });
  logLinks_();
}

/** Logs the two personal setup links again. */
function getLinks() {
  logLinks_();
}

/** Makes two new keys. Old links stop working straight away. Logs the new links. */
function resetKeys() {
  withLock_(function () {
    const props = PropertiesService.getScriptProperties();
    props.setProperty('KEY_A', newKey_());
    props.setProperty('KEY_B', newKey_());
  });
  Logger.log('New keys made. The old links no longer work. Open the new links below on each phone.');
  logLinks_();
}

/** All reads. The app calls this with ?action=...&key=... */
function doGet(e) {
  return respond_('GET', (e && e.parameter) || {});
}

/** All writes. The app sends a JSON body as text/plain (avoids a CORS preflight). */
function doPost(e) {
  let body;
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return json_({ error: 'bad_request', message: 'Body must be JSON' });
  }
  if (!body || typeof body !== 'object') return json_({ error: 'bad_request', message: 'Body must be JSON' });
  return respond_('POST', body);
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

function respond_(method, req) {
  try {
    const cfg = config_();
    const person = personForKey_(req.key, cfg);
    if (!person) return json_({ error: 'unauthorized' });

    const routes = method === 'GET' ? {
      state: state_,
    } : {
      setMood: setMood_,
      clearMood: clearMood_,
    };
    const handler = Object.prototype.hasOwnProperty.call(routes, req.action) ? routes[req.action] : null;
    if (!handler) return json_({ error: 'bad_request', message: 'Unknown action' });
    return json_(handler(person, req, cfg));
  } catch (err) {
    if (err && err.code) return json_({ error: err.code, message: err.message });
    return json_({ error: 'server', message: 'Something went wrong' });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function fail_(code, message) {
  const err = new Error(message || code);
  err.code = code;
  throw err;
}

// ---------------------------------------------------------------------------
// Settings, keys and links
// ---------------------------------------------------------------------------

function config_() {
  const p = PropertiesService.getScriptProperties().getProperties();
  return {
    keys: { A: p.KEY_A || '', B: p.KEY_B || '' },
    names: { A: clean_(p.NAME_A) || 'Person A', B: clean_(p.NAME_B) || 'Person B' },
    tz: clean_(p.TIMEZONE) || DEFAULT_TIMEZONE,
    siteUrl: clean_(p.SITE_URL),
    webAppUrl: clean_(p.WEB_APP_URL),
  };
}

function clean_(value) {
  return String(value == null ? '' : value).trim();
}

function isKey_(key) {
  return typeof key === 'string' && /^[A-Za-z0-9]{32,}$/.test(key);
}

function newKey_() {
  return (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
}

/** Returns "A", "B", or null for an unknown key. */
function personForKey_(key, cfg) {
  if (!isKey_(key)) return null;
  if (isKey_(cfg.keys.A) && sameText_(key, cfg.keys.A)) return 'A';
  if (isKey_(cfg.keys.B) && sameText_(key, cfg.keys.B)) return 'B';
  return null;
}

// Compares every character, so the time taken doesn't hint at how close a guess was.
function sameText_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function partner_(person) {
  return person === 'A' ? 'B' : 'A';
}

/** The web app address. Uses the WEB_APP_URL Script Property if set, else asks Apps Script. */
function webAppUrl_(cfg) {
  if (cfg.webAppUrl) return cfg.webAppUrl;
  try {
    const url = ScriptApp.getService().getUrl();
    if (url && /\/exec$/.test(url)) return url;
  } catch (err) {
    // Not deployed yet, or not allowed to ask: fall through to the instructions.
  }
  return '';
}

function setupLink_(siteUrl, webAppUrl, key) {
  let site = siteUrl.split('#')[0];
  if (!/\/$/.test(site) && !/\.html$/.test(site)) site += '/';
  return site + '#setup=' + encodeURIComponent(webAppUrl + '|' + key);
}

function logLinks_() {
  const cfg = config_();
  if (!isKey_(cfg.keys.A) || !isKey_(cfg.keys.B)) {
    Logger.log('No keys yet. Run setup first.');
    return;
  }
  if (!cfg.siteUrl) {
    Logger.log('Add the Script Property SITE_URL (your GitHub Pages address), then run getLinks again.');
    return;
  }
  const url = webAppUrl_(cfg);
  if (!url) {
    Logger.log('No web app address yet. Deploy → New deployment → Web app, then run getLinks again. ' +
      'If this message stays, copy the Web app URL from Deploy → Manage deployments into a Script Property named WEB_APP_URL.');
    return;
  }
  Logger.log('Personal link for ' + cfg.names.A + ' (open it only on their phone):\n' + setupLink_(cfg.siteUrl, url, cfg.keys.A));
  Logger.log('Personal link for ' + cfg.names.B + ' (open it only on their phone):\n' + setupLink_(cfg.siteUrl, url, cfg.keys.B));
  Logger.log('Each link works like a password. Send it only to yourself: no group chats, emails or screenshots.');
}

// ---------------------------------------------------------------------------
// Sheet helpers
// ---------------------------------------------------------------------------

function ensureSheet_(ss, name) {
  const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    const headers = SHEETS[name];
    sheet.appendRow(headers);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function sheet_(name) {
  return ensureSheet_(SpreadsheetApp.getActiveSpreadsheet(), name);
}

/** Reads every data row of a tab as objects keyed by header, plus `row` (the sheet row number). */
function readRows_(sheet, tz) {
  const headers = SHEETS[sheet.getName()];
  const values = sheet.getDataRange().getValues();
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const r = { row: i + 1 };
    headers.forEach(function (h, c) {
      r[h] = values[i][c];
    });
    r.date = dateText_(r.date, tz);
    rows.push(r);
  }
  return rows;
}

// Text written to the Sheet gets a leading apostrophe. Sheets then keeps it as
// plain text: "2026-01-02" doesn't turn into a date and "=..." never becomes a formula.
function text_(value) {
  const s = String(value == null ? '' : value);
  return s === '' ? '' : "'" + s;
}

function str_(value) {
  return value == null ? '' : String(value);
}

function isDate_(value) {
  return Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime());
}

// Dates are stored as "yyyy-MM-dd" text; also accepts a real date if someone edited the Sheet by hand.
function dateText_(value, tz) {
  return isDate_(value) ? Utilities.formatDate(value, tz, 'yyyy-MM-dd') : str_(value).trim();
}

/** Trims text and enforces the length limit. Line breaks are kept only when `multiline`. */
function cleanText_(value, max, multiline) {
  let s = str_(value).replace(/\r\n?/g, '\n');
  s = multiline
    ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '')
    : s.replace(/[\u0000-\u001F\u007F]+/g, ' ');
  s = s.trim();
  if (s.length > max) fail_('too_long', 'Too long (max ' + max + ' characters)');
  return s;
}

/** Runs `fn` while holding the script lock, so two taps at once can't clash. */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    fail_('busy', 'Busy, try again');
  }
  try {
    const result = fn();
    SpreadsheetApp.flush();
    return result;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// Dates. "Today" is decided here, in the TIMEZONE Script Property, never by the phone.
// ---------------------------------------------------------------------------

function today_(tz) {
  return Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
}

/** Adds whole days to a "yyyy-MM-dd" date (calendar maths, no timezone involved). */
function addDays_(ymd, days) {
  const p = ymd.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Moods
// ---------------------------------------------------------------------------

/** Names, today's date, both moods today, the last 7 days, jar count, backend version. */
function state_(person, req, cfg) {
  const today = today_(cfg.tz);
  const first = addDays_(today, -6);
  const other = partner_(person);

  const days = [];
  const byDate = {};
  for (let i = 0; i < 7; i++) {
    const day = { date: addDays_(first, i), me: null, partner: null };
    days.push(day);
    byDate[day.date] = day;
  }

  readRows_(sheet_('Moods'), cfg.tz).forEach(function (r) {
    const day = byDate[r.date];
    const mood = str_(r.mood);
    if (!day || MOODS.indexOf(mood) === -1) return;
    const who = r.person === person ? 'me' : r.person === other ? 'partner' : null;
    if (who) day[who] = { mood: mood, note: str_(r.note) }; // later rows win
  });

  return {
    ok: true,
    version: VERSION,
    today: today,
    names: { me: cfg.names[person], partner: cfg.names[other] },
    moods: { me: days[6].me, partner: days[6].partner },
    days: days,
    jarCount: Math.max(0, sheet_('Jar').getLastRow() - 1),
  };
}

/** {mood, note?}. One mood per person per day: a new tap replaces it. Leaving out `note` keeps the old note. */
function setMood_(person, req, cfg) {
  const mood = str_(req.mood);
  if (MOODS.indexOf(mood) === -1) fail_('bad_request', 'Unknown mood');
  const hasNote = req.note !== undefined && req.note !== null;
  const note = hasNote ? cleanText_(req.note, MOOD_NOTE_MAX, false) : '';

  withLock_(function () {
    const today = today_(cfg.tz);
    const sheet = sheet_('Moods');
    const mine = readRows_(sheet, cfg.tz).filter(function (r) {
      return r.date === today && r.person === person;
    });
    const now = new Date();
    if (mine.length) {
      const last = mine[mine.length - 1];
      const keptNote = hasNote ? note : str_(last.note);
      sheet.getRange(last.row, 1, 1, 5).setValues([[text_(today), person, mood, text_(keptNote), now]]);
      deleteRows_(sheet, mine.slice(0, -1)); // tidy up any duplicates
    } else {
      sheet.appendRow([text_(today), person, mood, text_(note), now]);
    }
  });
  return state_(person, req, cfg);
}

/** Removes your own mood for today. */
function clearMood_(person, req, cfg) {
  withLock_(function () {
    const today = today_(cfg.tz);
    const sheet = sheet_('Moods');
    deleteRows_(sheet, readRows_(sheet, cfg.tz).filter(function (r) {
      return r.date === today && r.person === person;
    }));
  });
  return state_(person, req, cfg);
}

// Deletes from the bottom up so row numbers stay correct.
function deleteRows_(sheet, rows) {
  rows.map(function (r) { return r.row; })
    .sort(function (a, b) { return b - a; })
    .forEach(function (row) { sheet.deleteRow(row); });
}
