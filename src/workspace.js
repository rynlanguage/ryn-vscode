'use strict';

// Symbol index for a Ryn workspace: project modules, path dependencies from
// ryn.yaml, and the bundled std surface. Pure Node; no VS Code imports, so the
// lookup logic can be tested without an editor.

const fs = require('fs');
const path = require('path');
const { indexSource } = require('./indexer');
const std = require('../data/std.json');

const SKIP_DIRS = new Set(['build', 'target', 'node_modules', '.git']);

function readManifest(dir) {
  const file = path.join(dir, 'ryn.yaml');
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const name = (/^name:\s*["']?([^"'\s]+)/m.exec(text) || [])[1] || path.basename(dir);
  const deps = [];
  // dependencies:
  //   rynix:
  //     path: ../Rynix
  const block = /^dependencies:\s*\n((?:[ \t]+.*\n?)*)/m.exec(text);
  if (block) {
    let current = null;
    for (const line of block[1].split(/\r?\n/)) {
      const dep = /^\s{2}([A-Za-z0-9_-]+):\s*$/.exec(line);
      if (dep) { current = dep[1]; continue; }
      const p = /^\s{4,}path:\s*["']?([^"'\n]+?)["']?\s*$/.exec(line);
      if (p && current) deps.push({ name: current.replace(/-/g, '_'), dir: path.resolve(dir, p[1]) });
    }
  }
  return { name: name.replace(/-/g, '_'), dir, deps };
}

function listRynFiles(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) listRynFiles(path.join(dir, entry.name), out);
    } else if (entry.name.endsWith('.ryn')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** Walks up from a file to the directory holding ryn.yaml. */
function findProjectDir(file) {
  let dir = path.dirname(file);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'ryn.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

class WorkspaceIndex {
  constructor() {
    /** module path ("rynix::window", "std::time", "math") -> symbol list */
    this.modules = new Map();
    /** file -> module path */
    this.fileModules = new Map();
    this.overrides = new Map();
    this.loadStd();
  }

  loadStd() {
    for (const [name, symbols] of Object.entries(std.modules)) {
      this.modules.set(`std::${name}`, symbols.map((s) => ({ ...s, module: `std::${name}` })));
    }
  }

  /** Indexes every project under the given roots plus their path dependencies. */
  scan(roots) {
    const projects = new Map();
    const visit = (dir) => {
      const manifest = readManifest(dir);
      if (!manifest || projects.has(manifest.dir)) return;
      projects.set(manifest.dir, manifest);
      for (const dep of manifest.deps) {
        const depManifest = readManifest(dep.dir);
        if (depManifest) { depManifest.name = dep.name; projects.set(depManifest.dir, depManifest); }
      }
    };
    for (const root of roots) {
      visit(root);
      for (const file of listRynFiles(root)) {
        const dir = findProjectDir(file);
        if (dir) visit(dir);
      }
    }
    for (const project of projects.values()) {
      const src = path.join(project.dir, 'src');
      for (const file of listRynFiles(fs.existsSync(src) ? src : project.dir)) {
        const rel = path.relative(src, file).replace(/\\/g, '/').replace(/\.ryn$/, '');
        const modulePath = `${project.name}::${rel.split('/').join('::')}`;
        this.fileModules.set(path.normalize(file), { modulePath, local: rel.split('/').join('::'), project: project.name });
        this.indexFile(file);
      }
    }
  }

  indexFile(file, text) {
    const key = path.normalize(file);
    let info = this.fileModules.get(key);
    if (!info) {
      info = { modulePath: path.basename(file, '.ryn'), local: path.basename(file, '.ryn'), project: '' };
      this.fileModules.set(key, info);
    }
    if (text === undefined) {
      try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
    }
    const result = indexSource(text, { module: info.modulePath, file: key });
    this.modules.set(info.modulePath, result.symbols);
    return result;
  }

  /** Module paths visible from a file: `use` aliases, sibling modules and std. */
  aliases(file, uses) {
    const map = new Map();
    const info = this.fileModules.get(path.normalize(file));
    for (const u of uses) {
      const last = u.path.split('::').pop();
      map.set(last, this.resolveModulePath(u.path, info));
    }
    return map;
  }

  resolveModulePath(modulePath, info) {
    if (this.modules.has(modulePath)) return modulePath;
    if (info && info.project && this.modules.has(`${info.project}::${modulePath}`)) return `${info.project}::${modulePath}`;
    return modulePath;
  }

  symbolsOf(modulePath) {
    return this.modules.get(modulePath) || [];
  }

  /** All symbols attached to a type name across the index. */
  membersOf(typeName, preferredModule) {
    const out = [];
    const seen = new Set();
    const consider = (list) => {
      for (const s of list) {
        if (s.owner === typeName && !seen.has(s.kind + s.name)) { seen.add(s.kind + s.name); out.push(s); }
      }
    };
    if (preferredModule) consider(this.symbolsOf(preferredModule));
    for (const list of this.modules.values()) consider(list);
    return out;
  }

  findType(typeName, preferredModule) {
    const kinds = new Set(['struct', 'enum', 'type', 'shape']);
    if (preferredModule) {
      const hit = this.symbolsOf(preferredModule).find((s) => kinds.has(s.kind) && s.name === typeName);
      if (hit) return hit;
    }
    for (const list of this.modules.values()) {
      const hit = list.find((s) => kinds.has(s.kind) && s.name === typeName);
      if (hit) return hit;
    }
    return null;
  }

  allMethods() {
    const out = [];
    for (const list of this.modules.values()) for (const s of list) if (s.kind === 'method' && s.pub) out.push(s);
    return out;
  }

  moduleNames() {
    return [...this.modules.keys()];
  }
}

module.exports = { WorkspaceIndex, readManifest, findProjectDir, listRynFiles };
