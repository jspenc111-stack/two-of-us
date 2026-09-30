# CLAUDE.md — Two of Us

Private two-person PWA: daily mood check-in + shared gratitude jar. A static PWA on GitHub Pages talks to a Google Apps Script backend that stores data in a Google Sheet in the owner's Drive. **SPEC.md is the source of truth for behavior.** Build in the order in SPEC section 12.

## About the owner

- Not a developer. Explain changes in plain language and define any technical term the first time you use it.
- Uses an Android phone (Pixel 10), often from the GitHub mobile app. Keep PR descriptions short and skimmable.
- Anything the owner must do by hand: say **which tool** (GitHub website, script.google.com, Chrome on the phone) and give numbered steps.

## Layout

- `apps-script/Code.gs`: the whole backend (one file, Apps Script V8). `appsscript.json` is its manifest.
- `web/`: the PWA. Plain HTML/CSS/JS, no build step, no dependencies, no CDNs. Deployed as-is by `.github/workflows/pages.yml`.
- `web/icons/`: app icons incl. maskable. `tools/make_icons.py` regenerates them (needs Pillow).
- `tests/run.js`: runs Code.gs in Node's `vm` with fake Google services. No npm packages.

## Commands

- Test: `node tests/run.js` (must print `N passed` with no ✗)
- Preview: `cd web && python3 -m http.server 8000`, open `http://localhost:8000/?demo`

## Rules

1. **This repo is public, and the data is personal and emotional.** Never commit:
   - names, moods, notes, or any real user content,
   - secrets: personal keys, the `script.google.com/macros/s/...` URL, Sheet IDs,
   - email addresses or real screenshots.

   Names, keys, timezone and site URL live in Script Properties. Demo and tests use made-up data ("Sam", "Alex"). The secrets-scan test must pass.
2. **Privacy requirements in SPEC section 8 are hard rules.** In particular:
   - no analytics, trackers, cookies, third-party scripts, web fonts or CDN files;
   - the phone stores only the backend URL + key (never moods or notes);
   - the service worker caches app files only, never API responses;
   - user text is always inserted with `textContent`, never `innerHTML`;
   - ownership (edit/delete own notes only) is enforced on the server.

   If a change would weaken any of these, stop and ask the owner first.
3. **Work on a branch and open a PR.** Never push to `main`: that deploys the live app. Fill in the PR template checklist.
4. **Tests first.** Add or adjust a test in `tests/run.js` for any behavior change, run the tests before committing.
5. **Keep SPEC.md in sync.** Behavior changes update the matching SPEC section in the same PR. Update README if setup or everyday use changes.
6. **Backend changes need a manual step.** GitHub can't deploy Apps Script. When `apps-script/` changes:
   - bump `VERSION` in `Code.gs` **and** `EXPECTED_BACKEND_VERSION` in `web/app.js` to the same value (a test checks this);
   - start the PR description with: "⚠️ Paste the new Code.gs into script.google.com, then Deploy → Manage deployments → Edit → New version → Deploy."
7. **Web changes:** bump `CACHE` in `web/sw.js` (e.g. `two-of-us-v3` → `v4`) so installed apps get new files.
8. **Least privilege.** The script is bound to the data Sheet. `appsscript.json` scopes: `spreadsheets.currentonly` only. Use `SpreadsheetApp.getActiveSpreadsheet()`, never `openById`. No Gmail, Calendar or Drive scopes. Explain any new scope in the PR.
9. **Keep it gentle.** No streaks, guilt copy, or alerts about low moods (SPEC 8, "Emotional safety").
10. **Small PRs.** One feature or fix per PR, clear title.

## Apps Script gotchas

- Functions ending in `_` are private (hidden from the Run menu, not callable by the web app). Public: `setup`, `getLinks`, `resetKeys`, `doGet`, `doPost`.
- Web app responses redirect through googleusercontent.com. The PWA must use GET, or POST with `Content-Type: text/plain`, to avoid CORS preflight.
- Wrap writes in `LockService.getScriptLock()`.
- Dates: compute "today" on the server with `Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd')`, not from the phone.
- Anything the tests touch must be mocked in `makeEnv()` in `tests/run.js` (SpreadsheetApp, PropertiesService, LockService, Utilities, ContentService).
