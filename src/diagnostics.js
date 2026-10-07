'use strict';

// Parses `ryn check` output:
//   error[R0206]: shift requires an integer value ...
//     --> \\?\C:\project\src\window.ryn:284:92
//       |
//   284 |         when ...
//       |                 ^~~~~
//     help: use an integer value ...

const HEADER = /^(error|warning|note)(?:\[([A-Z]\d+)\])?:\s*(.*)$/;
const LOCATION = /^\s*-->\s*(.+?):(\d+):(\d+)\s*$/;
const UNDERLINE = /^\s*\|\s?(\s*)(\^~*)/;
const HELP = /^\s*help:\s*(.*)$/;

function cleanPath(file) {
  return file.replace(/^\\\\\?\\/, '').replace(/^\/\/\?\//, '');
}

/** @returns {Array<{severity, code, message, help, file, line, column, length}>} */
function parseCheckOutput(output) {
  const items = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    let m;
    if ((m = HEADER.exec(line))) {
      current = { severity: m[1], code: m[2] || '', message: m[3], help: '', file: '', line: 0, column: 0, length: 1 };
      items.push(current);
    } else if (current && (m = LOCATION.exec(line)) && !current.file) {
      current.file = cleanPath(m[1]);
      current.line = Number(m[2]) - 1;
      current.column = Math.max(0, Number(m[3]) - 1);
    } else if (current && (m = UNDERLINE.exec(line))) {
      current.length = Math.max(1, m[2].length);
    } else if (current && (m = HELP.exec(line))) {
      current.help = current.help ? `${current.help}\n${m[1]}` : m[1];
    }
  }
  return items.filter((d) => d.file);
}

module.exports = { parseCheckOutput, cleanPath };
