/* Two of Us: demo mode (open the app with ?demo in the address).
 *
 * A pretend back end with made-up people ("Sam" and "Alex") and made-up data,
 * kept in memory only. Nothing is sent anywhere and nothing is saved.
 * "You" are Sam. It follows the same rules as apps-script/Code.gs.
 *
 * Extra previews: ?demo=empty  ?demo=slow  ?demo=offline  ?demo=badkey  ?demo=outdated  ?demo=setup
 */
(function () {
  'use strict';

  const VERSION = 1;
  const MOODS = ['great', 'good', 'okay', 'rough'];
  const MOOD_NOTE_MAX = 140;
  const JAR_TEXT_MAX = 280;
  const NAMES = { A: 'Sam', B: 'Alex' };
  const ME = 'A';
  const PARTNER = 'B';

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function localToday() {
    const d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function addDays(ymd, days) {
    const p = ymd.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days)).toISOString().slice(0, 10);
  }

  function fail(code, message) {
    return { error: code, message: message || code };
  }

  function cleanText(value, multiline) {
    let s = String(value == null ? '' : value).replace(/\r\n?/g, '\n');
    s = multiline ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '') : s.replace(/[\u0000-\u001F\u007F]+/g, ' ');
    return s.trim();
  }

  function seedMoods(db, today) {
    // [days ago, Sam's mood, Sam's note, Alex's mood, Alex's note]
    [
      [-6, 'good', '', 'great', 'Sunny walk at lunch'],
      [-5, 'okay', '', 'good', ''],
      [-4, 'great', 'Finally fixed the wobbly shelf', 'okay', ''],
      [-3, 'rough', 'Long day', 'good', ''],
      [-2, null, '', 'okay', 'Tired but fine'],
      [-1, 'good', 'Soup night', 'great', ''],
      [0, null, '', 'good', 'Coffee in the garden'],
    ].forEach(function (d) {
      const date = addDays(today, d[0]);
      if (d[1]) db.moods.push({ date: date, person: ME, mood: d[1], note: d[2] });
      if (d[3]) db.moods.push({ date: date, person: PARTNER, mood: d[3], note: d[4] });
    });
  }

  function seedJar(db, today) {
    // [days ago, author, text, for the other person]
    [
      [-62, ME, 'You waited up for me.', true],
      [-55, PARTNER, 'A surprise postcard in the mail.', false],
      [-48, ME, 'A slow morning with nowhere to be.', false],
      [-41, PARTNER, 'Laughing so hard at breakfast that the tea went cold.', false],
      [-34, ME, 'Finding out the good bakery opens early.', false],
      [-30, PARTNER, 'You fixed my bike without being asked.', true],
      [-21, ME, "The neighbour's cat visiting again.", false],
      [-15, PARTNER, 'Rainy Sunday, board games, tea.', false],
      [-9, ME, 'You remembered the thing I mentioned weeks ago.', true],
      [-6, PARTNER, 'Clean sheets day.', false],
      [-3, ME, 'The sunset on our walk tonight.', false],
      [-1, PARTNER, 'Thank you for making dinner when I was running late.', true],
    ].forEach(function (n, i) {
      db.jar.push({ id: 'demo-' + (i + 1), date: addDays(today, n[0]), person: n[1], text: n[2], forPartner: n[3], order: i });
    });
  }

  function create(scenario) {
    const today = localToday();
    const db = { moods: [], jar: [] };
    if (scenario !== 'empty') {
      seedMoods(db, today);
      seedJar(db, today);
    }
    let nextId = db.jar.length + 1;
    const delay = scenario === 'slow' ? 2500 : 350;
    let calls = 0;

    function state() {
      const first = addDays(today, -6);
      const days = [];
      for (let i = 0; i < 7; i++) days.push({ date: addDays(first, i), me: null, partner: null });
      db.moods.forEach(function (r) {
        const day = days.find(function (d) { return d.date === r.date; });
        if (!day) return;
        day[r.person === ME ? 'me' : 'partner'] = { mood: r.mood, note: r.note };
      });
      return {
        ok: true,
        version: scenario === 'outdated' ? VERSION - 1 : VERSION,
        today: today,
        names: { me: NAMES[ME], partner: NAMES[PARTNER] },
        moods: { me: days[6].me, partner: days[6].partner },
        days: days,
        jarCount: db.jar.length,
      };
    }

    function setMood(p) {
      if (MOODS.indexOf(p.mood) === -1) return fail('bad_request', 'Unknown mood');
      const hasNote = p.note !== undefined && p.note !== null;
      const note = hasNote ? cleanText(p.note, false) : '';
      if (note.length > MOOD_NOTE_MAX) return fail('too_long');
      const mine = db.moods.find(function (r) { return r.date === today && r.person === ME; });
      if (mine) {
        mine.mood = p.mood;
        if (hasNote) mine.note = note;
      } else {
        db.moods.push({ date: today, person: ME, mood: p.mood, note: note });
      }
      return state();
    }

    function clearMood() {
      db.moods = db.moods.filter(function (r) { return !(r.date === today && r.person === ME); });
      return state();
    }

    function note(n) {
      return { id: n.id, date: n.date, mine: n.person === ME, text: n.text, forPartner: n.forPartner };
    }

    function jarList() {
      const notes = db.jar.slice().sort(function (a, b) {
        if (a.date !== b.date) return a.date < b.date ? 1 : -1;
        return b.order - a.order;
      });
      return { ok: true, version: VERSION, notes: notes.map(note) };
    }

    function jarText(p) {
      const text = cleanText(p.text, true);
      if (!text) return { error: fail('empty') };
      if (text.length > JAR_TEXT_MAX) return { error: fail('too_long') };
      return { text: text };
    }

    function ownNote(id) {
      const n = db.jar.find(function (x) { return x.id === id; });
      if (!n) return { error: fail('not_found') };
      if (n.person !== ME) return { error: fail('forbidden') };
      return { note: n };
    }

    function jarAdd(p) {
      const t = jarText(p);
      if (t.error) return t.error;
      const n = { id: 'demo-' + nextId++, date: today, person: ME, text: t.text, forPartner: p.forPartner === true, order: nextId };
      db.jar.push(n);
      return { ok: true, note: note(n), jarCount: db.jar.length };
    }

    function jarEdit(p) {
      const t = jarText(p);
      if (t.error) return t.error;
      const found = ownNote(p.id);
      if (found.error) return found.error;
      found.note.text = t.text;
      found.note.forPartner = p.forPartner === true;
      return { ok: true, note: note(found.note), jarCount: db.jar.length };
    }

    function jarDelete(p) {
      const found = ownNote(p.id);
      if (found.error) return found.error;
      db.jar = db.jar.filter(function (x) { return x !== found.note; });
      return { ok: true, jarCount: db.jar.length };
    }

    function exportAll() {
      const withName = function (r) {
        return Object.assign({ name: NAMES[r.person] }, r);
      };
      const byDate = function (a, b) {
        return a.date < b.date ? -1 : a.date > b.date ? 1 : 0;
      };
      return {
        ok: true,
        app: 'Two of Us',
        version: VERSION,
        exportedOn: today,
        timezone: 'America/New_York',
        people: { A: NAMES.A, B: NAMES.B },
        moods: db.moods.slice().sort(byDate).map(function (r) {
          return withName({ date: r.date, person: r.person, mood: r.mood, note: r.note });
        }),
        jar: db.jar.slice().sort(byDate).map(function (n) {
          return withName({ id: n.id, date: n.date, person: n.person, text: n.text, forPartner: n.forPartner });
        }),
      };
    }

    const actions = {
      export: exportAll,
      state: state,
      setMood: setMood,
      clearMood: clearMood,
      jarList: jarList,
      jarAdd: jarAdd,
      jarEdit: jarEdit,
      jarDelete: jarDelete,
    };

    function handle(action, params) {
      calls++;
      if (scenario === 'badkey') return { error: 'unauthorized' };
      if (scenario === 'offline' && calls > 1) throw new TypeError('Failed to fetch');
      const fn = Object.prototype.hasOwnProperty.call(actions, action) ? actions[action] : null;
      return fn ? fn(params || {}) : fail('bad_request', 'Unknown action');
    }

    return {
      request: function (action, params) {
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            try {
              resolve(JSON.parse(JSON.stringify(handle(action, params))));
            } catch (err) {
              reject(err);
            }
          }, delay);
        });
      },
    };
  }

  window.TwoOfUsDemo = { create: create };
})();
