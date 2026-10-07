'use strict';

// Line-based symbol extraction for Ryn sources. It understands the declaration
// forms Ryn uses (fun, struct, enum, type, extend, const) well enough for
// completion, hover and outline; it is not a parser and never rejects input.

const IDENT = '[A-Za-z_][A-Za-z0-9_]*';

const FUN_RE = new RegExp(`^\\s*(pub\\s+)?fun\\s+(${IDENT})\\s*\\(`);
const STRUCT_RE = new RegExp(`^\\s*(pub\\s+)?struct\\s+(${IDENT})`);
const ENUM_RE = new RegExp(`^\\s*(pub\\s+)?enum\\s+(${IDENT})`);
const SHAPE_RE = new RegExp(`^\\s*(pub\\s+)?shape\\s+(${IDENT})`);
const TYPE_RE = new RegExp(`^\\s*(pub\\s+)?type\\s+(${IDENT})\\s*=\\s*(.+?)\\s*$`);
const EXTEND_RE = new RegExp(`^\\s*extend\\s+(${IDENT})`);
const CONST_RE = new RegExp(`^\\s*(pub\\s+)?const\\s+(${IDENT})\\s*:\\s*([^=]+?)\\s*=`);
const FIELD_RE = new RegExp(`(?:^\\s*|[,{]\\s*)(pub\\s+)?(${IDENT})\\s*:\\s*([^,}]+)`, 'g');
const USE_RE = new RegExp(`^\\s*use\\s+(${IDENT}(?:::${IDENT})*)`);

/** Removes string contents and comments so brace counting is not fooled. */
function stripLine(line, state) {
  let out = '';
  let i = 0;
  while (i < line.length) {
    if (state.blockDepth > 0) {
      if (line.startsWith('/*', i)) { state.blockDepth++; i += 2; continue; }
      if (line.startsWith('*/', i)) { state.blockDepth--; i += 2; continue; }
      i++;
      continue;
    }
    if (line.startsWith('//', i)) break;
    if (line.startsWith('/*', i)) { state.blockDepth++; i += 2; continue; }
    const ch = line[i];
    if (ch === '"') {
      out += '""';
      i++;
      while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === "'" && /^'(?:\\.|[^'\\])'/.test(line.slice(i))) {
      const m = /^'(?:\\.|[^'\\])'/.exec(line.slice(i));
      out += "' '";
      i += m[0].length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Collects `//` lines directly above a declaration as its documentation. */
function docAbove(lines, index) {
  const doc = [];
  for (let i = index - 1; i >= 0; i--) {
    const m = /^\s*\/\/\s?(.*)$/.exec(lines[i]);
    if (!m) {
      if (/^\s*#\[/.test(lines[i])) continue;
      break;
    }
    doc.unshift(m[1]);
  }
  return doc.join('\n').trim();
}

/** Reads a function signature that may continue over several lines. */
function readSignature(lines, index) {
  let text = '';
  for (let i = index; i < lines.length && i < index + 20; i++) {
    text += (text ? ' ' : '') + lines[i].replace(/\/\/.*$/, '').trim();
    if (closingParen(text) >= 0) break;
  }
  const close = closingParen(text);
  if (close < 0) return text.trim();
  const rest = text.slice(close + 1);
  const ret = /^\s*->\s*(.*?)\s*(\{|=>|$)/.exec(rest);
  const head = text.slice(0, close + 1).replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/,?\s+\)$/, ')');
  return ret && ret[1] ? `${head} -> ${ret[1]}` : head;
}

function closingParen(text) {
  const open = text.indexOf('(');
  if (open < 0) return -1;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    if (text[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/** Splits `fun name(a: T, mut self)` parameters at top-level commas. */
function parameters(signature) {
  const open = signature.indexOf('(');
  const close = signature.lastIndexOf(')');
  if (open < 0 || close < open) return [];
  const inner = signature.slice(open + 1, close);
  const params = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if ('(<['.includes(ch)) depth++;
    if (')>]'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) { params.push(current.trim()); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) params.push(current.trim());
  return params;
}

function returnType(signature) {
  const m = /\)\s*->\s*(.+)$/.exec(signature);
  return m ? m[1].trim() : '';
}

/**
 * Indexes one Ryn source.
 * @param {string} text
 * @param {{module?: string, file?: string}} meta
 */
function indexSource(text, meta = {}) {
  const lines = text.split(/\r?\n/);
  const symbols = [];
  const uses = [];
  const state = { blockDepth: 0 };
  let depth = 0;
  // Stack of open declaration blocks: { kind, name, depth }
  const blocks = [];

  const base = (kind, name, line, extra) => Object.assign({
    kind, name, line, module: meta.module || '', file: meta.file || '',
  }, extra);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const code = stripLine(raw, state);
    const top = blocks.length ? blocks[blocks.length - 1] : null;
    const atTop = !top;
    const inExtend = top && top.kind === 'extend' && depth === top.depth + 1;
    const inStruct = top && top.kind === 'struct' && depth === top.depth + 1;
    const inEnum = top && top.kind === 'enum' && depth === top.depth + 1;

    let m;
    if (atTop && depth === 0 && (m = USE_RE.exec(code))) {
      uses.push({ path: m[1], line: i });
    } else if ((atTop || inExtend) && (m = FUN_RE.exec(code))) {
      const signature = readSignature(lines, i);
      const params = parameters(signature);
      const isMethod = params.length > 0 && /^(mut\s+)?self\b/.test(params[0]);
      const kind = inExtend ? (isMethod ? 'method' : 'associated') : 'function';
      symbols.push(base(kind, m[2], i, {
        pub: Boolean(m[1]),
        owner: inExtend ? top.name : '',
        signature: signature.replace(/^\s*/, ''),
        params: isMethod ? params.slice(1) : params,
        returns: returnType(signature),
        doc: docAbove(lines, i),
      }));
    } else if (atTop && (m = STRUCT_RE.exec(code))) {
      symbols.push(base('struct', m[2], i, { pub: Boolean(m[1]), doc: docAbove(lines, i), signature: `struct ${m[2]}` }));
      if (code.includes('{')) blocks.push({ kind: 'struct', name: m[2], depth, opened: false });
      // One-line `struct Point { x: i32, y: i32 }`
      if (code.includes('{') && code.includes('}')) {
        collectFields(code.slice(code.indexOf('{')), m[2], i);
      }
    } else if (atTop && (m = ENUM_RE.exec(code))) {
      symbols.push(base('enum', m[2], i, { pub: Boolean(m[1]), doc: docAbove(lines, i), signature: `enum ${m[2]}` }));
      if (code.includes('{')) blocks.push({ kind: 'enum', name: m[2], depth });
    } else if (atTop && (m = SHAPE_RE.exec(code))) {
      symbols.push(base('shape', m[2], i, { pub: Boolean(m[1]), doc: docAbove(lines, i), signature: `shape ${m[2]}` }));
      if (code.includes('{')) blocks.push({ kind: 'shape', name: m[2], depth });
    } else if (atTop && (m = TYPE_RE.exec(code))) {
      symbols.push(base('type', m[2], i, { pub: Boolean(m[1]), doc: docAbove(lines, i), signature: `type ${m[2]} = ${m[3]}` }));
    } else if (atTop && (m = EXTEND_RE.exec(code))) {
      blocks.push({ kind: 'extend', name: m[1], depth });
    } else if ((atTop || inExtend) && (m = CONST_RE.exec(code))) {
      symbols.push(base('const', m[2], i, {
        pub: Boolean(m[1]), owner: inExtend ? top.name : '',
        signature: `const ${m[2]}: ${m[3].trim()}`, returns: m[3].trim(), doc: docAbove(lines, i),
      }));
    } else if (inStruct) {
      collectFields(code, top.name, i);
    } else if (inEnum) {
      const variant = new RegExp(`^\\s*(${IDENT})\\s*(\\(([^)]*)\\))?`).exec(code);
      if (variant && variant[1] !== '}') {
        symbols.push(base('variant', variant[1], i, {
          owner: top.name, pub: true, doc: docAbove(lines, i),
          signature: `${top.name}::${variant[1]}${variant[2] || ''}`,
        }));
      }
    }

    for (const ch of code) {
      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        while (blocks.length && depth <= blocks[blocks.length - 1].depth) blocks.pop();
      }
    }
  }

  function collectFields(code, owner, line) {
    FIELD_RE.lastIndex = 0;
    let f;
    while ((f = FIELD_RE.exec(code))) {
      if (f[2] === 'pub') continue;
      symbols.push(base('field', f[2], line, {
        owner, pub: Boolean(f[1]), returns: f[3].trim(), signature: `${f[2]}: ${f[3].trim()}`, doc: docAbove(lines, line),
      }));
    }
  }

  return { symbols, uses };
}

module.exports = { indexSource, parameters, returnType, stripLine };
