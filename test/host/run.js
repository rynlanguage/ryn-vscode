'use strict';
// Launches the locally installed VS Code with this extension and runs suite.js inside it.
const path = require('path');
const { runTests } = require('@vscode/test-electron');

const exe = process.env.VSCODE_EXE || 'C:/Program Files/Microsoft VS Code/Code.exe';
runTests({
  vscodeExecutablePath: exe,
  extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
  extensionTestsPath: path.resolve(__dirname, 'suite.js'),
  launchArgs: [path.resolve(__dirname, '..', '..', '..', 'Rynix', 'examples', 'window'), '--disable-extensions', '--skip-welcome', '--disable-workspace-trust'],
}).catch((err) => { console.error(err); process.exit(1); });
