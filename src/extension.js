'use strict';

const vscode = require('vscode');
const path = require('path');
const { execFile } = require('child_process');
const { WorkspaceIndex, findProjectDir } = require('./workspace');
const { Resolver } = require('./resolve');
const { parseCheckOutput } = require('./diagnostics');

const LANGUAGE = 'ryn';
const SELECTOR = { language: LANGUAGE };

const KIND = {
  function: vscode.CompletionItemKind.Function,
  associated: vscode.CompletionItemKind.Function,
  method: vscode.CompletionItemKind.Method,
  field: vscode.CompletionItemKind.Field,
  const: vscode.CompletionItemKind.Constant,
  variant: vscode.CompletionItemKind.EnumMember,
  struct: vscode.CompletionItemKind.Struct,
  enum: vscode.CompletionItemKind.Enum,
  shape: vscode.CompletionItemKind.Interface,
  type: vscode.CompletionItemKind.TypeParameter,
  module: vscode.CompletionItemKind.Module,
  keyword: vscode.CompletionItemKind.Keyword,
  primitive: vscode.CompletionItemKind.Keyword,
  'builtin-type': vscode.CompletionItemKind.Class,
  builtin: vscode.CompletionItemKind.Function,
  variable: vscode.CompletionItemKind.Variable,
};

const SYMBOL_KIND = {
  function: vscode.SymbolKind.Function,
  associated: vscode.SymbolKind.Function,
  method: vscode.SymbolKind.Method,
  field: vscode.SymbolKind.Field,
  const: vscode.SymbolKind.Constant,
  variant: vscode.SymbolKind.EnumMember,
  struct: vscode.SymbolKind.Struct,
  enum: vscode.SymbolKind.Enum,
  shape: vscode.SymbolKind.Interface,
  type: vscode.SymbolKind.TypeParameter,
};

let index;
let resolver;

function config() {
  return vscode.workspace.getConfiguration('ryn');
}

function rescan() {
  index = new WorkspaceIndex();
  const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.languageId === LANGUAGE && doc.uri.scheme === 'file') {
      const dir = findProjectDir(doc.uri.fsPath);
      if (dir) roots.push(dir);
    }
  }
  try {
    index.scan(roots);
  } catch (err) {
    console.error('ryn: index scan failed', err);
  }
  resolver = new Resolver(index);
}

function contextFor(document) {
  return resolver.context(document.uri.fsPath, document.getText());
}

function markdownFor(symbol) {
  const md = new vscode.MarkdownString();
  const owner = symbol.owner ? `${symbol.owner}::` : '';
  const signature = symbol.signature || `${owner}${symbol.name}`;
  md.appendCodeblock(signature, LANGUAGE);
  if (symbol.doc) md.appendMarkdown(`\n${symbol.doc}\n`);
  const where = [symbol.module, symbol.owner && `extend ${symbol.owner}`].filter(Boolean).join(' · ');
  if (where) md.appendMarkdown(`\n_${where}_`);
  return md;
}

function completionItem(symbol, range) {
  const item = new vscode.CompletionItem(symbol.name, KIND[symbol.kind] || vscode.CompletionItemKind.Text);
  if (range) item.range = range;
  if (symbol.kind === 'keyword') {
    item.detail = 'keyword';
    return item;
  }
  item.detail = symbol.signature || symbol.detail || symbol.returns || symbol.kind;
  if (symbol.signature || symbol.doc) item.documentation = markdownFor(symbol);
  const callable = ['function', 'associated', 'method', 'builtin'].includes(symbol.kind);
  if (callable && config().get('completion.insertParentheses', true)) {
    const hasParams = symbol.params ? symbol.params.length > 0 : /\(\s*[^)\s]/.test(symbol.signature || '');
    item.insertText = new vscode.SnippetString(hasParams ? `${symbol.name}($0)` : `${symbol.name}()`);
    if (hasParams) item.command = { command: 'editor.action.triggerParameterHints', title: 'Parameter hints' };
  }
  // Sort fields before methods after a dot, and keep private helpers last.
  const order = { field: '0', method: '1', associated: '1', const: '2', variant: '2', function: '3', module: '4', variable: '5' };
  item.sortText = `${symbol.pub === false ? '9' : order[symbol.kind] || '6'}${symbol.name}`;
  return item;
}

class CompletionProvider {
  provideCompletionItems(document, position) {
    const prefix = document.lineAt(position.line).text.slice(0, position.character);
    if (/^\s*\/\//.test(prefix)) return [];
    const ctx = contextFor(document);
    const result = resolver.complete(ctx, position.line, prefix);
    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/);
    return result.items.map((s) => completionItem(s, wordRange));
  }
}

class HoverProvider {
  provideHover(document, position) {
    const ctx = contextFor(document);
    const symbol = resolver.symbolAt(ctx, position.line, position.character);
    if (!symbol) return null;
    return new vscode.Hover(markdownFor(symbol));
  }
}

class DefinitionProvider {
  provideDefinition(document, position) {
    const ctx = contextFor(document);
    const symbol = resolver.symbolAt(ctx, position.line, position.character);
    if (!symbol || !symbol.file) return null;
    return new vscode.Location(vscode.Uri.file(symbol.file), new vscode.Position(symbol.line || 0, 0));
  }
}

class SignatureProvider {
  provideSignatureHelp(document, position) {
    const prefix = document.getText(new vscode.Range(new vscode.Position(Math.max(0, position.line - 8), 0), position)).replace(/\r?\n\s*/g, ' ');
    const ctx = contextFor(document);
    const found = resolver.signatureAt(ctx, position.line, prefix);
    if (!found) return null;
    const { symbol, active } = found;
    const info = new vscode.SignatureInformation(symbol.signature || symbol.name, symbol.doc || undefined);
    const params = symbol.params || [];
    info.parameters = params.map((p) => new vscode.ParameterInformation(p));
    const help = new vscode.SignatureHelp();
    help.signatures = [info];
    help.activeSignature = 0;
    help.activeParameter = Math.min(active, Math.max(0, params.length - 1));
    return help;
  }
}

class SymbolProvider {
  provideDocumentSymbols(document) {
    const ctx = contextFor(document);
    const containers = new Map();
    const top = [];
    const rangeOf = (s) => document.lineAt(Math.min(s.line, document.lineCount - 1)).range;
    for (const s of ctx.symbols) {
      if (s.owner) continue;
      const sym = new vscode.DocumentSymbol(s.name, s.signature || '', SYMBOL_KIND[s.kind] || vscode.SymbolKind.Variable, rangeOf(s), rangeOf(s));
      top.push(sym);
      if (['struct', 'enum', 'shape', 'type'].includes(s.kind)) containers.set(s.name, sym);
    }
    for (const s of ctx.symbols) {
      if (!s.owner) continue;
      const sym = new vscode.DocumentSymbol(s.name, s.signature || '', SYMBOL_KIND[s.kind] || vscode.SymbolKind.Variable, rangeOf(s), rangeOf(s));
      let parent = containers.get(s.owner);
      if (!parent) {
        // `extend` of a type declared elsewhere.
        parent = new vscode.DocumentSymbol(`extend ${s.owner}`, '', vscode.SymbolKind.Namespace, rangeOf(s), rangeOf(s));
        containers.set(s.owner, parent);
        top.push(parent);
      }
      parent.children.push(sym);
    }
    return top;
  }
}

class Checker {
  constructor() {
    this.collection = vscode.languages.createDiagnosticCollection('ryn');
    this.running = new Map();
    this.warned = false;
  }

  check(document) {
    if (document.languageId !== LANGUAGE || document.uri.scheme !== 'file') return;
    if (!config().get('check.onSave', true)) return;
    const file = document.uri.fsPath;
    const target = findProjectDir(file) || file;
    const previous = this.running.get(target);
    if (previous) previous.kill();
    const exe = config().get('path', 'ryn') || 'ryn';
    const child = execFile(exe, ['check', target], { cwd: path.dirname(file), timeout: 60000, windowsHide: true }, (error, stdout, stderr) => {
      if (this.running.get(target) === child) this.running.delete(target);
      if (error && error.code === 'ENOENT') {
        if (!this.warned) {
          this.warned = true;
          vscode.window.showWarningMessage(`Ryn: could not run "${exe}". Set "ryn.path" to the ryn compiler to see errors on save.`);
        }
        return;
      }
      if (error && error.killed) return;
      this.publish(target, parseCheckOutput(`${stdout}\n${stderr}`));
    });
    this.running.set(target, child);
  }

  publish(target, items) {
    // Clear every file of this project, then report the new results.
    this.collection.forEach((uri) => {
      if (uri.fsPath.startsWith(target)) this.collection.delete(uri);
    });
    const byFile = new Map();
    for (const item of items) {
      const severity = item.severity === 'warning' ? vscode.DiagnosticSeverity.Warning
        : item.severity === 'note' ? vscode.DiagnosticSeverity.Information : vscode.DiagnosticSeverity.Error;
      const range = new vscode.Range(item.line, item.column, item.line, item.column + item.length);
      const diagnostic = new vscode.Diagnostic(range, item.help ? `${item.message}\nhelp: ${item.help}` : item.message, severity);
      diagnostic.source = 'ryn';
      if (item.code) diagnostic.code = item.code;
      const key = path.normalize(item.file);
      if (!byFile.has(key)) byFile.set(key, []);
      byFile.get(key).push(diagnostic);
    }
    for (const [file, list] of byFile) this.collection.set(vscode.Uri.file(file), list);
  }

  dispose() {
    for (const child of this.running.values()) child.kill();
    this.collection.dispose();
  }
}

function runInTerminal(command) {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== LANGUAGE) {
    vscode.window.showInformationMessage('Open a .ryn file first.');
    return;
  }
  const file = editor.document.uri.fsPath;
  const target = findProjectDir(file) || file;
  const exe = config().get('path', 'ryn') || 'ryn';
  let terminal = vscode.window.terminals.find((t) => t.name === 'Ryn');
  if (!terminal) terminal = vscode.window.createTerminal('Ryn');
  terminal.show(true);
  // PowerShell needs the call operator to run a quoted executable path.
  const program = /\s/.test(exe) ? (process.platform === 'win32' ? `& "${exe}"` : `"${exe}"`) : exe;
  editor.document.save().then(() => terminal.sendText(`${program} ${command} "${target}"`));
}

function activate(context) {
  rescan();
  const checker = new Checker();
  context.subscriptions.push(
    checker,
    vscode.languages.registerCompletionItemProvider(SELECTOR, new CompletionProvider(), '.', ':'),
    vscode.languages.registerHoverProvider(SELECTOR, new HoverProvider()),
    vscode.languages.registerDefinitionProvider(SELECTOR, new DefinitionProvider()),
    vscode.languages.registerSignatureHelpProvider(SELECTOR, new SignatureProvider(), '(', ','),
    vscode.languages.registerDocumentSymbolProvider(SELECTOR, new SymbolProvider()),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId === LANGUAGE) index.indexFile(doc.uri.fsPath, doc.getText());
      if (doc.fileName.endsWith('ryn.yaml')) rescan();
      checker.check(doc);
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.languageId === LANGUAGE && doc.uri.scheme === 'file' && !index.fileModules.has(path.normalize(doc.uri.fsPath))) rescan();
      checker.check(doc);
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(rescan),
    vscode.commands.registerCommand('ryn.run', () => runInTerminal('run')),
    vscode.commands.registerCommand('ryn.build', () => runInTerminal('build')),
    vscode.commands.registerCommand('ryn.check', () => {
      const editor = vscode.window.activeTextEditor;
      if (editor) checker.check(editor.document);
    }),
    vscode.commands.registerCommand('ryn.reindex', rescan),
  );
  for (const doc of vscode.workspace.textDocuments) checker.check(doc);
}

function deactivate() {}

module.exports = { activate, deactivate };
