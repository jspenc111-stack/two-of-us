#!/usr/bin/env node
// Two of Us tests. Run with: node tests/run.js
// Uses only Node's built-in modules (no npm packages).
'use strict';

const fs = require('fs');
const path = require('path');
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
