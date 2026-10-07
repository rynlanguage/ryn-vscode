'use strict';
// Every grammar regex must compile, and key tokens must be matched by some rule.
const assert = require('assert');
const grammar = require('../syntaxes/ryn.tmLanguage.json');
const patterns = [];
(function walk(node) {
  if (!node || typeof node !== 'object') return;
  for (const key of ['match', 'begin', 'end']) if (node[key]) patterns.push({ re: new RegExp(node[key]), name: node.name || '' });
  Object.values(node).forEach(walk);
})(grammar);
const matched = (text) => patterns.some((p) => p.re.test(text));
for (const sample of ['fun main', 'when', 'choose', ':=', '0xFF', '250ms', '#[drop', '"a {name}"', 'u64', 'Option']) {
  assert(matched(sample), sample);
}
console.log(`ok grammar: ${patterns.length} regexes`);
