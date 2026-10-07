'use strict';
// node test/resolve.test.js — exercises the index and resolver on the Rynix examples.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { WorkspaceIndex } = require('../src/workspace');
const { Resolver } = require('../src/resolve');

const rynix = path.resolve(__dirname, '..', '..', 'Rynix');
const file = path.join(rynix, 'examples', 'window', 'src', 'main.ryn');
const index = new WorkspaceIndex();
index.scan([path.join(rynix, 'examples', 'window')]);
const resolver = new Resolver(index);
const text = fs.readFileSync(file, 'utf8');
const ctx = resolver.context(file, text);
const lines = ctx.lines;
const lineOf = (needle) => lines.findIndex((l) => l.includes(needle));
const names = (r) => r.items.map((s) => s.name);

let passed = 0;
function check(label, fn) { fn(); passed++; console.log('ok', label); }

check('rynix modules are indexed', () => {
  assert(index.modules.has('rynix::window'), [...index.modules.keys()].join(','));
  assert(index.modules.has('rynix::graphics'));
});
check('aliases from use', () => assert.strictEqual(ctx.aliases.get('window'), 'rynix::window'));
const loop = lineOf('dt := clock.tick()');
check('window. lists Window methods', () => {
  const r = resolver.complete(ctx, loop, '        window.');
  assert.strictEqual(r.type, 'Window');
  for (const n of ['key_pressed', 'poll_events', 'mouse_x', 'is_focused']) assert(names(r).includes(n), n);
});
check('frame. infers Frame from gpu.begin()', () => {
  const r = resolver.complete(ctx, lineOf('frame.clear'), '        frame.');
  assert.strictEqual(r.type, 'Frame');
  assert(names(r).includes('draw_cube') && names(r).includes('width'));
});
check('camera.eye. resolves field type Vec3', () => {
  const r = resolver.complete(ctx, loop, '        camera.eye.');
  assert.strictEqual(r.type, 'Vec3');
  assert(names(r).includes('cross'));
});
check('math::Color:: lists constants', () => {
  const r = resolver.complete(ctx, loop, '        c := math::Color::');
  assert(names(r).includes('SKY_BLUE') && names(r).includes('rgb'));
});
check('window::KeyCode:: lists keys', () => {
  const r = resolver.complete(ctx, loop, '        window.key_down(window::KeyCode::');
  assert(names(r).includes('ESCAPE') && names(r).includes('F12'));
});
check('time:: lists Clock', () => assert(names(resolver.complete(ctx, loop, '    x := time::')).includes('Clock')));
check('std:: lists std modules', () => {
  const r = resolver.complete(ctx, 0, 'use std::');
  assert(names(r).includes('time') && names(r).includes('fs'));
});
check('use rynix:: lists rynix modules', () => {
  const r = resolver.complete(ctx, 0, 'use rynix::');
  assert(names(r).includes('graphics') && names(r).includes('time'));
});
check('global completion has keywords and locals', () => {
  const r = resolver.complete(ctx, loop, '        ');
  assert(names(r).includes('when') && names(r).includes('camera') && names(r).includes('f32'));
});
check('signature help inside draw_cube', () => {
  const s = resolver.signatureAt(ctx, lineOf('frame.clear'), '        frame.draw_cube(camera, math::Vec3::new(0.0, 1.0, 2.0), ');
  assert.strictEqual(s.symbol.name, 'draw_cube');
  assert.strictEqual(s.active, 2);
});
check('hover on poll_events_for', () => {
  const l = lineOf('poll_events_for');
  const s = resolver.symbolAt(ctx, l, lines[l].indexOf('poll_events_for') + 3);
  assert.strictEqual(s.owner, 'Window');
  assert(/timeout_ms/.test(s.signature) && s.file.endsWith('window.ryn'));
});
check('hover on Clock::start via path', () => {
  const l = lineOf('time::Clock::start');
  const s = resolver.symbolAt(ctx, l, lines[l].indexOf('start') + 1);
  assert.strictEqual(s.name, 'start');
  assert.strictEqual(s.owner, 'Clock');
});
check('std function signature', () => {
  const sctx = resolver.context(path.join(__dirname, 'scratch.ryn'), 'use std::time\n\nfun main() {\n    time::sleep(\n}\n');
  const s = resolver.signatureAt(sctx, 3, '    time::sleep(');
  assert(s && /duration_ms/.test(s.symbol.signature));
});
console.log(`${passed} checks passed`);
