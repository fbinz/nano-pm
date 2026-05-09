// Per-test fixture: copy nano-pm.html to a tmp file with an empty <div id="data">
// so every test starts from the welcome state, regardless of any local edits to
// the source file. The source is never modified.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { test: base, expect } = require('@playwright/test');

const SOURCE = path.resolve(__dirname, '..', 'nano-pm.html');

const test = base.extend({
  appUrl: async ({}, use) => {
    const orig = fs.readFileSync(SOURCE, 'utf-8');
    const empty = orig.replace(
      /<div id="data" hidden>[\s\S]*?<\/div>/m,
      '<div id="data" hidden></div>'
    );
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nano-pm-test-'));
    const tmpFile = path.join(tmpDir, 'nano-pm.html');
    fs.writeFileSync(tmpFile, empty);
    await use('file://' + tmpFile);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  },
});

module.exports = { test, expect };
