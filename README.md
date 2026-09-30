# Two of Us

A private little app for two people: a **daily mood check-in** and a shared **gratitude jar**. It installs on an Android phone like a normal app.

- The screens are a small website hosted on **GitHub Pages** (free hosting from this repo).
- The data lives in a **Google Sheet** in the owner's own Google account, reached through a small **Google Apps Script** helper.

How it behaves is described in [SPEC.md](SPEC.md). Rules for working on it are in [CLAUDE.md](CLAUDE.md).

> Work in progress: step-by-step setup instructions will be added here once the app is built.

## Folders

| Folder | What's in it |
|---|---|
| `web/` | The app itself (HTML, CSS, JavaScript). Published as-is to GitHub Pages. |
| `apps-script/` | The helper script you paste into Google Apps Script. |
| `tests/` | Automatic checks. Run `node tests/run.js`. |
| `tools/` | Small helper scripts (for example, to redraw the app icons). |
