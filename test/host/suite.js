'use strict';
// Runs inside the VS Code extension host.
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const vscode = require('vscode');

async function waitFor(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 250));
  }
}

exports.run = async function run() {
  const results = [];
  const ok = (label) => { results.push(label); console.log('ok', label); };
  const file = path.resolve(__dirname, '..', '..', '..', 'Rynix', 'examples', 'window', 'src', 'main.ryn');
  const doc = await vscode.workspace.openTextDocument(file);
  await vscode.window.showTextDocument(doc);
  assert.strictEqual(doc.languageId, 'ryn');
  ok('language id ryn');

  const text = doc.getText();
  const lineOf = (needle) => text.split(/\r?\n/).findIndex((l) => l.includes(needle));
  const loopLine = lineOf('dt := clock.tick()');
  const edit = new vscode.WorkspaceEdit();
  const probeLine = loopLine + 1;
  edit.insert(doc.uri, new vscode.Position(probeLine, 0), '        window.\n        math::Color::\n');
  await vscode.workspace.applyEdit(edit);

  const labels = async (line, character) => {
    const list = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', doc.uri, new vscode.Position(line, character), '.');
    return list.items.map((i) => (typeof i.label === 'string' ? i.label : i.label.label));
  };
  const methods = await labels(probeLine, '        window.'.length);
  assert(methods.includes('key_pressed') && methods.includes('poll_events'), methods.slice(0, 20).join(','));
  ok('completion after window.');
  const colors = await labels(probeLine + 1, '        math::Color::'.length);
  assert(colors.includes('SKY_BLUE'), colors.slice(0, 20).join(','));
  ok('completion after math::Color::');

  const hoverLine = lineOf('poll_events_for');
  const hovers = await vscode.commands.executeCommand('vscode.executeHoverProvider', doc.uri,
    new vscode.Position(hoverLine, text.split(/\r?\n/)[hoverLine].indexOf('poll_events_for') + 3));
  const hoverText = hovers.map((h) => h.contents.map((c) => c.value || c).join('')).join('');
  assert(/timeout_ms/.test(hoverText), hoverText);
  ok('hover on poll_events_for');

  const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', doc.uri);
  assert(symbols.some((s) => s.name === 'main'));
  ok('outline lists main');

  const tokens = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokensLegend', doc.uri).catch(() => null);
  void tokens;

  // Diagnostics: a type error in a scratch file must show up after save.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ryn-host-'));
  const broken = path.join(dir, 'broken.ryn');
  fs.writeFileSync(broken, 'fun main() {\n    x: i32 = "text"\n    echo x\n}\n');
  const brokenDoc = await vscode.workspace.openTextDocument(broken);
  await vscode.window.showTextDocument(brokenDoc);
  await brokenDoc.save();
  const diags = await waitFor(() => {
    const list = vscode.languages.getDiagnostics(brokenDoc.uri);
    return list.length ? list : null;
  });
  assert(diags && diags.length && diags[0].range.start.line === 1, JSON.stringify(diags));
  ok(`diagnostic from ryn check: ${diags[0].message.split('\n')[0]}`);

  await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
  console.log(`${results.length} extension host checks passed`);
};
