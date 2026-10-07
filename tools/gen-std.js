'use strict';

// Regenerates data/std.json from a Ryn checkout:
//   node tools/gen-std.js ../Ryn/stdlib/std/src
const fs = require('fs');
const path = require('path');
const { indexSource } = require('../src/indexer');

const source = path.resolve(process.argv[2] || path.join(__dirname, '..', '..', 'Ryn', 'stdlib', 'std', 'src'));
const out = path.join(__dirname, '..', 'data', 'std.json');

const modules = {};
for (const file of fs.readdirSync(source).filter((f) => f.endsWith('.ryn')).sort()) {
  const name = path.basename(file, '.ryn');
  const { symbols } = indexSource(fs.readFileSync(path.join(source, file), 'utf8'), { module: `std::${name}` });
  modules[name] = symbols
    .filter((s) => s.pub)
    .map(({ file: _file, line: _line, ...rest }) => rest);
}

fs.writeFileSync(out, JSON.stringify({ generatedFrom: 'Ryn stdlib', modules }, null, 1) + '\n');
const count = Object.values(modules).reduce((n, list) => n + list.length, 0);
console.log(`wrote ${out}: ${Object.keys(modules).length} modules, ${count} symbols`);
