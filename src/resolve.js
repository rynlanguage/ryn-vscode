'use strict';

// Editor-independent lookups: what to offer after `module::`, `value.`, inside a
// call, or under the cursor. Types are inferred only from simple local forms
// (`x := Type::new(..)`, `x: Type`, `x := y.method(..)`, `self`), which covers
// most Ryn code without a real type checker.

const { indexSource, stripLine } = require('./indexer');

const KEYWORDS = [
  'fun', 'pub', 'mut', 'when', 'else', 'while', 'for', 'in', 'break', 'continue', 'return',
  'echo', 'struct', 'enum', 'shape', 'type', 'extend', 'namespace', 'const', 'use', 'choose',
  'as', 'true', 'false', 'self', 'extern',
];
const PRIMITIVES = ['i8', 'i16', 'i32', 'i64', 'u8', 'u16', 'u32', 'u64', 'f32', 'f64', 'bool', 'char', 'str'];
const BUILTIN_TYPES = ['String', 'Vec', 'Map', 'HashMap', 'Set', 'Option', 'Result'];
const BUILTIN_FUNCTIONS = [
  { name: 'sizeof', signature: 'sizeof(Type) -> u64', doc: 'Compile-time size of a type in bytes.' },
  { name: 'alignof', signature: 'alignof(Type) -> u64', doc: 'Compile-time alignment of a type in bytes.' },
  { name: 'load_library', signature: 'load_library(name: str) -> *u8', doc: 'Loads a native library; null on failure.' },
  { name: 'load_symbol', signature: 'load_symbol(library: *u8, name: str) -> *u8', doc: 'Looks up an exported symbol; null when missing.' },
  { name: 'unload_library', signature: 'unload_library(library: *u8)', doc: 'Releases a library from load_library.' },
  { name: 'pointer_is_null', signature: 'pointer_is_null(pointer: *u8) -> bool', doc: 'True for a null raw pointer.' },
];

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/;
const isType = (name) => /^[A-Z]/.test(name) && /[a-z]/.test(name);

/** `math::Vec3`, `Option<Vec3>`, `*u8` -> { type: 'Vec3', module: 'math' } */
function typeOfText(text) {
  if (!text) return null;
  let t = text.trim().replace(/^&(raw\s+)?(mut\s+)?/, '');
  const generic = /^(Option|Vec|Result)<(.+)>$/.exec(t);
  if (generic && generic[1] !== 'Vec') t = generic[2].split(',')[0].trim();
  const m = /^((?:[A-Za-z_][A-Za-z0-9_]*::)*)([A-Za-z_][A-Za-z0-9_]*)/.exec(t);
  if (!m) return null;
  const prefix = m[1].replace(/::$/, '');
  return { type: m[2], module: prefix };
}

class Resolver {
  /** @param {import('./workspace').WorkspaceIndex} index */
  constructor(index) {
    this.index = index;
  }

  /** Re-indexes the open document and returns its context. */
  context(file, text) {
    const result = this.index.indexFile(file, text) || indexSource(text);
    const aliases = this.index.aliases(file, result.uses);
    const info = this.index.fileModules.get(require('path').normalize(file));
    return { file, text, lines: text.split(/\r?\n/), uses: result.uses, symbols: result.symbols, aliases, module: info ? info.modulePath : '' };
  }

  moduleFor(ctx, prefix) {
    if (!prefix) return ctx.module;
    const first = prefix.split('::')[0];
    if (ctx.aliases.has(first)) {
      const rest = prefix.split('::').slice(1);
      return [ctx.aliases.get(first), ...rest].join('::');
    }
    return this.index.resolveModulePath(prefix, this.index.fileModules.get(require('path').normalize(ctx.file)));
  }

  /** Name of the type an `extend` block around `line` attaches to. */
  enclosingExtend(ctx, line) {
    for (let i = line; i >= 0; i--) {
      const m = /^\s*extend\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(ctx.lines[i]);
      if (m) return m[1];
      if (i < line && /^\S/.test(ctx.lines[i]) && !/^\s*(\/\/|#\[|$)/.test(ctx.lines[i]) && !/^extend/.test(ctx.lines[i]) && /^(pub\s+)?(fun|struct|enum)\b/.test(ctx.lines[i])) return null;
    }
    return null;
  }

  /** Infers the type of a local name from declarations above `line`. */
  localType(ctx, name, line) {
    if (name === 'self') {
      const owner = this.enclosingExtend(ctx, line);
      return owner ? { type: owner, module: ctx.module, resolved: true } : null;
    }
    const esc = name.replace(/[$]/g, '\\$');
    const ctor = new RegExp(`\\b(?:mut\\s+)?${esc}\\s*:=\\s*((?:[A-Za-z_][A-Za-z0-9_]*::)*)([A-Z][A-Za-z0-9_]*)\\s*(::\\s*([A-Za-z_][A-Za-z0-9_]*))?`);
    const annotated = new RegExp(`\\b(?:mut\\s+)?${esc}\\s*:\\s*([&*]?(?:raw\\s+)?(?:mut\\s+)?(?:[A-Za-z_][A-Za-z0-9_]*::)*[A-Za-z_][A-Za-z0-9_<>, ]*)`);
    const fromCall = new RegExp(`\\b(?:mut\\s+)?${esc}\\s*:=\\s*([A-Za-z_][A-Za-z0-9_.()]*?)\\.([A-Za-z_][A-Za-z0-9_]*)\\s*\\(`);
    const fromPathCall = new RegExp(`\\b(?:mut\\s+)?${esc}\\s*:=\\s*((?:[A-Za-z_][A-Za-z0-9_]*::)+)([a-z_][A-Za-z0-9_]*)\\s*\\(`);
    for (let i = Math.min(line, ctx.lines.length - 1); i >= 0; i--) {
      const code = ctx.lines[i];
      let m;
      if ((m = ctor.exec(code))) {
        const moduleText = m[1].replace(/::$/, '');
        const typeName = m[2];
        const member = m[4];
        const module = this.moduleFor(ctx, moduleText);
        if (member) {
          // `Type::new(..)` returns its owner; other associated items use their declared type.
          const sym = this.index.membersOf(typeName, module).find((s) => s.name === member);
          if (sym && sym.returns) return this.normalize(ctx, typeOfText(sym.returns), module);
        }
        return { type: typeName, module, resolved: true };
      }
      if ((m = fromPathCall.exec(code))) {
        const module = this.moduleFor(ctx, m[1].replace(/::$/, ''));
        const sym = this.index.symbolsOf(module).find((s) => s.name === m[2] && !s.owner);
        if (sym && sym.returns) return this.normalize(ctx, typeOfText(sym.returns), module);
      }
      if ((m = fromCall.exec(code))) {
        const receiver = this.chainType(ctx, m[1], i);
        if (receiver) {
          const sym = this.index.membersOf(receiver.type, receiver.module).find((s) => s.name === m[2]);
          if (sym && sym.returns) return this.normalize(ctx, typeOfText(sym.returns), receiver.module);
        }
      }
      if ((m = annotated.exec(code))) {
        return this.normalize(ctx, typeOfText(m[1]), ctx.module);
      }
    }
    return null;
  }

  /** Resolves a written type relative to the module that declared it. */
  normalize(ctx, parsed, declaringModule) {
    if (!parsed) return null;
    if (parsed.type === 'Self') return null;
    let module = declaringModule;
    if (parsed.module) {
      // A module prefix inside another module's signature refers to that module's own imports;
      // look it up by its last segment among everything indexed.
      const direct = this.moduleFor(ctx, parsed.module);
      module = this.index.modules.has(direct) ? direct
        : this.index.moduleNames().find((m) => m.endsWith(`::${parsed.module}`)) || direct;
    }
    return { type: parsed.type, module, resolved: true };
  }

  /** Type of an expression chain such as `camera.eye`, `gpu.begin()` or `math::Color::RED`. */
  chainType(ctx, chain, line) {
    const parts = splitChain(chain);
    if (!parts.length) return null;
    let current = null;
    const head = parts[0];
    const path = head.name.split('::');
    if (path.length > 1) {
      const last = path[path.length - 1];
      const prev = path[path.length - 2];
      if (isType(prev)) {
        const module = this.moduleFor(ctx, path.slice(0, -2).join('::'));
        const sym = this.index.membersOf(prev, module).find((s) => s.name === last);
        current = sym ? (sym.kind === 'variant' ? { type: prev, module } : this.normalize(ctx, typeOfText(sym.returns), module)) : null;
      } else {
        const module = this.moduleFor(ctx, path.slice(0, -1).join('::'));
        const sym = this.index.symbolsOf(module).find((s) => s.name === last && !s.owner);
        current = sym && sym.returns ? this.normalize(ctx, typeOfText(sym.returns), module) : null;
      }
    } else {
      current = this.localType(ctx, head.name, line);
    }
    for (const part of parts.slice(1)) {
      if (!current) return null;
      const sym = this.index.membersOf(current.type, current.module).find((s) => s.name === part.name);
      if (!sym || !sym.returns) return null;
      current = this.normalize(ctx, typeOfText(sym.returns), current.module);
    }
    return current;
  }

  /**
   * Completion candidates for the text before the cursor.
   * @returns {{ items: Array<object>, kind: string }}
   */
  complete(ctx, line, prefixText) {
    let m;
    if ((m = /^\s*use\s+((?:[A-Za-z_][A-Za-z0-9_]*::)*)([A-Za-z_]*)$/.exec(prefixText))) {
      const typed = m[1];
      const names = new Set();
      for (const mod of this.index.moduleNames()) {
        if (!mod.startsWith(typed)) continue;
        const next = mod.slice(typed.length).split('::')[0];
        if (next) names.add(next);
      }
      return { kind: 'module', items: [...names].sort().map((name) => ({ name, kind: 'module', detail: typed + name })) };
    }
    if ((m = /((?:[A-Za-z_][A-Za-z0-9_]*::)+)([A-Za-z_0-9]*)$/.exec(prefixText))) {
      return { kind: 'path', items: this.pathMembers(ctx, m[1].replace(/::$/, '')) };
    }
    if ((m = /([A-Za-z_][A-Za-z0-9_:]*(?:\([^()]*\))?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\([^()]*\))?)*)\.([A-Za-z_0-9]*)$/.exec(prefixText))) {
      const type = this.chainType(ctx, m[1], line);
      if (type) {
        const members = this.index.membersOf(type.type, type.module)
          .filter((s) => s.kind === 'method' || s.kind === 'field')
          .filter((s) => s.pub || s.file === require('path').normalize(ctx.file));
        if (members.length) return { kind: 'member', type: type.type, items: members };
      }
      return { kind: 'member', items: dedupe(this.index.allMethods()) };
    }
    const items = [];
    for (const k of KEYWORDS) items.push({ name: k, kind: 'keyword' });
    for (const t of PRIMITIVES) items.push({ name: t, kind: 'primitive' });
    for (const t of BUILTIN_TYPES) items.push({ name: t, kind: 'builtin-type' });
    for (const f of BUILTIN_FUNCTIONS) items.push({ ...f, kind: 'builtin' });
    for (const [alias, mod] of ctx.aliases) items.push({ name: alias, kind: 'module', detail: mod });
    for (const s of ctx.symbols) if (!s.owner) items.push(s);
    for (const local of localNames(ctx.lines, line)) items.push({ name: local, kind: 'variable' });
    return { kind: 'global', items: dedupe(items) };
  }

  pathMembers(ctx, prefix) {
    const segments = prefix.split('::');
    const last = segments[segments.length - 1];
    if (isType(last) || /^[A-Z]/.test(last)) {
      const module = this.moduleFor(ctx, segments.slice(0, -1).join('::'));
      const local = require('path').normalize(ctx.file);
      return this.index.membersOf(last, module)
        .filter((s) => s.kind === 'associated' || s.kind === 'const' || s.kind === 'variant')
        .filter((s) => s.pub || s.file === local);
    }
    const module = this.moduleFor(ctx, prefix);
    const own = this.index.symbolsOf(module).filter((s) => !s.owner && (s.pub || module === ctx.module));
    const children = new Set();
    for (const mod of this.index.moduleNames()) {
      if (mod.startsWith(module + '::')) children.add(mod.slice(module.length + 2).split('::')[0]);
      if (mod.startsWith(prefix + '::')) children.add(mod.slice(prefix.length + 2).split('::')[0]);
    }
    return [...own, ...[...children].map((name) => ({ name, kind: 'module', detail: `${module}::${name}` }))];
  }

  /** The symbol a cursor position refers to, for hover and go-to-definition. */
  symbolAt(ctx, line, character) {
    const text = ctx.lines[line] || '';
    const word = wordAt(text, character);
    if (!word) return null;
    const before = text.slice(0, word.start);
    let m;
    if ((m = /((?:[A-Za-z_][A-Za-z0-9_]*::)+)$/.exec(before))) {
      return this.pathMembers(ctx, m[1].replace(/::$/, '')).find((s) => s.name === word.text) || null;
    }
    if ((m = /([A-Za-z_][A-Za-z0-9_:]*(?:\([^()]*\))?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\([^()]*\))?)*)\.$/.exec(before))) {
      const type = this.chainType(ctx, m[1], line);
      if (type) {
        const hit = this.index.membersOf(type.type, type.module).find((s) => s.name === word.text);
        if (hit) return hit;
      }
      return this.index.allMethods().find((s) => s.name === word.text) || null;
    }
    const own = ctx.symbols.find((s) => s.name === word.text && !s.owner);
    if (own) return own;
    const builtin = BUILTIN_FUNCTIONS.find((f) => f.name === word.text);
    if (builtin) return { ...builtin, kind: 'builtin' };
    if (ctx.aliases.has(word.text)) return { name: word.text, kind: 'module', signature: `use ${ctx.aliases.get(word.text)}` };
    const type = this.index.findType(word.text, ctx.module);
    if (type) return type;
    return null;
  }

  /** Signature help for the innermost open call before the cursor. */
  signatureAt(ctx, line, prefixText) {
    let depth = 0;
    let commas = 0;
    const code = stripLine(prefixText, { blockDepth: 0 });
    for (let i = code.length - 1; i >= 0; i--) {
      const ch = code[i];
      if (ch === ')' || ch === ']' || ch === '}') depth++;
      else if (ch === '(' || ch === '[' || ch === '{') {
        if (depth === 0) {
          if (ch !== '(') return null;
          const callee = /([A-Za-z_][A-Za-z0-9_:]*(?:\([^()]*\))?(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\([^()]*\))?)*)\s*$/.exec(code.slice(0, i));
          if (!callee) return null;
          const sym = this.calleeSymbol(ctx, line, callee[1]);
          return sym ? { symbol: sym, active: commas } : null;
        }
        depth--;
      } else if (ch === ',' && depth === 0) commas++;
    }
    return null;
  }

  calleeSymbol(ctx, line, callee) {
    const dot = callee.lastIndexOf('.');
    const colons = callee.lastIndexOf('::');
    if (dot > colons && dot > 0) {
      const type = this.chainType(ctx, callee.slice(0, dot), line);
      const name = callee.slice(dot + 1);
      if (type) {
        const hit = this.index.membersOf(type.type, type.module).find((s) => s.name === name);
        if (hit) return hit;
      }
      return this.index.allMethods().find((s) => s.name === name) || null;
    }
    if (colons > 0) {
      const name = callee.slice(colons + 2);
      return this.pathMembers(ctx, callee.slice(0, colons)).find((s) => s.name === name) || null;
    }
    return ctx.symbols.find((s) => s.name === callee && s.kind === 'function')
      || BUILTIN_FUNCTIONS.find((f) => f.name === callee) || null;
  }
}

function splitChain(chain) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of chain) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '.' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current) parts.push(current);
  return parts.map((p) => ({ name: p.replace(/\(.*\)$/s, '').trim(), call: /\)$/.test(p) }));
}

function wordAt(text, character) {
  const re = new RegExp(IDENT.source, 'g');
  let m;
  while ((m = re.exec(text))) {
    if (m.index <= character && character <= m.index + m[0].length) return { text: m[0], start: m.index, end: m.index + m[0].length };
  }
  return null;
}

function localNames(lines, upto) {
  const names = new Set();
  const decl = /\b(?:mut\s+)?([a-z_][A-Za-z0-9_]*)\s*(?::=|:\s*[A-Za-z&*\[(])/g;
  for (let i = 0; i <= upto && i < lines.length; i++) {
    let m;
    decl.lastIndex = 0;
    while ((m = decl.exec(lines[i]))) if (!KEYWORDS.includes(m[1])) names.add(m[1]);
    const loop = /\bfor\s+([a-z_][A-Za-z0-9_]*)\s+in\b/.exec(lines[i]);
    if (loop) names.add(loop[1]);
  }
  return names;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((s) => {
    const key = `${s.kind}:${s.owner || ''}:${s.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { Resolver, KEYWORDS, PRIMITIVES, BUILTIN_TYPES, typeOfText, splitChain };
