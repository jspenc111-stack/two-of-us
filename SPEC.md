# SPEC — Two of Us

A private app for two people: a **daily mood check-in** and a **shared gratitude jar**. Installed on each person's Android phone (Pixel 10) as a PWA.

This file is the source of truth for how the app behaves. Plain-language notes in *italics* explain terms for the owner.

---

## 1. Goals and non-goals

**Goals**
- Two people only. Each taps a mood once a day and can see the other's.
- Either person can drop a short gratitude note in the jar at any time and browse the jar together later.
- Fast: open app → tap → done in under 5 seconds.
- Private by design (see section 8).
- Works well on Android Chrome, installable to the home screen.

**Non-goals (v1)**
- No accounts, sign-up, email, or passwords.
- No notifications or reminders.
- No streaks, scores, charts, or "you forgot to check in" messages. This is not a performance tracker.
- No third-party services beyond Google (backend) and GitHub (hosting).

---

## 2. How it's built (architecture)

| Part | What it is | Where it lives |
|---|---|---|
| **Front end** | The app you see. Plain HTML/CSS/JavaScript, no build step. | GitHub repo `web/`, served by **GitHub Pages** |
| **Back end** | A small script that receives and returns data. | **Google Apps Script**, pasted in manually at script.google.com |
| **Database** | Where moods and notes are saved. | A **Google Sheet** in the owner's Google Drive |

*Front end = the screens. Back end = the helper on a server that saves and fetches data so both phones see the same thing. GitHub Pages = free website hosting from a GitHub repo. Google Apps Script = free Google tool that runs small programs attached to your Google account. A Google Sheet works here as a simple database.*

Why this setup: free, no new accounts, same pattern as the owner's Leave By app, and data stays inside the owner's own Google account.

### Data flow
1. Phone app sends a request (e.g. "Person A's mood today is Okay") with that person's **secret key** to the Apps Script **web app URL**.
2. Apps Script checks the key, figures out who it belongs to, writes a row to the Sheet.
3. The app asks for "today + recent data" and shows both people's moods and the jar.

*Web app URL = the private web address of the Apps Script. Secret key = a long random code that works like a password, built into each person's personal link.*

---

## 3. Identity: two personal links (no login)

- Setup creates **two secret keys**, one per person, stored in Apps Script **Script Properties** (*a private settings box inside Apps Script, never in the GitHub repo*).
- Setup prints **two personal setup links**, e.g.
  `https://<user>.github.io/two-of-us/#setup=<backend-url>|<personal-key>`
- Each person opens **their own** link once on their phone. The app saves the backend URL + key on that phone (in `localStorage`, *the phone browser's small private storage for this site*), then removes it from the address bar.
- The key tells the backend who is writing. Nobody picks "who am I" and nobody can post as the other person.
- The two display names (e.g. "Sam", "Alex") and the timezone are set in Script Properties, not in code.
- **Settings screen** in the app: "Forget this phone" (clears saved link/key).
- **Reset keys**: an Apps Script function `resetKeys` makes new keys and new links, instantly cutting off any old link.

---

## 4. Feature: Daily mood check-in

### Mood options (fixed list, v1)
| Value | Label | Emoji |
|---|---|---|
| `great` | Great | 😄 |
| `good` | Good | 🙂 |
| `okay` | Okay | 😐 |
| `rough` | Rough | 😔 |

Stored as the value, shown as emoji + label. Colours must not be the only signal (accessibility).

### Rules
- One mood per person per day. Tapping again the same day **replaces** it (last tap wins).
- "Day" = calendar day in the configured timezone (Script Property `TIMEZONE`, default `America/New_York`). The server decides the date, not the phone.
- Optional short note with the mood: max 140 characters. Hidden behind a small "Add a note" link to keep the main flow one tap.
- Each person can clear their own mood for today.

### Home screen ("Today")
- Top: **You** — four large mood buttons (at least 48px tall, *Android's comfortable tap size*); your chosen one is highlighted.
- Below: **[Partner name]** — their mood today with emoji and label, plus their note if any. If not checked in yet: "Hasn't checked in yet" (neutral wording, no warnings).
- Below that: a **last 7 days** row for each person: a small emoji per day, blank if none. Tapping a day shows that day's moods and notes.
- No times shown, only dates. *Less "surveillance" feeling.*

---

## 5. Feature: Gratitude jar

### Adding
- Big "+ Add to the jar" button on the Jar tab.
- Text box, max 280 characters, character counter.
- Optional "for [partner name]" toggle (default off), which marks the note as being about the partner.
- Saved with: author, date, text, `forPartner` flag.

### Browsing
- **Jar tab** shows a simple jar illustration with a count ("42 notes").
- **"Pull one out"** button: shows one random note in a card (author, date, text). Tap again for another.
- **"See all"** list: newest first, grouped by month. Filter chips: Everyone / Mine / [Partner].
- Both people see all jar notes. That's the point of the jar.

### Editing
- You can edit or delete **only your own** notes. Delete asks "Remove this note?" to confirm.
- The server enforces this, not just the screen.

---

## 6. Screens and navigation

Bottom tab bar with two tabs: **Today** and **Jar**. A small gear icon (top right) opens **Settings**.

Settings shows:
- Your name and partner's name (read-only, set in Apps Script).
- "Export everything" → downloads a `.json` file of all moods and jar notes (*a plain text data file, a personal backup*).
- "Forget this phone".
- App version.

### Look and feel
- Warm, calm, soft colours. Rounded cards. System font (no web fonts, see privacy).
- Follows phone light/dark mode.
- Portrait layout, designed for the Pixel 10 screen width (~412px), still fine on bigger screens.
- Friendly short copy. No exclamation-mark nagging.

### States to handle
- **Not set up** (no key saved): shows "Open your personal setup link to get started."
- **Loading**: light skeleton placeholders.
- **Offline / backend error**: "Can't reach the jar right now. Try again in a moment." Keep what was typed so nothing is lost. Show last loaded data greyed out with "Last updated [date]".
- **Wrong/old key**: "This link no longer works. Ask for a new setup link."
- **Backend out of date**: banner "The helper script needs updating" (version check, see CLAUDE.md).

---

## 7. Back end (Apps Script) details

### Google Sheet
The owner creates a blank Sheet named `Two of Us — data (private)`, then opens Extensions → Apps Script from inside it. This makes the script **bound** to that one Sheet (*it can only touch this spreadsheet, not the rest of your Drive*). `setup()` adds two tabs:

**Moods**: `date` (YYYY-MM-DD) | `person` (`A` or `B`) | `mood` | `note` | `updatedAt`
**Jar**: `id` | `date` | `person` | `text` | `forPartner` | `createdAt` | `updatedAt`

Person is stored as `A`/`B`, not names. Names live only in Script Properties.

### Script Properties
`KEY_A`, `KEY_B`, `NAME_A`, `NAME_B`, `TIMEZONE`, `SITE_URL` (the GitHub Pages address, used to build setup links).

### Public functions (runnable from the Apps Script editor)
- `setup()`: adds the tabs (if missing), generates both keys, logs both setup links. Safe to run twice (doesn't wipe data).
- `getLinks()`: logs the two setup links again.
- `resetKeys()`: new keys, logs new links.
- `doGet(e)`: all reads. `doPost(e)`: all writes.

### API (all requests include `key`)
| Action | Method | Does |
|---|---|---|
| `state` | GET | Returns: names, today's date, both moods today, last 7 days of moods, jar count, backend version |
| `setMood` | POST | `{mood, note?}` for today |
| `clearMood` | POST | Removes your mood today |
| `jarList` | GET | All jar notes (newest first) |
| `jarAdd` | POST | `{text, forPartner}` |
| `jarEdit` | POST | `{id, text, forPartner}`, own notes only |
| `jarDelete` | POST | `{id}`, own notes only |
| `export` | GET | Everything, as JSON |

*API = the list of requests the app is allowed to make to the back end.*

### Validation (server-side)
- Unknown key → `{error: "unauthorized"}`, no data.
- Mood must be one of the 4 values. Text trimmed; length limits enforced (140 / 280).
- Treat all text as plain text. The front end must insert it with `textContent`, never as HTML. *Stops someone's note from being run as code.*
- Use `LockService` around writes so two taps at once don't clash. *A "one at a time" rule.*

---

## 8. Privacy and safety

This is emotional data between two people. These rules are requirements, not suggestions.

### Where data lives and who can see it
- All moods and notes live in **one Google Sheet in the owner's Google account**. Nothing is stored in GitHub.
- **Honest limitation:** the owner can open the Sheet and see (or edit) everything, including the partner's notes and any mood notes. Both people should know and agree to this before using the app. The README must say this plainly.
- Google can technically access Drive data under its normal terms. No other company receives any data.
- **Never share the Sheet** with anyone. It isn't needed for the app to work.

### The public repo
- The GitHub repo is **public** (free GitHub Pages needs that). So it must never contain: names, moods, notes, keys, the Apps Script URL, the Sheet ID, emails, or real screenshots. Demo mode uses made-up data only.

### The secret links
- Each personal link **is the password**. Anyone who has it can read the whole jar and all moods, and post as that person.
- Don't send links in group chats, email threads, or screenshots. Best: open it directly on your own phone (e.g. copy from the Apps Script log on a computer and send to yourself only).
- If a link might have leaked, or a phone is lost: run `resetKeys()` in Apps Script and re-open the new links.
- The app removes the link from the address bar after setup so it isn't in browser history.

### On the phone
- The app has no login screen. **Anyone who can unlock your phone can open it.** Keep a phone screen lock on.
- Only the backend URL + key are saved on the phone. Moods and notes are held in memory while the app is open and are not written to phone storage.
- The service worker (*the part that makes it load like an app*) caches **app files only**, never data.
- No notifications, so nothing appears on the lock screen.

### No tracking
- No analytics, ads, trackers, cookies, or third-party scripts.
- No web fonts or files from other sites (CDNs). *Every outside file request tells another company your phone's address.*
- The app sends data only to the Apps Script URL.

### Control and deletion
- Each person can edit/delete their own jar notes and clear their own mood.
- Either person can export everything.
- To stop using the app completely: delete the Sheet and the Apps Script project (owner), and "Forget this phone" on both phones.

### Emotional safety (design choices)
- No streaks, guilt messages, or alerts when someone picks "Rough". Seeing a mood is an invitation to check in in person, not a monitoring tool.
- No exact check-in times shown.
- This app is not a crisis or mental-health tool. The README should say so in one gentle line.

---

## 9. PWA requirements (Android / Pixel 10)

- `manifest.webmanifest`: name "Two of Us", short name "Two of Us", `display: standalone` (*opens full-screen without browser bars*), portrait, theme + background colours, icons 192px and 512px, plus a **maskable** icon (*an icon Android can crop into its round/squircle shape*).
- Service worker: caches the app shell for fast opening; network-only for all API calls.
- Works from Chrome's "Add to Home screen / Install app".
- Respect safe areas (*the space under the status bar and gesture bar*) and dark mode.
- Pixel 10 checks: tap targets ≥ 48px, text ≥ 16px in inputs (*stops the page zooming in when typing*), keyboard doesn't cover the Save button.

---

## 10. Demo mode

`?demo` in the URL runs the whole app with fake names ("Sam" and "Alex") and fake data in memory, with no backend. Used for previewing and for Claude Code to check layouts.

---

## 11. Tests

`tests/run.js` runs `Code.gs` in Node with fake Google services (no npm packages). Must cover:
- Unknown key rejected; each key maps to the right person.
- Mood: one per person per day, replace, clear, invalid value rejected, timezone date boundary.
- Jar: add, list order, edit/delete own only (other person's rejected), length limits.
- `state` returns correct 7-day window.
- `VERSION` in Code.gs matches `EXPECTED_BACKEND_VERSION` in web/app.js.
- No secrets committed: scan repo files for `script.google.com/macros/s/`, anything that looks like a key, and email addresses.

---

## 12. Build order (separate PRs)

1. Repo skeleton: CLAUDE.md, README, folders, GitHub Pages workflow, PR template, test runner.
2. Back end: Sheet setup, keys, links, `state`, mood actions + tests.
3. Front end: setup-link handling, Today screen, demo mode.
4. Jar: back end actions + tests, Jar screens.
5. Settings, export, error states, PWA manifest/icons/service worker.
6. README with step-by-step setup (see section 13) and privacy section.

## 13. Owner setup steps (to go in README, in this order)

1. **GitHub (via Claude Code):** merge the PRs; Pages deploys automatically.
2. **GitHub website:** Repo → Settings → Pages → confirm it's live; note the site address.
3. **Google Sheets (on a computer):** create a blank Sheet named `Two of Us — data (private)` → Extensions → Apps Script → paste `Code.gs` and `appsscript.json` (Project Settings → show manifest file) → set Script Properties `NAME_A`, `NAME_B`, `TIMEZONE`, `SITE_URL` → run `setup` → approve permissions.
4. **Apps Script:** Deploy → New deployment → Web app → Execute as **Me**, Who has access **Anyone** → Deploy. Run `getLinks` and copy the two links from the log.
   *"Anyone" is needed so your partner doesn't need your Google login. The secret key is what actually protects the data.*
5. **Each Pixel, in Chrome:** open your own link → tap ⋮ menu → Install app / Add to Home screen.

## 14. Ideas for later (not v1)
Optional app PIN lock; gentle daily reminder; "Could use a hug" button; yearly jar look-back; photos in notes.
