# Two of Us

A private little app for two people: a **daily mood check-in** and a shared **gratitude jar**. It installs on an Android phone like a normal app.

*Two of Us is a gentle way to stay in touch. It is not a crisis or mental-health tool: if either of you is struggling, please talk to someone you trust or a professional.*

- **Today:** tap how you feel (Great, Good, Okay or Rough), add a short note if you like, and see how your partner is doing. A row of the last 7 days shows both of you. Tap a day to see its notes.
- **Jar:** drop in a note about something you're grateful for, at any time. "Pull one out" shows a random note. "See all" lists every note, newest first.
- **Settings** (gear, top right): both names, "Export everything" (a backup file) and "Forget this phone".

There are no accounts, streaks, scores, reminders or notifications.

How it works, in one line: the screens are a small website hosted free on **GitHub Pages**, and the data lives in a **Google Sheet** in the owner's own Google account, reached through a small **Google Apps Script** helper (a free Google tool that runs a little program for you).

How it behaves in detail: [SPEC.md](SPEC.md). Rules for changing it: [CLAUDE.md](CLAUDE.md).

---

## Privacy: please read this together before you start

**Where the data lives**
- All moods and notes live in **one Google Sheet in the owner's Google account**. Nothing is stored in GitHub.
- **Honest limitation:** the owner can open that Sheet and see or change everything, including the partner's jar notes and mood notes. Both of you should know this and agree to it before using the app.
- Google can technically access Drive data under its normal terms. No other company receives any data. The app has no analytics, ads, trackers, cookies, web fonts or files from other sites.
- **Never share the Sheet** with anyone. The app doesn't need it shared.

**Your personal link is the password**
- Each of you gets your own setup link. Anyone who has it can read all moods and the whole jar, and post as you.
- Don't send links in group chats, email threads or screenshots. Open your own link directly on your own phone.
- If a link might have leaked, or a phone is lost: make new links (see "If a link leaks or a phone is lost" below). The old links stop working straight away.
- The app removes the link from the address bar after setup, so it isn't left in the browser's history.

**On the phone**
- There's no login screen. **Anyone who can unlock your phone can open the app**, so keep a screen lock on.
- The phone saves only the helper's address and your key. Moods and notes are never saved on the phone.
- The app keeps copies of its own files so it opens fast, never your data.
- No notifications, so nothing ever shows on the lock screen.
- Every GitHub Pages site made from the same GitHub account shares one web address (`<your-github-username>.github.io`). Another site you publish there could technically read the saved link, so only publish sites you trust from that account.

**Stopping completely:** see "Stop using the app" at the end.

---

## Setup (one time, about 20 minutes)

You need: a computer for steps 1 to 3, and each phone for step 4.

### Step 1. GitHub website: turn on the website

1. On github.com, open this repository → **Settings** → **Pages**.
2. Under **Build and deployment** → **Source**, choose **GitHub Actions**.
3. Merge the pull request (if it isn't merged yet). Open the **Actions** tab and wait for **Tests and Pages** to show a green tick (a minute or two).
   If it has a red cross because it ran before step 2, open it and click **Re-run all jobs**.
4. Back in **Settings** → **Pages**, you'll see "Your site is live at `https://<your-github-username>.github.io/two-of-us/`". Copy this address: it's your **site address**.
5. Open the site address. You should see "Open your personal setup link to get started."

### Step 2. Google Sheets (on a computer): make the private Sheet and its helper

1. Go to sheets.google.com → **Blank spreadsheet**. Name it `Two of Us — data (private)`.
2. In the Sheet: **Extensions** → **Apps Script**. A new tab opens. Click "Untitled project" and name it `Two of Us`.
3. Click **Project Settings** (the gear on the left) → tick **Show "appsscript.json" manifest file in editor**.
4. Click **Editor** (the `< >` icon on the left) → click **appsscript.json** → delete everything in it → paste in the whole of [`apps-script/appsscript.json`](apps-script/appsscript.json) from this repo → **Save** (the disk icon).
5. Click **Code.gs** → delete everything → paste in the whole of [`apps-script/Code.gs`](apps-script/Code.gs) → **Save**.
6. **Project Settings** → scroll to **Script Properties** → **Edit script properties** → **Add script property**, four times:

   | Property | Value |
   |---|---|
   | `NAME_A` | your first name (you are person A) |
   | `NAME_B` | your partner's first name |
   | `TIMEZONE` | where your day starts and ends, e.g. `America/New_York`, `America/Chicago`, `America/Los_Angeles`, `Europe/London` |
   | `SITE_URL` | the site address from step 1 |

   Click **Save script properties**.
7. **Editor** → in the function list at the top choose **setup** → **Run**.
   Google asks for permission: **Review permissions** → pick your account → "Google hasn't verified this app" → **Advanced** → **Go to Two of Us (unsafe)** → **Allow**.
   *It says "unsafe" only because it's your own private script, not one from the store. The only access it asks for is to this one Sheet.*
8. The log at the bottom says "Setup done" and "No web app address yet". That's expected: the next step fixes it.

### Step 3. Apps Script (same tab): publish the helper and get your two links

1. **Deploy** → **New deployment**. Click the gear next to "Select type" → **Web app**.
2. Description: `Two of Us`. **Execute as: Me**. **Who has access: Anyone**. Click **Deploy** (approve again if asked), then **Done**.
   *"Anyone" is needed so your partner doesn't need your Google login. The secret key inside each link is what protects the data.*
3. In the function list choose **getLinks** → **Run**. The log shows two links: "Personal link for [you]" and "Personal link for [your partner]".
   If instead it says it can't find the web app address: **Deploy** → **Manage deployments** → copy the **Web app URL** → **Project Settings** → **Script Properties** → add `WEB_APP_URL` with that address → run **getLinks** again.
4. Get each link to the right phone privately:
   - Your link: send it only to yourself (for example, a note to yourself), open it on your phone, then delete the message.
   - Your partner's link: send it only to them in a private one-to-one message, and ask them to delete it once it's open on their phone.

### Step 4. Chrome on each phone: open your own link and install

1. Open **your own** link in Chrome. You'll see "This phone is set up."
2. Tap the **⋮** menu (top right) → **Install app** (or **Add to Home screen** → **Install**).
3. Open **Two of Us** from the home screen. That's it.

---

## Looking after it

**If a link leaks or a phone is lost (script.google.com)**
1. Open the Sheet → **Extensions** → **Apps Script**.
2. Choose **resetKeys** → **Run**. The log shows two new links; the old ones stop working straight away.
3. Each of you opens your new link on your phone (step 4 above). A phone with an old link shows "This link no longer works".

**Change a name or the timezone (script.google.com):** Project Settings → Script Properties → edit → Save. Nothing else to do.

**When a change to the helper arrives (script.google.com):** a pull request that changes `apps-script/` starts with a ⚠️ line. After merging it:
1. Open the Sheet → **Extensions** → **Apps Script** → **Code.gs** → replace everything with the new `apps-script/Code.gs` → **Save**.
2. **Deploy** → **Manage deployments** → pencil icon (**Edit**) → **Version: New version** → **Deploy**.
The address stays the same, so both phones keep working. Until this is done, the app shows "The helper script needs updating".

**Backup (the app):** Settings → **Export everything** downloads a `.json` file of all moods and jar notes.

**Stop using the app**
1. Chrome on each phone: Settings → **Forget this phone**, then remove the app icon.
2. script.google.com → **My Projects** → Two of Us → **⋮** → **Remove**.
3. Google Drive: delete the `Two of Us — data (private)` Sheet, then empty the Bin.

---

## Preview with made-up data (demo mode)

Add `?demo` to the site address (for example `https://<your-github-username>.github.io/two-of-us/?demo`). The app runs with made-up people ("Sam" and "Alex") and made-up data kept in memory. Nothing is sent or saved.

Other previews: `?demo=empty` (no data yet), `?demo=slow` (loading), `?demo=offline` (first load works, then the helper can't be reached), `?demo=badkey` (old link), `?demo=outdated` (helper needs updating), `?demo=setup` (not set up).

---

## For developers (and Claude Code)

| Folder | What's in it |
|---|---|
| `web/` | The app itself (HTML, CSS, JavaScript). No build step, no libraries. Published as-is to GitHub Pages by `.github/workflows/pages.yml`. |
| `web/icons/` | App icons, including the "maskable" one Android crops to shape. |
| `apps-script/` | `Code.gs` (the whole helper) and `appsscript.json` (its settings). Pasted into Apps Script by hand. |
| `tests/run.js` | Automatic checks. Runs `Code.gs` in Node with fake Google services. |
| `tools/make_icons.py` | Redraws the icons (needs Pillow: `pip install Pillow`). |

- Run the checks: `node tests/run.js` (must end with `N passed`, no ✗).
- Preview: `cd web && python3 -m http.server 8000`, then open `http://localhost:8000/?demo`.
- Redraw icons: `python3 tools/make_icons.py`.
- Rules for changes (privacy, versions, branches): [CLAUDE.md](CLAUDE.md).
