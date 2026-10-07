'use strict';
// Runs the real compiler on a broken file and checks that its output parses.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { parseCheckOutput } = require('../src/diagnostics');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryn-diag-'));
const file = path.join(dir, 'broken.ryn');
fs.writeFileSync(file, 'fun main() {\n    x: i32 = "text"\n    echo x\n}\n');
let output = '';
try {
  execFileSync('ryn', ['check', file], { encoding: 'utf8', stdio: 'pipe' });
} catch (err) {
  output = `${err.stdout || ''}\n${err.stderr || ''}`;
}
const items = parseCheckOutput(output);
assert(items.length >= 1, `no diagnostics parsed from:\n${output}`);
const first = items[0];
assert.strictEqual(path.normalize(first.file).toLowerCase(), path.normalize(file).toLowerCase());
assert.strictEqual(first.line, 1);
assert(first.code.startsWith('R'));
console.log('ok diagnostics', JSON.stringify(first));
