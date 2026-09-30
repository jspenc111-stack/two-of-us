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

  function create(scenario) {
    const today = localToday();
    const db = { moods: [], jar: [] };
    if (scenario !== 'empty') seedMoods(db, today);
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

    const actions = { state: state, setMood: setMood, clearMood: clearMood };

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
