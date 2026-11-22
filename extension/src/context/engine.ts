/**
 * Anvil context engine: indexes a workspace and assembles a token-budgeted context pack.
 *
 * Strategy (see reports/context-strategy.md):
 *   1. Pinned first: explicit @file / @symbol mentions and the editor selection.
 *   2. Lexical retrieval: BM25 over structural chunks (Python def/class/method, rst/md sections,
 *      60-line windows elsewhere) with code-aware tokens (snake/camel split + whole identifiers),
 *      light stemming, code synonyms, and boosts for path and symbol-name matches.
 *   3. Structural expansion around the best source files: the test sibling, the docs page that
 *      covers the module, import neighbours, and callers of the selected/mentioned symbol.
 *   4. Greedy packing under the budget (tokens = ceil(chars/4)); a chunk that does not fit is
 *      downgraded to an outline (signature + first docstring line) before being dropped, and every
 *      drop is recorded with its reason.
 *
 * No vscode import here: the engine is plain node so it can be unit-tested with bun.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextItem, ContextPack } from '../shared/types';

// ---------------------------------------------------------------------------------------------
// Types

type ChunkKind = 'function' | 'class' | 'method' | 'module' | 'section' | 'window';

interface Chunk {
  id: number;
  path: string;
  startLine: number; // 1-based inclusive
  endLine: number;
  kind: ChunkKind;
  /** Symbol defined by this chunk (`name` or `Class.method`), or section title. */
  name?: string;
  /** Names assigned at module level inside a module chunk. */
  assigns?: string[];
  /** First docstring line / first prose line. */
  doc?: string;
  /** Number of signature lines (decorators + def/class header) from startLine. */
  headerLines: number;
  len: number; // token count for BM25
  tf: Map<string, number>;
  nameTokens: Set<string>;
}

interface FileInfo {
  path: string;
  lang: 'python' | 'rst' | 'md' | 'text';
  lines: string[];
  chunks: number[];
  pathTokens: Set<string>;
  isTest: boolean;
  isDoc: boolean;
  module?: string; // dotted python module name
  imports: Set<string>; // resolved file paths
  importedBy: Set<string>;
}

export interface SymbolEntry {
  name: string;
  path: string;
  line: number;
  kind: string;
  signature: string;
}

interface Candidate {
  chunk: Chunk;
  score: number;
  source: ContextItem['source'];
  reason: string;
  /** Max tokens this item may take (cap), outline fallback if larger. */
  cap?: number;
  forceOutline?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Tokenization

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'env', '__pycache__', 'build', 'dist', '.tox', '.nox',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'htmlcov', '.eggs', '.idea', 'out', '.next',
  'coverage', '.cache', 'site-packages',
]);
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svg', '.woff', '.woff2', '.ttf', '.otf',
  '.eot', '.pdf', '.zip', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.tar', '.so', '.dylib', '.dll', '.exe',
  '.pyc', '.pyo', '.whl', '.egg', '.db', '.sqlite', '.sqlite3', '.bin', '.dat', '.mp3', '.mp4', '.wav',
  '.mov', '.avi', '.class', '.jar', '.o', '.a', '.lib', '.pkl', '.npy', '.npz', '.parquet', '.lock',
  '.icns', '.psd', '.vsix',
]);
const MAX_FILE_BYTES = 300 * 1024;

const STOP = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'is', 'it', 'its', 'and', 'or', 'as', 'at', 'be', 'by', 'for', 'on',
  'with', 'this', 'that', 'these', 'those', 'from', 'are', 'was', 'were', 'has', 'have', 'had', 'will',
  'would', 'should', 'must', 'can', 'could', 'may', 'do', 'does', 'did', 'if', 'else', 'elif', 'then',
  'so', 'but', 'not', 'no', 'yes', 'we', 'you', 'they', 'he', 'she', 'them', 'our', 'your', 'my', 'me',
  'i', 'all', 'any', 'each', 'other', 'some', 'such', 'than', 'too', 'very', 'also', 'just', 'only',
  'into', 'out', 'up', 'down', 'over', 'under', 'again', 'new', 'add', 'make', 'use', 'used', 'using',
  'def', 'class', 'return', 'self', 'cls', 'import', 'pass', 'lambda', 'yield', 'raise', 'try',
  'except', 'finally', 'while', 'elif', 'del', 'global', 'nonlocal', 'assert', 'async', 'await',
  'str', 'int', 'bool', 'list', 'dict', 'typing', 'optional', 'any', 'none', 'there', 'what', 'which',
  'when', 'where', 'how', 'why', 'who', 'alongside', 'appear', 'well', 'every', 'like', 'want',
  'need', 'please', 'sure', 'ensure', 'via', 'etc', 'one', 'two',
]);

/** Stem exceptions: words where suffix stripping would create misleading collisions. */
const STEM_KEEP = new Set(['string', 'thing', 'nothing', 'something', 'during', 'ping', 'ring', 'bring',
  'class', 'process', 'access', 'status', 'alias', 'this', 'is', 'has', 'was', 'does', 'kwargs', 'args',
  'always', 'unless', 'less', 'address', 'success', 'pass', 'news', 'series', 'bias', 'axis', 'redis']);

function stem(w: string): string {
  if (w.length <= 3 || STEM_KEEP.has(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 5) {
    const s = w.slice(0, -3);
    return s.length > 2 && s[s.length - 1] === s[s.length - 2] ? s.slice(0, -1) : s; // running->run
  }
  if (w.endsWith('ed') && w.length > 4) {
    const s = w.slice(0, -2);
    if (s.endsWith('i')) return s.slice(0, -1) + 'y'; // applied->apply
    return s.length > 2 && s[s.length - 1] === s[s.length - 2] ? s.slice(0, -1) : s;
  }
  if (w.endsWith('es') && /(ch|sh|x|ss|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !/(ss|us|is|ys)$/.test(w)) return w.slice(0, -1);
  return w;
}

const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/g;

function splitIdent(word: string): string[] {
  return word
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
}

/** Code-aware tokens: whole identifiers (lowercased) + their stemmed parts. */
function tokenize(text: string, out: string[] = []): string[] {
  IDENT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = IDENT_RE.exec(text))) {
    const word = m[0];
    const parts = splitIdent(word);
    if (parts.length > 1) {
      const whole = word.toLowerCase().replace(/^_+|_+$/g, '');
      if (whole.length >= 3) out.push(whole);
    }
    for (const p of parts) {
      if (p.length < 2 || STOP.has(p)) continue;
      out.push(stem(p));
    }
  }
  return out;
}

/** Code synonyms (stemmed keys) used for query expansion, with weight relative to the original term. */
const SYNONYMS: Record<string, string[]> = {
  cli: ['command', 'click', 'group'],
  command: ['click', 'cli'],
  cmd: ['command'],
  subcommand: ['command'],
  config: ['configuration'],
  configuration: ['config'],
  setting: ['config'],
  json: ['dump', 'jsonify'],
  print: ['echo'],
  output: ['echo'],
  mask: ['redact', 'hide', 'secret'],
  hide: ['mask'],
  secret: ['key'],
  test: ['pytest', 'runner'],
  help: ['usage'],
  env: ['environ', 'environment'],
  environment: ['environ', 'env'],
  var: ['variable'],
  variable: ['var'],
  route: ['rule', 'url'],
  url: ['route', 'rule'],
  debug: ['debugger'],
  false: ['falsy'],
  true: ['truthy'],
  error: ['exception'],
  exception: ['error'],
  template: ['render', 'jinja'],
  request: ['req'],
  response: ['resp'],
  session: ['cookie'],
  app: ['application', 'flask'],
  application: ['app'],
  database: ['db', 'sqlite'],
  db: ['database'],
  log: ['logger', 'logging'],
};
const DOC_INTENT = new Set(['doc', 'docs', 'document', 'documentation', 'readme', 'docstring']);
const TEST_INTENT = new Set(['test', 'tested', 'cover', 'covered', 'coverage', 'pytest', 'unittest', 'spec']);

// ---------------------------------------------------------------------------------------------
// Helpers

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

function langOf(p: string): FileInfo['lang'] {
  const ext = path.extname(p).toLowerCase();
  if (ext === '.py' || ext === '.pyi') return 'python';
  if (ext === '.rst') return 'rst';
  if (ext === '.md' || ext === '.markdown') return 'md';
  return 'text';
}

function fenceLang(p: string): string {
  const ext = path.extname(p).toLowerCase().slice(1);
  const map: Record<string, string> = { py: 'python', pyi: 'python', ts: 'ts', js: 'js', rst: 'rst', md: 'md',
    toml: 'toml', yml: 'yaml', yaml: 'yaml', json: 'json', html: 'html', css: 'css', sh: 'bash', cfg: 'ini', ini: 'ini' };
  return map[ext] ?? '';
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function firstDocLine(lines: string[], from: number, to: number): string | undefined {
  for (let i = from; i <= to && i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    const m = t.match(/^[rbuRBU]?("""|''')(.*)$/);
    if (m) {
      let rest = m[2].replace(/("""|''').*$/, '').trim();
      if (!rest && i + 1 <= to) rest = (lines[i + 1] ?? '').trim();
      return rest || undefined;
    }
    return undefined; // first statement is not a docstring
  }
  return undefined;
}

function shorten(s: string, n: number): string {
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ---------------------------------------------------------------------------------------------
// Python block scanner

interface Block {
  start: number; // 0-based line index (first decorator)
  headerEnd: number; // index of the line that ends the signature (':')
  end: number; // inclusive, last non-blank line
  type: 'def' | 'class' | 'other';
  name?: string;
}

/** Find blocks at a given indentation between [from, to] (0-based, inclusive). */
function scanPythonBlocks(lines: string[], from: number, to: number, indent: number): Block[] {
  const blocks: Block[] = [];
  let i = from;
  let otherStart = -1;
  const flushOther = (endExcl: number) => {
    if (otherStart < 0) return;
    let e = endExcl - 1;
    while (e >= otherStart && !lines[e].trim()) e--;
    let s = otherStart;
    while (s <= e && !lines[s].trim()) s++;
    if (e >= s) blocks.push({ start: s, headerEnd: s, end: e, type: 'other' });
    otherStart = -1;
  };
  while (i <= to) {
    const line = lines[i];
    const t = line.trim();
    const ind = indentOf(line);
    const isHead = ind === indent && (/^(async\s+def|def|class)\s+[A-Za-z_]/.test(t) || t.startsWith('@'));
    if (!isHead) {
      if (otherStart < 0 && t) otherStart = i;
      // skip over multi-line strings / brackets in "other" code so their inner lines don't look like heads
      i = skipStatement(lines, i, to);
      continue;
    }
    flushOther(i);
    const start = i;
    // decorators
    while (i <= to && lines[i].trim().startsWith('@') && indentOf(lines[i]) === indent) i = skipStatement(lines, i, to);
    const headLine = (lines[i] ?? '').trim();
    const hm = headLine.match(/^(?:async\s+)?(def|class)\s+([A-Za-z_][A-Za-z0-9_]*)/);
    if (!hm) {
      // decorator not followed by def/class: treat as other
      if (otherStart < 0) otherStart = start;
      continue;
    }
    const headerEnd = skipStatement(lines, i, to) - 1;
    let j = headerEnd + 1;
    let lastBody = headerEnd;
    let inStr: string | null = null;
    while (j <= to) {
      const l = lines[j];
      const lt = l.trim();
      if (inStr) {
        if (countUnescaped(l, inStr) % 2 === 1) inStr = null;
        lastBody = j;
        j++;
        continue;
      }
      if (lt && indentOf(l) <= indent && !lt.startsWith('#')) break;
      if (lt) {
        lastBody = j;
        for (const q of ['"""', "'''"]) if (countUnescaped(l, q) % 2 === 1) { inStr = q; break; }
      }
      j++;
    }
    blocks.push({ start, headerEnd, end: lastBody, type: hm[1] === 'class' ? 'class' : 'def', name: hm[2] });
    i = lastBody + 1;
  }
  flushOther(to + 1);
  return blocks;
}

function countUnescaped(line: string, q: string): number {
  let n = 0;
  let idx = line.indexOf(q);
  while (idx >= 0) {
    n++;
    idx = line.indexOf(q, idx + q.length);
  }
  return n;
}

/** Return index after the logical statement starting at i (handles brackets and triple quotes). */
function skipStatement(lines: string[], i: number, to: number): number {
  let depth = 0;
  let inStr: string | null = null;
  let j = i;
  while (j <= to) {
    const l = lines[j];
    let k = 0;
    while (k < l.length) {
      if (inStr) {
        const e = l.indexOf(inStr, k);
        if (e < 0) { k = l.length; break; }
        k = e + inStr.length;
        inStr = null;
        continue;
      }
      const c = l[k];
      if (c === '#') break;
      if ((c === '"' || c === "'") && l.startsWith(c.repeat(3), k)) { inStr = c.repeat(3); k += 3; continue; }
      if (c === '"' || c === "'") {
        // single-line string literal
        let e = k + 1;
        while (e < l.length && l[e] !== c) e += l[e] === '\\' ? 2 : 1;
        k = e + 1;
        continue;
      }
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth = Math.max(0, depth - 1);
      k++;
    }
    j++;
    if (!inStr && depth === 0 && !l.trimEnd().endsWith('\\')) break;
  }
  return j;
}

// ---------------------------------------------------------------------------------------------
// The engine

export class ContextEngine {
  readonly root: string;
  private fileMap = new Map<string, FileInfo>();
  private chunks: Chunk[] = [];
  private postings = new Map<string, { id: number; tf: number }[]>();
  private df = new Map<string, number>();
  private avgLen = 1;
  private syms: SymbolEntry[] = [];
  private symByName = new Map<string, SymbolEntry[]>();
  private allPaths: string[] = [];
  private moduleToPath = new Map<string, string>();
  private indexed = false;
  private indexing: Promise<void> | null = null;
  lastIndexMs = 0;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  // ------------------------------------------------------------------ indexing

  index(): Promise<void> {
    if (!this.indexing) {
      this.indexing = Promise.resolve().then(() => {
        const t0 = Date.now();
        this.buildIndex();
        this.lastIndexMs = Date.now() - t0;
        this.indexed = true;
      }).finally(() => { this.indexing = null; });
    }
    return this.indexing;
  }

  private buildIndex(): void {
    this.fileMap.clear();
    this.chunks = [];
    this.syms = [];
    this.symByName.clear();
    this.allPaths = [];
    this.moduleToPath.clear();
    const walk = (dirAbs: string) => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dirAbs, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dirAbs, e.name);
        if (e.isDirectory()) {
          if (SKIP_DIRS.has(e.name) || e.name.endsWith('.egg-info')) continue;
          walk(abs);
        } else if (e.isFile()) {
          const rel = toPosix(path.relative(this.root, abs));
          this.allPaths.push(rel);
          this.loadFile(rel, abs);
        }
      }
    };
    walk(this.root);
    this.allPaths.sort();
    this.finishIndex();
  }

  private loadFile(rel: string, abs: string, content?: string): void {
    const ext = path.extname(rel).toLowerCase();
    if (BINARY_EXT.has(ext) || /\.min\.(js|css)$/.test(rel)) return;
    let text = content;
    if (text === undefined) {
      try {
        const st = fs.statSync(abs);
        if (st.size > MAX_FILE_BYTES) return;
        const buf = fs.readFileSync(abs);
        if (buf.subarray(0, 8192).includes(0)) return;
        text = buf.toString('utf8');
      } catch { return; }
    }
    this.addFile(rel, text);
  }

  private addFile(rel: string, text: string): void {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const lang = langOf(rel);
    const lower = rel.toLowerCase();
    const base = path.posix.basename(lower);
    const info: FileInfo = {
      path: rel, lang, lines, chunks: [],
      pathTokens: new Set(tokenize(rel.replace(/\.[a-z0-9]+$/i, ''))),
      isTest: /(^|\/)tests?\//.test(lower) || /^test_|_test\.py$/.test(base) || base === 'conftest.py',
      isDoc: lang === 'rst' || lang === 'md',
      imports: new Set(), importedBy: new Set(),
    };
    this.fileMap.set(rel, info);
    if (lang === 'python') {
      info.module = this.moduleName(rel);
      if (info.module) this.moduleToPath.set(info.module, rel);
      this.chunkPython(info);
    } else if (lang === 'rst' || lang === 'md') {
      this.chunkDoc(info);
    } else {
      this.chunkWindows(info, 0, lines.length - 1, 'window');
    }
  }

  private moduleName(rel: string): string | undefined {
    let p = rel.replace(/\.pyi?$/, '');
    if (p.startsWith('src/')) p = p.slice(4);
    p = p.replace(/\/__init__$/, '');
    if (!p || /[^A-Za-z0-9_/]/.test(p)) return undefined;
    return p.split('/').join('.');
  }

  private newChunk(info: FileInfo, s: number, e: number, kind: ChunkKind, extra: Partial<Chunk> = {}): Chunk {
    const text = info.lines.slice(s, e + 1).join('\n');
    const toks = tokenize(text);
    // section titles / symbol names also count as content once more (they are strong signals)
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    const nameTokens = new Set<string>();
    if (extra.name) for (const t of tokenize(extra.name)) nameTokens.add(t);
    const c: Chunk = {
      id: this.chunks.length, path: info.path, startLine: s + 1, endLine: e + 1, kind,
      headerLines: 1, len: toks.length || 1, tf, nameTokens, ...extra,
    };
    this.chunks.push(c);
    info.chunks.push(c.id);
    return c;
  }

  private chunkWindows(info: FileInfo, from: number, to: number, kind: ChunkKind, name?: string, size = 60): void {
    for (let s = from; s <= to; s += size) {
      const e = Math.min(to, s + size - 1);
      if (!info.lines.slice(s, e + 1).some((l) => l.trim())) continue;
      const part = from === s ? name : name ? `${name} (cont.)` : undefined;
      this.newChunk(info, s, e, kind, { name: part, doc: name ? undefined : shorten(info.lines.slice(s, e + 1).find((l) => l.trim()) ?? '', 70) });
    }
  }

  private chunkPython(info: FileInfo): void {
    const { lines } = info;
    const top = scanPythonBlocks(lines, 0, lines.length - 1, 0);
    let pendingOther: Block[] = [];
    const flushOther = () => {
      if (!pendingOther.length) return;
      // merge consecutive "other" blocks into ~60-line module chunks
      let s = pendingOther[0].start;
      let e = pendingOther[0].end;
      const emit = (a: number, b: number) => {
        const assigns: string[] = [];
        for (let k = a; k <= b; k++) {
          const m = lines[k].match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=(?!=)/);
          if (m) assigns.push(m[1]);
        }
        this.newChunk(info, a, b, 'module', { assigns, doc: a === 0 ? firstDocLine(lines, 0, b) : undefined });
      };
      for (const b of pendingOther.slice(1)) {
        if (b.end - s > 60) { emit(s, e); s = b.start; }
        e = b.end;
      }
      emit(s, e);
      pendingOther = [];
    };
    for (const b of top) {
      if (b.type === 'other') { pendingOther.push(b); continue; }
      flushOther();
      this.pythonBlock(info, b, undefined);
    }
    flushOther();
    // module-level assignments -> symbols
    for (let k = 0; k < lines.length; k++) {
      const m = lines[k].match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=(?!=)/);
      if (m && m[1] !== '__all__') this.addSymbol({ name: m[1], path: info.path, line: k + 1, kind: 'variable', signature: shorten(lines[k], 120) });
    }
    // imports
    for (let k = 0; k < lines.length; k++) {
      const l = lines[k];
      let m = l.match(/^\s*from\s+(\.*)([A-Za-z0-9_.]*)\s+import\s+(.+)$/);
      if (m) {
        const base = this.resolveRelative(info, m[1], m[2]);
        if (base) {
          let names = m[3];
          if (names.includes('(') && !names.includes(')')) {
            let j = k + 1;
            while (j < lines.length && !lines[j].includes(')')) names += ' ' + lines[j++];
            names += ' ' + (lines[j] ?? '');
          }
          (info as any)._rawImports ??= [];
          (info as any)._rawImports.push(base);
          for (const n of names.replace(/[()]/g, ' ').split(',')) {
            const nm = n.trim().split(/\s+/)[0];
            if (nm && /^[A-Za-z_]\w*$/.test(nm)) (info as any)._rawImports.push(`${base}.${nm}`);
          }
        }
        continue;
      }
      m = l.match(/^\s*import\s+(.+)$/);
      if (m) {
        (info as any)._rawImports ??= [];
        for (const n of m[1].split(',')) {
          const nm = n.trim().split(/\s+/)[0];
          if (nm) (info as any)._rawImports.push(nm);
        }
      }
    }
  }

  private resolveRelative(info: FileInfo, dots: string, mod: string): string | undefined {
    if (!dots) return mod || undefined;
    const own = info.module ?? '';
    const isPkg = info.path.endsWith('__init__.py');
    const parts = own.split('.');
    const up = isPkg ? dots.length - 1 : dots.length;
    const basePkg = parts.slice(0, Math.max(0, parts.length - up));
    const full = [...basePkg, ...(mod ? mod.split('.') : [])].filter(Boolean).join('.');
    return full || undefined;
  }

  private pythonBlock(info: FileInfo, b: Block, cls: string | undefined): void {
    const { lines } = info;
    const name = cls ? `${cls}.${b.name}` : b.name!;
    const headerLines = b.headerEnd - b.start + 1;
    const doc = firstDocLine(lines, b.headerEnd + 1, Math.min(b.end, b.headerEnd + 4));
    const kind: ChunkKind = b.type === 'class' ? 'class' : cls ? 'method' : 'function';
    const sig = shorten(lines.slice(lines.slice(b.start, b.headerEnd + 1).findIndex((l) => /^\s*(async\s+def|def|class)\s/.test(l)) + b.start, b.headerEnd + 1).join(' '), 160);
    const defLine = b.start + Math.max(0, lines.slice(b.start, b.headerEnd + 1).findIndex((l) => /^\s*(async\s+def|def|class)\s/.test(l)));
    this.addSymbol({ name, path: info.path, line: defLine + 1, kind, signature: sig });
    const size = b.end - b.start + 1;
    if (b.type === 'class' && size > 70) {
      // split: class header (+ class-level attrs) and one chunk per method
      const bodyFirst = lines.slice(b.headerEnd + 1, b.end + 1).findIndex((l) => l.trim() && !l.trim().startsWith('#'));
      if (bodyFirst >= 0) {
        const bodyIndent = indentOf(lines[b.headerEnd + 1 + bodyFirst]);
        const inner = scanPythonBlocks(lines, b.headerEnd + 1, b.end, bodyIndent);
        const firstMethod = inner.find((x) => x.type !== 'other');
        const headEnd = firstMethod ? firstMethod.start - 1 : b.end;
        let he = headEnd;
        while (he > b.start && !lines[he].trim()) he--;
        this.newChunk(info, b.start, Math.min(he, b.start + 80), 'class', { name, doc, headerLines });
        for (const x of inner) {
          if (x.start <= headEnd) continue;
          if (x.type === 'other') { this.chunkWindows(info, x.start, x.end, 'module', `${name} body`, 60); continue; }
          this.pythonBlock(info, x, name);
        }
        return;
      }
    }
    if (size > 150) {
      // very long function: header window + continuation windows
      this.newChunk(info, b.start, b.start + 79, kind, { name, doc, headerLines });
      for (let s = b.start + 80; s <= b.end; s += 70) {
        this.newChunk(info, s, Math.min(b.end, s + 69), kind, { name: `${name} (cont.)`, headerLines: 0 });
      }
      return;
    }
    this.newChunk(info, b.start, b.end, kind, { name, doc, headerLines });
  }

  private chunkDoc(info: FileInfo): void {
    const { lines } = info;
    const heads: { line: number; title: string }[] = [];
    if (info.lang === 'md') {
      let fence = false;
      lines.forEach((l, i) => {
        if (/^\s*(```|~~~)/.test(l)) fence = !fence;
        const m = !fence && l.match(/^#{1,6}\s+(.+)$/);
        if (m) heads.push({ line: i, title: m[1].trim() });
      });
    } else {
      for (let i = 1; i < lines.length; i++) {
        const u = lines[i];
        const t = lines[i - 1];
        if (/^([=\-~^*#+"'`:.])\1{2,}\s*$/.test(u) && t.trim() && !/^([=\-~^*#+"'`:.])\1{2,}\s*$/.test(t) && u.trim().length >= Math.min(t.trim().length, 3) && indentOf(t) === 0) {
          const start = i >= 2 && /^([=\-~^*#+])\1{2,}\s*$/.test(lines[i - 2]) ? i - 2 : i - 1;
          heads.push({ line: start, title: t.trim() });
        }
      }
    }
    if (!heads.length || heads[0].line > 0) heads.unshift({ line: 0, title: heads.length ? '' : path.posix.basename(info.path) });
    for (let h = 0; h < heads.length; h++) {
      const s = heads[h].line;
      let e = (h + 1 < heads.length ? heads[h + 1].line : lines.length) - 1;
      while (e > s && !lines[e].trim()) e--;
      if (e < s || !lines.slice(s, e + 1).some((l) => l.trim())) continue;
      const title = heads[h].title || '(preamble)';
      const prose = lines.slice(s + 2, e + 1).find((l) => l.trim() && !/^[=\-~^*#.]{3,}/.test(l) && !l.trim().startsWith('..'));
      if (e - s + 1 > 80) this.chunkWindows(info, s, e, 'section', title, 60);
      else this.newChunk(info, s, e, 'section', { name: title, doc: prose ? shorten(prose, 90) : undefined });
    }
  }

  private addSymbol(s: SymbolEntry): void {
    this.syms.push(s);
    const keys = new Set([s.name.toLowerCase(), s.name.split('.').pop()!.toLowerCase()]);
    for (const k of keys) {
      const arr = this.symByName.get(k) ?? [];
      arr.push(s);
      this.symByName.set(k, arr);
    }
  }

  private finishIndex(): void {
    // postings / df
    this.postings.clear();
    this.df.clear();
    let total = 0;
    for (const c of this.chunks) {
      total += c.len;
      for (const [t, n] of c.tf) {
        let p = this.postings.get(t);
        if (!p) { p = []; this.postings.set(t, p); }
        p.push({ id: c.id, tf: n });
      }
    }
    for (const [t, p] of this.postings) this.df.set(t, p.length);
    this.avgLen = this.chunks.length ? total / this.chunks.length : 1;
    // import graph
    for (const f of this.fileMap.values()) { f.imports.clear(); f.importedBy.clear(); }
    for (const f of this.fileMap.values()) {
      const raw: string[] | undefined = (f as any)._rawImports;
      if (!raw) continue;
      for (const mod of raw) {
        const target = this.moduleToPath.get(mod);
        if (target && target !== f.path) {
          f.imports.add(target);
          this.fileMap.get(target)!.importedBy.add(f.path);
        }
      }
    }
  }

  /** Re-index one file after an edit (content defaults to disk). Cheap enough to rebuild postings. */
  refresh(relPath: string, content?: string): void {
    const rel = toPosix(relPath);
    const old = this.fileMap.get(rel);
    if (old) {
      const dead = new Set(old.chunks);
      this.chunks = this.chunks.filter((c) => !dead.has(c.id));
      this.chunks.forEach((c, i) => (c.id = i));
      for (const f of this.fileMap.values()) f.chunks = [];
      for (const c of this.chunks) this.fileMap.get(c.path)?.chunks.push(c.id);
      this.syms = this.syms.filter((s) => s.path !== rel);
      this.symByName.clear();
      const keep = this.syms;
      this.syms = [];
      for (const s of keep) this.addSymbol(s);
      this.fileMap.delete(rel);
    }
    if (!this.allPaths.includes(rel)) { this.allPaths.push(rel); this.allPaths.sort(); }
    this.loadFile(rel, path.join(this.root, rel), content);
    this.finishIndex();
  }

  // ------------------------------------------------------------------ lookup APIs

  stats(): { files: number; chunks: number; symbols: number; indexMs: number } {
    return { files: this.fileMap.size, chunks: this.chunks.length, symbols: this.syms.length, indexMs: this.lastIndexMs };
  }

  /** All workspace files (relative, posix) that passed the directory filters, including non-indexed ones. */
  listAllFiles(): string[] {
    return this.allPaths;
  }

  isIndexed(rel: string): boolean {
    return this.fileMap.has(toPosix(rel));
  }

  findSymbol(name: string): SymbolEntry[] {
    const k = name.trim().toLowerCase();
    const hits = this.symByName.get(k) ?? [];
    return [...hits].sort((a, b) => this.symRank(a) - this.symRank(b));
  }

  private symRank(s: SymbolEntry): number {
    const f = this.fileMap.get(s.path);
    return (f?.isTest ? 2 : 0) + (s.path.startsWith('examples/') ? 1 : 0) + (s.kind === 'variable' ? 0.5 : 0);
  }

  symbols(prefix: string, limit = 20): { name: string; path: string; line: number; kind: string }[] {
    const q = prefix.trim().toLowerCase();
    if (!q) return [];
    const scored: { s: SymbolEntry; r: number }[] = [];
    for (const s of this.syms) {
      const n = s.name.toLowerCase();
      const last = n.split('.').pop()!;
      let r: number;
      if (n === q || last === q) r = 0;
      else if (n.startsWith(q) || last.startsWith(q)) r = 1;
      else if (n.includes(q)) r = 2;
      else continue;
      if (s.name.split('.').pop()!.startsWith('_')) r += 0.3;
      r += this.symRank(s) * 0.2 + n.length / 1000;
      scored.push({ s, r });
    }
    scored.sort((a, b) => a.r - b.r);
    return scored.slice(0, limit).map(({ s }) => ({ name: s.name, path: s.path, line: s.line, kind: s.kind }));
  }

  files(prefix: string, limit = 20): string[] {
    const q = prefix.trim().toLowerCase().replace(/\\/g, '/');
    const scored: { p: string; r: number }[] = [];
    for (const p of this.allPaths) {
      const lp = p.toLowerCase();
      const base = path.posix.basename(lp);
      let r: number;
      if (!q) r = 3;
      else if (lp === q || base === q) r = 0;
      else if (lp.startsWith(q) || base.startsWith(q)) r = 1;
      else if (lp.includes(q)) r = 2;
      else continue;
      const f = this.fileMap.get(p);
      r += (f?.isTest ? 0.2 : 0) + (lp.startsWith('src/') ? -0.1 : 0) + lp.length / 1000;
      scored.push({ p, r });
    }
    scored.sort((a, b) => a.r - b.r);
    return scored.slice(0, limit).map((x) => x.p);
  }

  // ------------------------------------------------------------------ retrieval

  async retrieve(
    query: string,
    opts: { budgetTokens: number; mentions?: { files: string[]; symbols: string[] }; selection?: { path: string; startLine: number; endLine: number } },
  ): Promise<ContextPack> {
    if (!this.indexed) await this.index();
    const budget = Math.max(200, Math.floor(opts.budgetTokens || 4000));
    const t0 = Date.now();

    // ---- query analysis
    const terms = this.analyzeQuery(query);
    const qTokens = new Set(terms.keys());
    // selection-aware expansion: identifiers in the selected code become weak query terms
    if (opts.selection) {
      const sf = this.fileMap.get(toPosix(opts.selection.path));
      if (sf) {
        const selText = sf.lines.slice(Math.max(0, opts.selection.startLine - 1), opts.selection.endLine).join('\n');
        // the selection dominates: instruction words (generic: "treat", "update", "list") count less
        for (const [t, w] of terms) terms.set(t, w * 0.6);
        for (const t of tokenize(selText)) if (!STOP.has(t) && (terms.get(t) ?? 0) < 0.5) terms.set(t, 0.5);
      }
    }
    const docIntent = [...qTokens].some((t) => DOC_INTENT.has(t)) || /\bdocument/i.test(query);
    const testIntent = [...qTokens].some((t) => TEST_INTENT.has(t)) || /\btest/i.test(query);

    // mentions written inline in the query: @path or @symbol
    const mentionFiles = new Set((opts.mentions?.files ?? []).map((f) => toPosix(f).replace(/^\.\//, '')));
    const mentionSyms = new Set(opts.mentions?.symbols ?? []);
    for (const m of query.matchAll(/@([A-Za-z0-9_./-]+)/g)) {
      const v = m[1].replace(/[.,;:]+$/, '');
      if (this.fileMap.has(v)) mentionFiles.add(v);
      else if (this.symByName.has(v.toLowerCase())) mentionSyms.add(v);
    }
    // identifiers in the query that are known symbols get a strong boost (not pinned)
    const identBoost = new Set<string>();
    for (const m of query.matchAll(/`([^`]+)`|\b([A-Za-z_]+[a-z0-9]_[A-Za-z0-9_]+|[a-z]+[A-Z][A-Za-z0-9]+|[A-Z][a-z]+[A-Z][A-Za-z0-9]+)\b/g)) {
      const id = (m[1] ?? m[2]).trim();
      if (this.symByName.has(id.toLowerCase())) identBoost.add(id.toLowerCase());
    }

    // ---- score chunks (BM25 + boosts)
    const N = this.chunks.length || 1;
    const k1 = 1.2, b = 0.75;
    const scores = new Map<number, number>();
    const contrib = new Map<number, Map<string, number>>();
    for (const [t, w] of terms) {
      const post = this.postings.get(t);
      if (!post) continue;
      const df = this.df.get(t) ?? 0;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (const { id, tf } of post) {
        const c = this.chunks[id];
        const s = w * idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * c.len) / this.avgLen)));
        scores.set(id, (scores.get(id) ?? 0) + s);
        let cm = contrib.get(id);
        if (!cm) { cm = new Map(); contrib.set(id, cm); }
        cm.set(t, (cm.get(t) ?? 0) + s);
      }
    }
    const pathHits = new Map<number, string[]>();
    const nameHits = new Map<number, string[]>();
    for (const [id, base] of scores) {
      const c = this.chunks[id];
      const f = this.fileMap.get(c.path)!;
      let s = base;
      const ph: string[] = [];
      for (const t of f.pathTokens) if (terms.has(t)) { s += 1.2 * terms.get(t)!; ph.push(t); }
      const nh: string[] = [];
      for (const t of c.nameTokens) if (terms.has(t)) { s += 1.5 * terms.get(t)!; nh.push(t); }
      if (c.name && identBoost.has(c.name.toLowerCase().split('.').pop()!)) { s += 8; nh.push(c.name); }
      // primary retrieval favours source; tests and docs arrive mainly via the sibling expansion
      if (f.isDoc) s *= docIntent ? 0.7 : 0.5;
      if (f.isTest) s *= testIntent ? 0.85 : 0.7;
      if (c.path.startsWith('examples/')) s *= 0.6;
      if (c.path === 'CHANGES.rst' || /changelog|changes|history/i.test(c.path)) s *= 0.35;
      if (ph.length) pathHits.set(id, ph);
      if (nh.length) nameHits.set(id, nh);
      scores.set(id, s);
    }
    // hub boost: a chunk that references several top-matching definitions of its own file is where they are
    // wired together (e.g. FlaskGroup.__init__ calling add_command(run_command/shell_command/routes_command))
    const prelimAll = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const topPaths = [...new Set(prelimAll.slice(0, 40).map(([id]) => this.chunks[id].path))].slice(0, 6);
    const prelim = prelimAll.filter(([id, s]) => topPaths.includes(this.chunks[id].path) && s >= (prelimAll[0]?.[1] ?? 0) * 0.35);
    const defsByFile = new Map<string, Set<string>>();
    for (const [id] of prelim) {
      const c = this.chunks[id];
      if (!c.name || !(c.kind === 'function' || c.kind === 'class' || c.kind === 'method')) continue;
      const n = c.name.replace(/ \(cont\.\)$/, '').split('.').pop()!.toLowerCase();
      if (n.length < 4 || n.startsWith('_') || !n.includes('_')) continue;
      const set = defsByFile.get(c.path) ?? new Set();
      set.add(n);
      defsByFile.set(c.path, set);
    }
    const hubHits = new Map<number, string[]>();
    for (const [p, names] of defsByFile) {
      if (names.size < 2) continue;
      for (const id of this.fileMap.get(p)!.chunks) {
        const c = this.chunks[id];
        const own = c.name?.split('.').pop()!.toLowerCase();
        const hits = [...names].filter((n) => n !== own && c.tf.has(n));
        if (hits.length >= 2) {
          scores.set(id, (scores.get(id) ?? 0) + 2.5 * hits.length);
          hubHits.set(id, hits);
        }
      }
    }
    const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
    const topScore = ranked.length ? ranked[0][1] : 0;
    const cutoff = topScore * 0.3;

    // file-level scores
    const fileScore = new Map<string, number>();
    const perFile = new Map<string, number[]>();
    for (const [id, s] of ranked) {
      const p = this.chunks[id].path;
      const arr = perFile.get(p) ?? [];
      if (arr.length < 3) arr.push(s);
      perFile.set(p, arr);
    }
    for (const [p, arr] of perFile) fileScore.set(p, arr[0] + 0.5 * (arr[1] ?? 0) + 0.25 * (arr[2] ?? 0));

    const why = (id: number): string => {
      const c = this.chunks[id];
      const parts: string[] = [];
      parts.push(this.describeChunk(c));
      const cm = contrib.get(id);
      if (cm) {
        const top = [...cm.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t]) => t);
        parts.push(`BM25 ${(scores.get(id) ?? 0).toFixed(1)} on ${top.join(', ')}`);
      }
      const nh = nameHits.get(id);
      if (nh) parts.push(`name matches ${[...new Set(nh)].slice(0, 3).join(', ')}`);
      const ph = pathHits.get(id);
      if (ph) parts.push(`path matches ${[...new Set(ph)].join(', ')}`);
      const hh = hubHits.get(id);
      if (hh) parts.push(`wires up ${hh.slice(0, 4).map((h) => '`' + h + '`').join(', ')}`);
      return parts.join(' · ');
    };

    // ---- assemble candidates in priority order
    const cands: Candidate[] = [];
    const notes: string[] = [];
    const excluded: ContextPack['excluded'] = [];

    // 1. selection
    let selSymbol: string | undefined;
    if (opts.selection) {
      const sp = toPosix(opts.selection.path);
      const f = this.fileMap.get(sp);
      if (f) {
        const overl = f.chunks.map((i) => this.chunks[i]).filter((c) => c.startLine <= opts.selection!.endLine && c.endLine >= opts.selection!.startLine);
        for (const c of overl) {
          if (!selSymbol && c.name && (c.kind === 'function' || c.kind === 'method' || c.kind === 'class')) selSymbol = c.name.replace(/ \(cont\.\)$/, '');
          cands.push({ chunk: c, score: 1e6, source: 'selection',
            reason: `your selection (L${opts.selection.startLine}-L${opts.selection.endLine}) · ${this.describeChunk(c)}`, cap: Math.floor(budget * 0.45) });
        }
      } else excluded.push({ path: sp, reason: 'selection file not indexed', tokens: 0 });
    }
    const selKeys: string[] = [];
    for (const c of cands) {
      const f = this.fileMap.get(c.chunk.path)!;
      for (const m of f.lines.slice(c.chunk.startLine - 1, c.chunk.endLine).join(' ').matchAll(/[A-Z][A-Z0-9]*_[A-Z0-9_]+/g)) {
        const k = m[0].toLowerCase();
        if (!selKeys.includes(k) && this.postings.has(k)) selKeys.push(k);
      }
    }
    // 2. explicit mentions
    for (const mf of mentionFiles) {
      const f = this.fileMap.get(mf);
      if (!f) { excluded.push({ path: mf, reason: 'mentioned file not found or not indexable', tokens: 0 }); continue; }
      const whole = this.renderRange(f, 1, f.lines.length);
      const wt = estimateTokens(whole);
      if (wt <= budget * 0.4) {
        cands.push({ chunk: this.virtualChunk(f, 1, f.lines.length), score: 1e6 - 1, source: 'mention-file', reason: `you mentioned @${mf} (whole file, ${fmt(wt)} tok)` });
      } else {
        // best chunks of the file plus an outline of the rest
        const mine = f.chunks.map((i) => ({ id: i, s: scores.get(i) ?? 0 })).sort((a, b) => b.s - a.s).slice(0, 3);
        cands.push({ chunk: this.outlineChunk(f), score: 1e6 - 1, source: 'mention-file', reason: `you mentioned @${mf} — file outline (whole file is ${fmt(wt)} tok, too big for the budget)` });
        for (const { id } of mine) cands.push({ chunk: this.chunks[id], score: 1e6 - 2, source: 'mention-file', reason: `part of @${mf} most relevant to the request · ${why(id)}`, cap: Math.floor(budget * 0.25) });
      }
    }
    for (const ms of mentionSyms) {
      const defs = this.findSymbol(ms).slice(0, 2);
      if (!defs.length) { excluded.push({ path: ms, reason: `mentioned symbol @${ms} not found`, tokens: 0 }); continue; }
      for (const d of defs) {
        const c = this.chunkAt(d.path, d.line);
        if (!c) continue;
        if (!selSymbol && d.kind !== 'variable') selSymbol = d.name;
        cands.push({ chunk: c, score: 1e6 - 1, source: 'mention-symbol', reason: `you mentioned @${ms} · ${d.kind} defined at ${d.path}:${d.line}`, cap: Math.floor(budget * 0.4) });
      }
    }

    // 3. retrieval: best chunk of each top file first (diversity), then the rest by score
    const anchorFiles: string[] = [];
    const pinnedFiles = new Set(cands.map((c) => c.chunk.path));
    for (const p of pinnedFiles) { const f = this.fileMap.get(p); if (f && f.lang === 'python' && !f.isTest) anchorFiles.push(p); }
    const topFiles = [...fileScore.entries()].sort((a, b) => b[1] - a[1]);
    if (!anchorFiles.length) {
      const src = topFiles.filter(([p]) => {
        const f = this.fileMap.get(p)!;
        return !f.isTest && !f.isDoc && !p.startsWith('examples/') && f.lang === 'python';
      });
      if (src[0]) anchorFiles.push(src[0][0]);
      if (src[1] && src[1][1] >= src[0][1] * 0.6) anchorFiles.push(src[1][0]);
    }
    const firstPass = new Set<number>();
    const seenFiles = new Set<string>();
    // the anchor's best chunk always leads the retrieval section
    const anchorBest = anchorFiles.length && !pinnedFiles.has(anchorFiles[0]) ? this.bestChunks(anchorFiles[0], scores, 1)[0] : undefined;
    const firstOrder = anchorBest !== undefined ? [[anchorBest, scores.get(anchorBest) ?? 0] as [number, number], ...ranked] : ranked;
    for (const [id, s] of firstOrder) {
      if (s < cutoff || seenFiles.size >= 3) break;
      const p = this.chunks[id].path;
      if (seenFiles.has(p)) continue;
      seenFiles.add(p);
      firstPass.add(id);
      cands.push({ chunk: this.chunks[id], score: s, source: 'retrieval', reason: why(id), cap: Math.floor(budget * 0.22) });
    }

    // 4. structural expansion around anchors
    const testSib: string[] = [];
    const docSib: string[] = [];
    anchorFiles.forEach((anchor, ai) => {
      const af = this.fileMap.get(anchor)!;
      const t = this.testSibling(af);
      if (t && !testSib.includes(t.path)) {
        testSib.push(t.path);
        const best = this.bestChunks(t.path, scores, ai === 0 ? 2 : 1, selSymbol);
        best.forEach((id, i) => cands.push({ chunk: this.chunks[id], score: (scores.get(id) ?? 0) + (i === 0 ? 1e5 : 0), source: 'test-sibling',
          reason: `tests for ${path.posix.basename(anchor)} (${t.why})${testIntent ? '; the request asks for test coverage' : ''} · ${this.describeChunk(this.chunks[id])}${scores.has(id) ? ` · BM25 ${scores.get(id)!.toFixed(1)}` : ''}`,
          cap: Math.floor(budget * (ai === 0 ? 0.18 : 0.1)) }));
      }
      const d = this.docsSibling(af, selSymbol, selKeys);
      if (d && !docSib.includes(d.path)) {
        docSib.push(d.path);
        const best = this.bestChunks(d.path, scores, docIntent && ai === 0 ? 2 : 1, selSymbol, selKeys);
        best.forEach((id, i) => cands.push({ chunk: this.chunks[id], score: (scores.get(id) ?? 0) + (i === 0 ? 1e5 : 0), source: 'docs-sibling',
          reason: `docs for ${path.posix.basename(anchor)} (${d.why})${docIntent ? '; the request asks for documentation' : ''} · ${this.describeChunk(this.chunks[id])}${scores.has(id) ? ` · BM25 ${scores.get(id)!.toFixed(1)}` : ''}`,
          cap: Math.floor(budget * (ai === 0 ? 0.15 : 0.1)) }));
      }
    });
    // callers of the selected / mentioned symbol
    if (selSymbol) {
      const ident = selSymbol.split('.').pop()!.toLowerCase();
      const callers = (this.postings.get(ident) ?? [])
        .map(({ id }) => this.chunks[id])
        .filter((c) => c.kind !== 'module' && !c.name?.toLowerCase().endsWith(ident) && !this.fileMap.get(c.path)!.isDoc && !c.path.startsWith('examples/'))
        .sort((a, b) => Number(this.fileMap.get(a.path)!.isTest) - Number(this.fileMap.get(b.path)!.isTest) || (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0))
        .slice(0, 3);
      for (const c of callers) {
        const isT = this.fileMap.get(c.path)!.isTest;
        cands.push({ chunk: c, score: 5e4 + (scores.get(c.id) ?? 0), source: isT ? 'test-sibling' : 'graph-neighbor',
          reason: `${isT ? 'test that exercises' : 'calls'} \`${selSymbol}\` · ${this.describeChunk(c)}`, cap: Math.floor(budget * 0.15), forceOutline: !isT && this.chunkTokens(c) > budget * 0.12 });
      }
    }
    // remaining retrieval chunks
    const anchorSet = new Set(anchorFiles);
    const rest = ranked.slice(0, 60).map(([id, s]) => [id, anchorSet.has(this.chunks[id].path) ? s * 1.25 : s] as [number, number]).sort((a, b) => b[1] - a[1]);
    for (const [id, s] of rest) {
      if (firstPass.has(id)) continue;
      if (s < cutoff) { if (excluded.length < 14) excluded.push({ path: `${this.chunks[id].path}:L${this.chunks[id].startLine}-L${this.chunks[id].endLine}`, reason: `score below cutoff (${s.toFixed(1)} < ${cutoff.toFixed(1)})`, tokens: this.chunkTokens(this.chunks[id]) }); continue; }
      cands.push({ chunk: this.chunks[id], score: s, source: 'retrieval', reason: anchorSet.has(this.chunks[id].path) ? `${why(id)} · same file as the top match` : why(id), cap: Math.floor(budget * 0.3) });
    }
    // import neighbours of the top anchor: outline only, cheap orientation
    for (const anchor of anchorFiles.slice(0, 1)) {
      const af = this.fileMap.get(anchor)!;
      const neigh = [...af.imports, ...af.importedBy]
        .filter((p) => !this.fileMap.get(p)!.isTest && p !== anchor)
        .map((p) => ({ p, s: fileScore.get(p) ?? 0, dir: af.imports.has(p) ? 'imported by' : 'imports' }))
        .sort((a, b) => b.s - a.s)
        .slice(0, 2);
      for (const n of neigh) {
        if (n.s <= 0) continue;
        const best = this.bestChunks(n.p, scores, 1);
        if (!best.length) continue;
        cands.push({ chunk: this.chunks[best[0]], score: n.s * 0.5, source: 'graph-neighbor',
          reason: `${n.dir} ${path.posix.basename(anchor)} (import graph) · ${this.describeChunk(this.chunks[best[0]])}`, forceOutline: true });
      }
    }

    // ---- greedy packing
    const header0 = `Context pack · budget ${fmt(budget)} tok`;
    let used = estimateTokens(header0) + 40;
    const items: ContextItem[] = [];
    const taken = new Set<string>();
    const rangesByFile = new Map<string, [number, number][]>();
    const overlaps = (p: string, s: number, e: number) => (rangesByFile.get(p) ?? []).some(([a, b]) => s <= b && e >= a);
    const blocks: { item: ContextItem; body: string }[] = [];
    for (const cand of cands) {
      const c = cand.chunk;
      const key = `${c.path}:${c.startLine}-${c.endLine}`;
      if (taken.has(key) || overlaps(c.path, c.startLine, c.endLine)) continue;
      const f = this.fileMap.get(c.path)!;
      const full = (c as any)._virtual ?? this.renderRange(f, c.startLine, c.endLine);
      const fullTok = estimateTokens(full) + estimateTokens(cand.reason) + 12;
      const room = budget - used;
      const cap = Math.min(room, cand.cap ?? room);
      let body = full;
      let tok = fullTok;
      let reason = cand.reason;
      let endLine = c.endLine;
      if (cand.forceOutline || fullTok > cap) {
        const ol = this.outlineOf(f, c);
        const olTok = ol ? estimateTokens(ol) + estimateTokens(cand.reason) + 24 : Infinity;
        if (ol && olTok <= room) {
          body = ol;
          tok = olTok;
          reason = `${cand.reason} · outline only (full chunk ${fmt(fullTok)} tok${cand.forceOutline ? ', neighbour' : fullTok > room ? ' > remaining budget' : ' > per-item cap'}; read_file L${c.startLine}-L${c.endLine} for the body)`;
        } else if (!ol && cap >= 120 && fullTok > cap) {
          // prose / test: keep the head that fits
          const maxChars = (cap - estimateTokens(cand.reason) - 30) * 4;
          const lines = full.split('\n');
          let acc = 0, n = 0;
          while (n < lines.length && acc + lines[n].length + 1 <= maxChars) { acc += lines[n].length + 1; n++; }
          if (n >= 6) {
            body = lines.slice(0, n).join('\n');
            endLine = c.startLine + n - 1;
            tok = estimateTokens(body) + estimateTokens(cand.reason) + 30;
            reason = `${cand.reason} · truncated to L${c.startLine}-L${endLine} (full ${fmt(fullTok)} tok)`;
          } else {
            excluded.push({ path: key, reason: `over budget: ${fmt(fullTok)} tok (${fmt(room)} left)`, tokens: fullTok });
            continue;
          }
        } else if (fullTok > room) {
          excluded.push({ path: key, reason: `over budget: ${fmt(fullTok)} tok (${fmt(room)} left)`, tokens: fullTok });
          continue;
        }
      }
      if (tok > room) { excluded.push({ path: key, reason: `over budget: ${fmt(tok)} tok (${fmt(room)} left)`, tokens: tok }); continue; }
      used += tok;
      taken.add(key);
      const rs = rangesByFile.get(c.path) ?? [];
      rs.push([c.startLine, endLine]);
      rangesByFile.set(c.path, rs);
      const item: ContextItem = { path: c.path, startLine: c.startLine, endLine, tokens: tok, score: Math.round(Math.min(cand.score, 999) * 10) / 10, reason, source: cand.source };
      items.push(item);
      blocks.push({ item, body });
      if (budget - used < 60) break;
    }
    // anything not packed (budget ran out) is reported, so the user sees what was left behind and why
    for (const cand of cands) {
      const c = cand.chunk;
      const key = `${c.path}:${c.startLine}-${c.endLine}`;
      if (taken.has(key) || overlaps(c.path, c.startLine, c.endLine) || excluded.some((e) => e.path === key)) continue;
      const tk = estimateTokens((c as any)._virtual ?? this.renderRange(this.fileMap.get(c.path)!, c.startLine, c.endLine));
      excluded.push({ path: key, reason: `over budget: ${fmt(tk)} tok (${fmt(Math.max(0, budget - used))} left)`, tokens: tk });
    }
    excluded.sort((a, b) => Number(/cutoff/.test(a.reason)) - Number(/cutoff/.test(b.reason)));
    // trim excluded to the most informative entries
    const seenEx = new Set<string>();
    const ex = excluded.filter((e) => (seenEx.has(e.path) ? false : (seenEx.add(e.path), true))).slice(0, 20);

    // ---- render
    const filesIn = [...new Set(items.map((i) => i.path))];
    const ms = Date.now() - t0;
    const head = [
      `## Context pack — ${fmt(used)} / ${fmt(budget)} tokens · ${items.length} items from ${filesIn.length} files · ${ms} ms`,
      `Strategy: pinned (selection, @mentions) → BM25 over code-aware chunks with synonyms + path/symbol boosts → test/docs/import siblings of ${anchorFiles.map((a) => '`' + a + '`').join(', ') || 'the top files'} → greedy pack (outline before drop).`,
      ...(notes.length ? notes : []),
      '',
    ].join('\n');
    // group rendering by file (order of first appearance), lines ascending
    const order = new Map<string, number>();
    blocks.forEach((b2, i) => { if (!order.has(b2.item.path)) order.set(b2.item.path, i); });
    const sorted = [...blocks].sort((a, b2) => order.get(a.item.path)! - order.get(b2.item.path)! || a.item.startLine - b2.item.startLine);
    const body = sorted.map(({ item, body: bd }) => `### ${item.path}:L${item.startLine}-L${item.endLine} — ${item.reason}\n\`\`\`${fenceLang(item.path)}\n${bd}\n\`\`\``).join('\n\n');
    const rendered = `${head}\n${body}${ex.length ? `\n\nNot included: ${ex.slice(0, 8).map((e) => `${e.path} (${e.reason})`).join('; ')}` : ''}\n`;
    return { query, budgetTokens: budget, usedTokens: used, items, excluded: ex, rendered };
  }

  // ------------------------------------------------------------------ retrieval helpers

  private analyzeQuery(query: string): Map<string, number> {
    const terms = new Map<string, number>();
    const add = (t: string, w: number) => { if (t.length >= 2 && !STOP.has(t)) terms.set(t, Math.max(terms.get(t) ?? 0, w)); };
    const qtf = new Map<string, number>();
    for (const t of tokenize(query)) qtf.set(t, (qtf.get(t) ?? 0) + 1);
    for (const [t, n] of qtf) add(t, Math.min(2, 1 + 0.5 * (n - 1)));
    // quoted words and backticked identifiers weigh more
    for (const m of query.matchAll(/["'`“”‘’]([^"'`“”‘’]{1,60})["'`“”‘’]/g)) {
      for (const t of tokenize(m[1])) add(t, 1.6);
    }
    for (const m of query.matchAll(/\b[A-Za-z_]*[a-z0-9]_[A-Za-z0-9_]+\b|\b[a-z]+[A-Z][A-Za-z0-9]+\b/g)) add(m[0].toLowerCase(), 2.2);
    // ALL-CAPS words (env vars, constants) are strong literal hints
    for (const m of query.matchAll(/\b[A-Z][A-Z0-9_]{2,}\b/g)) { const id = m[0].toLowerCase(); if (id.includes('_')) add(id, 1.6); for (const t of tokenize(m[0])) if ((terms.get(t) ?? 0) > 1) terms.set(t, 1); }
    // synonyms
    for (const [t, w] of [...terms]) for (const s of SYNONYMS[t] ?? []) add(stem(s), Math.min(w, 1) * 0.45);
    // intent words are signals for siblings, not content terms
    for (const t of ['document', 'doc', 'docs', 'documentation', 'cover', 'covered']) if (terms.has(t)) terms.set(t, 0.2);
    return terms;
  }

  private describeChunk(c: Chunk): string {
    if (c.kind === 'section') return `section “${c.name ?? ''}”${c.doc ? ` — ${shorten(c.doc, 70)}` : ''}`;
    if (c.kind === 'module') {
      const a = (c.assigns ?? []).slice(0, 3);
      return a.length ? `module-level code (\`${a.join('`, `')}\`${(c.assigns!.length > 3 ? ', …' : '')})` : c.name ? `${c.name}` : 'module-level code (imports/setup)';
    }
    if (c.kind === 'window') return c.name ? `${c.name}` : `lines ${c.startLine}-${c.endLine}${c.doc ? ` (“${shorten(c.doc, 50)}”)` : ''}`;
    const what = c.kind === 'class' ? 'class' : c.kind === 'method' ? 'method' : 'function';
    return `defines ${what} \`${c.name}\`${c.doc ? ` (“${shorten(c.doc, 70)}”)` : ''}`;
  }

  private chunkTokens(c: Chunk): number {
    const f = this.fileMap.get(c.path);
    return f ? estimateTokens(this.renderRange(f, c.startLine, c.endLine)) : 0;
  }

  private chunkAt(p: string, line: number): Chunk | undefined {
    const f = this.fileMap.get(p);
    if (!f) return undefined;
    let best: Chunk | undefined;
    for (const id of f.chunks) {
      const c = this.chunks[id];
      if (c.startLine <= line && c.endLine >= line && (!best || c.endLine - c.startLine < best.endLine - best.startLine)) best = c;
    }
    return best;
  }

  private bestChunks(p: string, scores: Map<number, number>, n: number, mustMention?: string, keys: string[] = []): number[] {
    const f = this.fileMap.get(p);
    if (!f) return [];
    const ident = mustMention?.split('.').pop()!.toLowerCase();
    const ranked = f.chunks
      .map((id) => {
        const c = this.chunks[id];
        let s = scores.get(id) ?? 0;
        const importsOnly = c.kind === 'module' && c.startLine === 1;
        if (ident && c.tf.has(ident) && !importsOnly) s += 20 + (c.name?.toLowerCase().includes(ident) ? 10 : 0);
        for (const k of keys) if (c.tf.has(k)) s += 15;
        if (c.kind === 'module' && c.startLine === 1) s -= 0.5; // imports are rarely the interesting part
        return { id, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s);
    return ranked.slice(0, n).map((x) => x.id);
  }

  private testSibling(af: FileInfo): { path: string; why: string } | undefined {
    const stemName = path.posix.basename(af.path).replace(/\.pyi?$/, '');
    const isInit = stemName === '__init__';
    const pkgName = isInit ? path.posix.basename(path.posix.dirname(af.path)) : stemName;
    const candidates = [...this.fileMap.values()].filter((f) => f.isTest && f.lang === 'python');
    const named = candidates.filter((f) => {
      const b = path.posix.basename(f.path);
      return b === `test_${pkgName}.py` || b === `${pkgName}_test.py` || b.startsWith(`test_${pkgName}_`);
    }).sort((a, b) => a.path.length - b.path.length);
    if (named.length) return { path: named[0].path, why: `named test_${pkgName}.py` };
    const importers = candidates.filter((f) => f.imports.has(af.path));
    if (importers.length) {
      importers.sort((a, b) => b.lines.length - a.lines.length);
      return { path: importers[0].path, why: `imports ${af.module ?? af.path}` };
    }
    return undefined;
  }

  private docsSibling(af: FileInfo, selSymbol?: string, keys: string[] = []): { path: string; why: string } | undefined {
    const stemName = path.posix.basename(af.path).replace(/\.pyi?$/, '');
    const mod = af.module ?? '';
    const topSyms = this.syms.filter((s) => s.path === af.path && s.kind !== 'variable' && !s.name.includes('.') && !s.name.startsWith('_')).map((s) => s.name.toLowerCase());
    if (selSymbol) topSyms.unshift(selSymbol.split('.').pop()!.toLowerCase());
    const uniqSyms = [...new Set(topSyms)];
    let best: { path: string; s: number; why: string } | undefined;
    for (const f of this.fileMap.values()) {
      if (!f.isDoc || /changes|changelog|history|license/i.test(f.path)) continue;
      const base = path.posix.basename(f.path).replace(/\.(rst|md)$/, '').toLowerCase();
      let s = 0;
      const why: string[] = [];
      if (base === stemName.toLowerCase()) { s += 6; why.push(`filename ${path.posix.basename(f.path)}`); }
      const text = f.lines.join('\n');
      if (mod && text.includes(mod)) { s += 2; why.push(`mentions ${mod}`); }
      const hit: string[] = [];
      let generic = 0;
      for (const n of uniqSyms.slice(0, 40)) {
        const post = this.postings.get(n);
        if (post && post.some((p) => this.chunks[p.id].path === f.path)) {
          if (n === uniqSyms[0] && selSymbol) s += 3; else generic += 0.5;
          hit.push(n);
        }
      }
      s += Math.min(2, generic);
      for (const k of keys) {
        const post = this.postings.get(k);
        if (post && post.some((p) => this.chunks[p.id].path === f.path)) { s += 3; hit.unshift(k.toUpperCase()); }
      }
      if (hit.length) why.push(`references ${hit.slice(0, 3).map((h) => '`' + h + '`').join(', ')}`);
      if (s > (best?.s ?? (selSymbol ? 2.9 : 1.4))) best = { path: f.path, s, why: why.join(', ') };
    }
    return best;
  }

  private virtualChunk(f: FileInfo, s: number, e: number): Chunk {
    return { id: -1, path: f.path, startLine: s, endLine: e, kind: 'window', headerLines: 0, len: 1, tf: new Map(), nameTokens: new Set() };
  }

  private outlineChunk(f: FileInfo): Chunk {
    const c = this.virtualChunk(f, 1, f.lines.length);
    const rows = this.syms.filter((s) => s.path === f.path && s.kind !== 'variable').map((s) => `${String(s.line).padStart(5)} | ${s.signature}`);
    (c as any)._virtual = rows.join('\n') || '(no symbols)';
    return c;
  }

  private renderRange(f: FileInfo, s: number, e: number): string {
    const out: string[] = [];
    for (let i = s; i <= e && i <= f.lines.length; i++) out.push(`${String(i).padStart(5)} | ${f.lines[i - 1]}`);
    return out.join('\n');
  }

  /** Signature + first docstring line for code chunks; undefined for prose. */
  private outlineOf(f: FileInfo, c: Chunk): string | undefined {
    if (f.lang !== 'python' || (c.kind !== 'function' && c.kind !== 'method' && c.kind !== 'class')) {
      if (f.lang === 'python' && c.kind === 'module' && c.assigns?.length) {
        const rows: string[] = [];
        for (let i = c.startLine; i <= c.endLine; i++) if (/^[A-Za-z_]\w*\s*(?::[^=]+)?=/.test(f.lines[i - 1])) rows.push(`${String(i).padStart(5)} | ${shorten(f.lines[i - 1], 110)}`);
        return rows.join('\n') + '\n      | …';
      }
      return undefined;
    }
    const rows: string[] = [];
    const hdrEnd = c.startLine + Math.max(1, c.headerLines) - 1;
    for (let i = c.startLine; i <= Math.min(hdrEnd, c.startLine + 25); i++) rows.push(`${String(i).padStart(5)} | ${f.lines[i - 1]}`);
    const docLine = f.lines.slice(hdrEnd, Math.min(c.endLine, hdrEnd + 3)).findIndex((l) => /^\s*[rbuRBU]?("""|''')/.test(l));
    if (docLine >= 0) {
      const i = hdrEnd + docLine + 1;
      rows.push(`${String(i).padStart(5)} | ${f.lines[i - 1]}`);
      if (!/("""|''').*("""|''')/.test(f.lines[i - 1]) && f.lines[i]) rows.push(`${String(i + 1).padStart(5)} | ${f.lines[i]}`);
    }
    if (c.kind === 'class') {
      for (const s of this.syms) if (s.path === f.path && s.name.startsWith(`${c.name}.`) && s.line > c.endLine) rows.push(`${String(s.line).padStart(5)} | ${s.signature}`);
    }
    rows.push(`      | …  (body L${hdrEnd + 1}-L${c.endLine} omitted)`);
    return rows.join('\n');
  }
}
