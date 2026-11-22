/**
 * Anvil MCP server: exposes the editor (read, search, propose edits, run commands, retrieve context) to the
 * TrueForge agent over MCP streamable HTTP at http://127.0.0.1:<port>/mcp.
 *
 * Session modes: a client that sends `initialize` without a session id gets a stateful session (Mcp-Session-Id
 * header, GET for the SSE stream, DELETE to end it). A non-initialize POST without a session id is served
 * statelessly by a throwaway server/transport pair, so clients that never keep a session id still work.
 *
 * Write tools never touch disk themselves: they compute the full proposed content and hand it to
 * host.applyProposal, which applies only the hunks the user accepted in the review UI.
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { EditorHost } from '../shared/types';
import type { ContextEngine } from '../context/engine';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

const READ_CAP_LINES = 400;
const OUTPUT_TAIL_LINES = 200;

export class ToolError extends Error {}

// ---------------------------------------------------------------------------------------------
// Path safety

/** Resolve a workspace-relative path; throws ToolError if it escapes the root (.., absolute, symlink). */
export function resolveInRoot(root: string, rel: string): { abs: string; rel: string } {
  if (typeof rel !== 'string' || !rel.trim()) throw new ToolError('path is required (workspace-relative, e.g. "src/app.py")');
  if (rel.includes('\0')) throw new ToolError('invalid path');
  const rootAbs = path.resolve(root);
  const cleaned = rel.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const abs = path.resolve(rootAbs, cleaned);
  const r = path.relative(rootAbs, abs);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new ToolError(`path "${rel}" is outside the workspace; use a path relative to the workspace root`);
  // symlink escape: check the deepest existing ancestor's real path
  let probe = abs;
  while (!fs.existsSync(probe) && probe !== rootAbs) probe = path.dirname(probe);
  try {
    const realRoot = fs.realpathSync(rootAbs);
    const real = fs.realpathSync(probe);
    const rr = path.relative(realRoot, real);
    if (rr.startsWith('..') || path.isAbsolute(rr)) throw new ToolError(`path "${rel}" resolves outside the workspace (symlink)`);
  } catch (e) {
    if (e instanceof ToolError) throw e;
  }
  return { abs, rel: r.split(path.sep).join('/') || '.' };
}

// ---------------------------------------------------------------------------------------------
// Small utilities

function numbered(lines: string[], start: number): string {
  const w = String(start + lines.length - 1).length;
  return lines.map((l, i) => `${String(start + i).padStart(w)} | ${l}`).join('\n');
}

function globToRegExp(glob: string): RegExp {
  let re = '';
  let i = 0;
  const g = glob.replace(/\\/g, '/');
  while (i < g.length) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        re += g[i + 2] === '/' ? '(?:.*/)?' : '.*';
        i += g[i + 2] === '/' ? 3 : 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) { re += '(?:' + g.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')).join('|') + ')'; i = end + 1; continue; }
      re += '\\{';
    } else if ('.+^$()|[]\\'.includes(c)) re += '\\' + c;
    else re += c;
    i++;
  }
  // a glob without "/" matches the basename anywhere (like rg/gitignore)
  return g.includes('/') ? new RegExp('^' + re + '$') : new RegExp('(^|/)' + re + '$');
}

function runProcess(cmd: string, args: string[], cwd: string, timeoutMs = 15000, maxBytes = 4 * 1024 * 1024): Promise<{ code: number | null; stdout: string; stderr: string; missing?: boolean }> {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let done = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', missing: true });
      return;
    }
    const finish = (r: { code: number | null; stdout: string; stderr: string; missing?: boolean }) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
    const t = setTimeout(() => { child.kill('SIGKILL'); finish({ code: null, stdout: out, stderr: err + '\n(timed out)' }); }, timeoutMs);
    child.stdout!.on('data', (d) => { out += d; if (out.length > maxBytes) child.kill('SIGKILL'); });
    child.stderr!.on('data', (d) => { err += d; });
    child.on('error', (e: NodeJS.ErrnoException) => finish({ code: null, stdout: out, stderr: String(e), missing: e.code === 'ENOENT' }));
    child.on('close', (code) => finish({ code, stdout: out, stderr: err }));
  });
}

function similarity(a: string, b: string): number {
  // token-set overlap, cheap and good enough to point at "the line you probably meant"
  const ta = new Set(a.trim().split(/[^A-Za-z0-9_]+/).filter(Boolean));
  const tb = new Set(b.trim().split(/[^A-Za-z0-9_]+/).filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

function closestMatch(content: string, needle: string): string {
  const lines = content.split('\n');
  const nLines = needle.split('\n').filter((l) => l.trim());
  if (!nLines.length) return '';
  const first = nLines[0];
  // whitespace-insensitive exact match of the whole block?
  const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
  const nsq = squash(needle);
  for (let i = 0; i < lines.length; i++) {
    const win = squash(lines.slice(i, i + needle.split('\n').length).join('\n'));
    if (win === nsq) {
      return `The text exists with different whitespace/indentation at lines ${i + 1}-${i + needle.split('\n').length}:\n${numbered(lines.slice(i, i + needle.split('\n').length), i + 1)}`;
    }
  }
  let best = -1, bestS = 0;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim() === first.trim() ? 1.01 : similarity(lines[i], first);
    if (s > bestS) { bestS = s; best = i; }
  }
  if (best < 0 || bestS < 0.3) return 'No similar lines found; use read_file or search to locate the code first.';
  const from = Math.max(0, best - 2);
  const to = Math.min(lines.length, best + Math.max(nLines.length, 1) + 3);
  return `Closest match (line ${best + 1}, similarity ${(Math.min(bestS, 1) * 100).toFixed(0)}%):\n${numbered(lines.slice(from, to), from + 1)}`;
}

function tail(text: string, n: number): { text: string; dropped: number } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= n) return { text, dropped: 0 };
  return { text: lines.slice(-n).join('\n'), dropped: lines.length - n };
}

// ---------------------------------------------------------------------------------------------
// Tool implementations (exported for unit tests)

export interface ToolDeps { host: EditorHost; context: ContextEngine }

async function rgSearch(root: string, pattern: string, opts: { glob?: string; regex: boolean; word?: boolean; max: number }): Promise<{ hits: string[]; total: number; usedRg: boolean } | null> {
  const args = ['--json', '-n', '--no-messages', '--max-columns', '300', '--max-columns-preview'];
  if (!opts.regex) args.push('-F');
  if (opts.word) args.push('-w');
  if (opts.glob) args.push('--glob', opts.glob);
  args.push('-e', pattern, '--', '.');
  const r = await runProcess('rg', args, root);
  if (r.missing) return null;
  if (r.code === 2 && !r.stdout) throw new ToolError(`search failed: ${r.stderr.trim().split('\n')[0] || 'invalid pattern'}`);
  const hits: string[] = [];
  let total = 0;
  for (const line of r.stdout.split('\n')) {
    if (!line.startsWith('{"type":"match"')) continue;
    total++;
    if (hits.length >= opts.max) continue;
    try {
      const j = JSON.parse(line);
      const p = String(j.data.path.text).replace(/^\.\//, '');
      const text = String(j.data.lines.text ?? '').replace(/\r?\n$/, '');
      hits.push(`${p}:${j.data.line_number}: ${text.length > 240 ? text.slice(0, 240) + '…' : text}`);
    } catch { /* skip malformed */ }
  }
  return { hits, total, usedRg: true };
}

function jsSearch(deps: ToolDeps, pattern: string, opts: { glob?: string; regex: boolean; word?: boolean; max: number }): { hits: string[]; total: number; usedRg: boolean } {
  let re: RegExp;
  try {
    const src = opts.regex ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    re = new RegExp(opts.word ? `\\b(?:${src})\\b` : src);
  } catch (e) { throw new ToolError(`invalid regex: ${(e as Error).message}`); }
  const g = opts.glob ? globToRegExp(opts.glob) : null;
  const hits: string[] = [];
  let total = 0;
  for (const p of deps.context.listAllFiles()) {
    if (g && !g.test(p)) continue;
    let text: string;
    try {
      const abs = path.join(deps.host.workspaceRoot, p);
      if (fs.statSync(abs).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(abs, 'utf8');
    } catch { continue; }
    if (text.includes('\0')) continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i])) continue;
      total++;
      if (hits.length < opts.max) hits.push(`${p}:${i + 1}: ${lines[i].slice(0, 240)}`);
    }
  }
  return { hits, total, usedRg: false };
}

export async function doSearch(deps: ToolDeps, a: { pattern: string; path_glob?: string; regex?: boolean; max_results?: number }, word = false): Promise<string> {
  if (!a.pattern) throw new ToolError('pattern is required');
  const max = Math.max(1, Math.min(200, a.max_results ?? 50));
  const o = { glob: a.path_glob, regex: a.regex ?? true, word, max };
  const r = (await rgSearch(deps.host.workspaceRoot, a.pattern, o)) ?? jsSearch(deps, a.pattern, o);
  if (!r.total) return `No matches for ${JSON.stringify(a.pattern)}${a.path_glob ? ` in ${a.path_glob}` : ''}.`;
  const more = r.total > r.hits.length ? `\n… ${r.total - r.hits.length} more matches (narrow with path_glob or a more specific pattern)` : '';
  return `${r.total} match${r.total === 1 ? '' : 'es'}${a.path_glob ? ` in ${a.path_glob}` : ''}:\n${r.hits.join('\n')}${more}`;
}

export async function doReadFile(deps: ToolDeps, a: { path: string; start_line?: number; end_line?: number }): Promise<string> {
  const { rel } = resolveInRoot(deps.host.workspaceRoot, a.path);
  let text: string;
  try { text = await deps.host.readFile(rel); } catch { throw new ToolError(`file not found: ${rel} (use list_files or search to find the right path)`); }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const total = lines.length;
  const start = Math.max(1, Math.floor(a.start_line ?? 1));
  if (start > total) return `${rel} has only ${total} lines.`;
  let end = Math.min(total, Math.floor(a.end_line ?? total));
  if (end < start) end = start;
  let note = '';
  if (end - start + 1 > READ_CAP_LINES) {
    end = start + READ_CAP_LINES - 1;
    note = `\n[showing lines ${start}-${end} of ${total}; call read_file again with start_line=${end + 1} to continue]`;
  }
  const header = `${rel} (lines ${start}-${end} of ${total})`;
  return `${header}\n${numbered(lines.slice(start - 1, end), start)}${note}`;
}

export function doListFiles(deps: ToolDeps, a: { dir?: string; glob?: string }): string {
  const dir = a.dir ? resolveInRoot(deps.host.workspaceRoot, a.dir).rel : '.';
  const prefix = dir === '.' ? '' : dir.replace(/\/$/, '') + '/';
  const g = a.glob ? globToRegExp(a.glob) : null;
  const all = deps.context.listAllFiles().filter((p) => p.startsWith(prefix) && (!g || g.test(p)));
  if (!all.length) return `No files under ${dir}${a.glob ? ` matching ${a.glob}` : ''}.`;
  const CAP = 250;
  if (g || all.length <= CAP) {
    // flat list grouped by directory
    const shown = all.slice(0, CAP);
    const byDir = new Map<string, string[]>();
    for (const p of shown) {
      const d = path.posix.dirname(p);
      const arr = byDir.get(d) ?? [];
      arr.push(path.posix.basename(p));
      byDir.set(d, arr);
    }
    const out = [...byDir.entries()].map(([d, fsx]) => `${d === '.' ? './' : d + '/'}\n  ${fsx.join('  ')}`);
    return `${all.length} files under ${dir}${a.glob ? ` matching ${a.glob}` : ''}:\n${out.join('\n')}${all.length > CAP ? `\n… ${all.length - CAP} more (use glob or dir to narrow)` : ''}`;
  }
  // large tree: show direct children with file counts for subdirectories
  const files: string[] = [];
  const dirs = new Map<string, number>();
  for (const p of all) {
    const rest = p.slice(prefix.length);
    const i = rest.indexOf('/');
    if (i < 0) files.push(rest);
    else dirs.set(rest.slice(0, i), (dirs.get(rest.slice(0, i)) ?? 0) + 1);
  }
  const lines = [...[...dirs.entries()].map(([d, n]) => `${d}/  (${n} files)`), ...files.slice(0, CAP)];
  return `${all.length} files under ${dir} (top level shown; pass dir to drill in, or glob like "**/*.py"):\n${lines.join('\n')}`;
}

export async function doFindSymbol(deps: ToolDeps, a: { name: string }): Promise<string> {
  const name = (a.name ?? '').trim();
  if (!name) throw new ToolError('name is required');
  const defs = deps.context.findSymbol(name);
  if (defs.length) {
    return `${defs.length} definition${defs.length === 1 ? '' : 's'} of ${name}:\n` + defs.slice(0, 30).map((d) => `${d.path}:${d.line} ${d.kind} — ${d.signature}`).join('\n');
  }
  // fallback: regex definitions across languages
  const last = name.split('.').pop()!.replace(/[^A-Za-z0-9_$]/g, '');
  if (!last) return `No definition found for ${name}.`;
  const pat = `^\\s*(async\\s+def|def|class|function|const|let|var|export\\s+(default\\s+)?(function|class|const))\\s+${last}\\b|^${last}\\s*=`;
  const r = await doSearch(deps, { pattern: pat, regex: true, max_results: 20 });
  return r.startsWith('No matches') ? `No definition found for ${name}. Try search with a looser pattern.` : `Not in the symbol index; regex search found:\n${r}`;
}

export async function doFindReferences(deps: ToolDeps, a: { name: string }): Promise<string> {
  const name = (a.name ?? '').trim().split('.').pop()!;
  if (!name) throw new ToolError('name is required');
  return doSearch(deps, { pattern: name, regex: false, max_results: 100 }, true);
}

function countOccurrences(hay: string, needle: string): number[] {
  const idx: number[] = [];
  let i = hay.indexOf(needle);
  while (i >= 0) { idx.push(i); i = hay.indexOf(needle, i + Math.max(1, needle.length)); }
  return idx;
}

function lineOf(text: string, offset: number): number {
  let n = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export async function doEditFile(deps: ToolDeps, a: { path: string; old_string: string; new_string: string; replace_all?: boolean }): Promise<string> {
  const { rel } = resolveInRoot(deps.host.workspaceRoot, a.path);
  if (typeof a.old_string !== 'string' || a.old_string === '') throw new ToolError('old_string must be a non-empty exact excerpt of the file (to create a file use create_file)');
  if (typeof a.new_string !== 'string') throw new ToolError('new_string is required');
  if (a.old_string === a.new_string) throw new ToolError('old_string and new_string are identical; nothing to change');
  let content: string;
  try { content = await deps.host.readFile(rel); } catch { throw new ToolError(`file not found: ${rel} (use create_file for new files)`); }
  const crlf = content.includes('\r\n');
  const norm = crlf ? content.replace(/\r\n/g, '\n') : content;
  const oldS = a.old_string.replace(/\r\n/g, '\n');
  const newS = a.new_string.replace(/\r\n/g, '\n');
  const occ = countOccurrences(norm, oldS);
  if (occ.length === 0) {
    throw new ToolError(`old_string was not found in ${rel}. It must match the file exactly (including indentation). ${closestMatch(norm, oldS)}`);
  }
  if (occ.length > 1 && !a.replace_all) {
    throw new ToolError(`old_string occurs ${occ.length} times in ${rel} (lines ${occ.slice(0, 10).map((o) => lineOf(norm, o)).join(', ')}). Include more surrounding lines so it is unique, or pass replace_all=true.`);
  }
  const firstLine = lineOf(norm, occ[0]);
  let next = a.replace_all ? norm.split(oldS).join(newS) : norm.slice(0, occ[0]) + newS + norm.slice(occ[0] + oldS.length);
  if (crlf) next = next.replace(/\n/g, '\r\n');
  const res = await deps.host.applyProposal(rel, next, false);
  try { deps.context.refresh(rel, await deps.host.readFile(rel)); } catch { /* index refresh is best effort */ }
  const endLine = firstLine + newS.split('\n').length - 1;
  const status = !res.applied
    ? `NOT applied: ${res.summary}. The file is unchanged; do not assume this edit exists.`
    : res.rejectedHunks > 0
      ? `Partially applied: ${res.acceptedHunks} hunk(s) accepted, ${res.rejectedHunks} rejected by the user. ${res.summary}. Re-read the file before further edits.`
      : `Applied: ${res.acceptedHunks} hunk(s) accepted. ${res.summary}`;
  return `${status}\n${rel}: edit at lines ${firstLine}-${endLine}${a.replace_all && occ.length > 1 ? ` (and ${occ.length - 1} more occurrence(s))` : ''}.`;
}

export async function doCreateFile(deps: ToolDeps, a: { path: string; content: string }): Promise<string> {
  const { abs, rel } = resolveInRoot(deps.host.workspaceRoot, a.path);
  if (typeof a.content !== 'string') throw new ToolError('content is required');
  let exists = fs.existsSync(abs);
  if (!exists) { try { await deps.host.readFile(rel); exists = true; } catch { /* missing, good */ } }
  if (exists) throw new ToolError(`${rel} already exists; use edit_file to change it (read_file first).`);
  const res = await deps.host.applyProposal(rel, a.content, true);
  try { if (res.applied) deps.context.refresh(rel, a.content); } catch { /* best effort */ }
  const n = a.content.split('\n').length;
  return res.applied ? `Created ${rel} (${n} lines). ${res.summary}` : `NOT created: ${res.summary}. The file does not exist.`;
}

export async function doRunCommand(deps: ToolDeps, a: { command: string }, signal?: AbortSignal): Promise<string> {
  const command = (a.command ?? '').trim();
  if (!command) throw new ToolError('command is required');
  const r = await deps.host.runCommand(command, signal);
  const t = tail(r.output ?? '', OUTPUT_TAIL_LINES);
  const status = r.timedOut ? 'timed out (120 s cap) and was killed' : r.exitCode === null ? 'was cancelled' : `exit code ${r.exitCode}`;
  return `$ ${command}\n→ ${status}\n${t.dropped ? `[${t.dropped} earlier lines omitted]\n` : ''}${t.text.trim() || '(no output)'}`;
}

export async function doRetrieveContext(deps: ToolDeps, a: { query: string; budget_tokens?: number; files?: string[]; symbols?: string[] }): Promise<{ text: string; pack: Awaited<ReturnType<ContextEngine['retrieve']>> }> {
  if (!a.query?.trim()) throw new ToolError('query is required: describe the task in plain words');
  const budget = Math.max(500, Math.min(30000, a.budget_tokens ?? 4000));
  const files = (a.files ?? []).map((f) => resolveInRoot(deps.host.workspaceRoot, f).rel);
  const pack = await deps.context.retrieve(a.query, { budgetTokens: budget, mentions: { files, symbols: a.symbols ?? [] } });
  const chosen = pack.items.map((i) => `- ${i.path}:L${i.startLine}-L${i.endLine} [${i.source}] — ${i.reason}`).join('\n');
  const text = `${pack.rendered}\n---\nChosen (${pack.items.length} items, ${pack.usedTokens}/${pack.budgetTokens} tokens):\n${chosen}`;
  deps.host.emit({
    kind: 'context',
    title: `retrieve_context chose ${new Set(pack.items.map((i) => i.path)).size} files (${pack.usedTokens}/${pack.budgetTokens} tok)`,
    detail: pack.items.map((i) => `${i.path}:L${i.startLine}-L${i.endLine} — ${i.reason}`).join('\n'),
    data: pack,
  });
  return { text, pack };
}

// ---------------------------------------------------------------------------------------------
// MCP server wiring

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === 'content' || k === 'new_string' || k === 'old_string') { parts.push(`${k}: ${String(v ?? '').length} chars`); continue; }
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    parts.push(`${k}: ${s.length > 80 ? s.slice(0, 79) + '…' : s}`);
  }
  return parts.join(', ');
}

export function createAnvilMcpServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'anvil-editor', version: '0.1.0' }, {
    instructions: 'Editor tools for the open VS Code workspace. Paths are workspace-relative. Start with retrieve_context for any task, then read_file/search to confirm, and edit with edit_file (exact old_string). Edits go through the user\'s per-hunk review; the result says which hunks were applied.',
  });

  const wrap = <A extends Record<string, unknown>>(name: string, fn: (a: A, extra: { signal?: AbortSignal }) => Promise<string>) =>
    async (a: A, extra: { signal?: AbortSignal }): Promise<ToolResult> => {
      const t0 = Date.now();
      try {
        const text = await fn(a, extra);
        deps.host.emit({ kind: 'tool', title: `${name}(${summarizeArgs(a)})`, detail: text.split('\n')[0].slice(0, 200), data: { name, args: a, ok: true, ms: Date.now() - t0 } });
        return { content: [{ type: 'text', text }] };
      } catch (e) {
        const msg = e instanceof ToolError ? e.message : `${name} failed: ${(e as Error)?.message ?? String(e)}`;
        deps.host.emit({ kind: 'tool', title: `${name}(${summarizeArgs(a)}) failed`, detail: msg.slice(0, 300), data: { name, args: a, ok: false, ms: Date.now() - t0 } });
        return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
      }
    };

  // untyped alias: the SDK's generic zod inference hits TS2589 (excessively deep) with zod 3; schemas are still validated at runtime
  const reg = (server as any).registerTool.bind(server) as (name: string, config: Record<string, unknown>, cb: unknown) => unknown;
  const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const WR = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

  reg('retrieve_context', {
    title: 'Retrieve relevant code',
    description: 'Find the code, tests and docs most relevant to a task, packed under a token budget. Returns numbered snippets with WHY each was chosen (symbol definitions, keyword matches, the test file and docs page for the module, import neighbours). Call this first for any task, with the task description as the query; then read_file for full context.',
    inputSchema: {
      query: z.string().describe('The task or question in plain words, e.g. the user request'),
      budget_tokens: z.number().int().optional().describe('Token budget for the pack (default 4000, max 30000)'),
      files: z.array(z.string()).optional().describe('Workspace-relative files that must be included'),
      symbols: z.array(z.string()).optional().describe('Symbol names (functions/classes) that must be included'),
    },
    annotations: RO,
  }, wrap('retrieve_context', async (a: any) => (await doRetrieveContext(deps, a)).text) as any);

  reg('search', {
    title: 'Search the workspace',
    description: 'Search file contents with ripgrep. Returns "path:line: text" lines (respects .gitignore). Use for exact strings, identifiers or regexes.',
    inputSchema: {
      pattern: z.string().describe('Regex (default) or literal text when regex=false'),
      path_glob: z.string().optional().describe('Limit to files matching this glob, e.g. "src/**/*.py" or "*.rst"'),
      regex: z.boolean().optional().describe('Treat pattern as a regex (default true); false = literal'),
      max_results: z.number().int().optional().describe('Max lines returned (default 50, max 200)'),
    },
    annotations: RO,
  }, wrap('search', (a: any) => doSearch(deps, a)) as any);

  reg('read_file', {
    title: 'Read a file',
    description: `Read a workspace file with line numbers (includes unsaved editor changes). Returns at most ${READ_CAP_LINES} lines per call; page with start_line/end_line.`,
    inputSchema: {
      path: z.string().describe('Workspace-relative path, e.g. "src/flask/cli.py"'),
      start_line: z.number().int().optional().describe('First line (1-based, default 1)'),
      end_line: z.number().int().optional().describe('Last line inclusive (default: end of file)'),
    },
    annotations: RO,
  }, wrap('read_file', (a: any) => doReadFile(deps, a)) as any);

  reg('list_files', {
    title: 'List files',
    description: 'List workspace files as a compact tree (skips .git, node_modules, virtualenvs, build output). Use dir to drill into a folder and glob (e.g. "**/*.py", "test_*.py") to filter.',
    inputSchema: {
      dir: z.string().optional().describe('Workspace-relative directory (default: root)'),
      glob: z.string().optional().describe('Filter, e.g. "**/*.rst"'),
    },
    annotations: RO,
  }, wrap('list_files', async (a: any) => doListFiles(deps, a)) as any);

  reg('find_symbol', {
    title: 'Find a definition',
    description: 'Find where a function, class, method (Class.method) or module-level variable is defined. Returns path:line, kind and signature.',
    inputSchema: { name: z.string().describe('Symbol name, e.g. "get_debug_flag" or "FlaskGroup.get_command"') },
    annotations: RO,
  }, wrap('find_symbol', (a: any) => doFindSymbol(deps, a)) as any);

  reg('find_references', {
    title: 'Find references',
    description: 'Find every whole-word occurrence of a name across the workspace (calls, imports, docs). Returns "path:line: text".',
    inputSchema: { name: z.string().describe('Identifier to look for') },
    annotations: RO,
  }, wrap('find_references', (a: any) => doFindReferences(deps, a)) as any);

  reg('edit_file', {
    title: 'Edit a file',
    description: 'Replace an exact excerpt of a file. old_string must match the current file exactly (whitespace included) and occur once, unless replace_all=true; include 2-3 surrounding lines to make it unique. The change is shown to the user as a per-hunk diff; the result says which hunks were applied. On a mismatch the error quotes the closest lines so you can retry.',
    inputSchema: {
      path: z.string().describe('Workspace-relative path'),
      old_string: z.string().describe('Exact text to replace (copy it from read_file output without the line-number prefix)'),
      new_string: z.string().describe('Replacement text'),
      replace_all: z.boolean().optional().describe('Replace every occurrence (default false)'),
    },
    annotations: WR,
  }, wrap('edit_file', (a: any) => doEditFile(deps, a)) as any);

  reg('create_file', {
    title: 'Create a file',
    description: 'Create a new file with the given content (fails if it exists; use edit_file then). Shown to the user for review before it is written.',
    inputSchema: {
      path: z.string().describe('Workspace-relative path of the new file'),
      content: z.string().describe('Full file content'),
    },
    annotations: WR,
  }, wrap('create_file', (a: any) => doCreateFile(deps, a)) as any);

  reg('run_command', {
    title: 'Run a shell command',
    description: 'Run a shell command in the workspace root (e.g. "python -m pytest tests/test_cli.py -q"). Returns the exit code and the last 200 lines of output. 120 s limit.',
    inputSchema: { command: z.string().describe('Shell command line') },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, wrap('run_command', (a: any, extra) => doRunCommand(deps, a, extra.signal)) as any);

  return server;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 20 * 1024 * 1024) throw new Error('request body too large');
    chunks.push(c as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : undefined;
}

export async function startMcpServer(opts: { port: number; host: EditorHost; context: ContextEngine; hostname?: string }): Promise<{ url: string; close(): Promise<void> }> {
  const deps: ToolDeps = { host: opts.host, context: opts.context };
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();
  const hostname = opts.hostname ?? '127.0.0.1';

  const sendJsonError = (res: http.ServerResponse, status: number, message: string) => {
    if (res.headersSent) return;
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
  };

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      if (url.pathname === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessions: sessions.size, index: opts.context.stats() }));
        return;
      }
      if (url.pathname !== '/mcp' && url.pathname !== '/mcp/') { sendJsonError(res, 404, 'not found; MCP endpoint is /mcp'); return; }
      const sid = req.headers['mcp-session-id'] as string | undefined;

      if (req.method === 'POST') {
        let body: unknown;
        try { body = await readBody(req); } catch (e) { sendJsonError(res, 400, `invalid JSON body: ${(e as Error).message}`); return; }
        if (sid && sessions.has(sid)) { await sessions.get(sid)!.transport.handleRequest(req, res, body); return; }
        const isInit = Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
        if (isInit) {
          const server = createAnvilMcpServer(deps);
          const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => { sessions.set(id, { transport, server }); },
          });
          transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
          await server.connect(transport);
          await transport.handleRequest(req, res, body);
          return;
        }
        if (sid) { sendJsonError(res, 404, 'unknown or expired MCP session; re-initialize'); return; }
        // stateless fallback for clients that never keep a session id
        const server = createAnvilMcpServer(deps);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on('close', () => { void transport.close(); void server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        if (!sid || !sessions.has(sid)) {
          if (req.method === 'GET') { res.writeHead(405, { allow: 'POST' }); res.end(); return; }
          sendJsonError(res, 404, 'unknown MCP session');
          return;
        }
        await sessions.get(sid)!.transport.handleRequest(req, res);
        return;
      }
      res.writeHead(405, { allow: 'GET, POST, DELETE' });
      res.end();
    } catch (e) {
      sendJsonError(res, 500, `internal error: ${(e as Error).message}`);
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(opts.port, hostname, () => { httpServer.off('error', reject); resolve(); });
  });
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : opts.port;
  return {
    url: `http://${hostname}:${port}/mcp`,
    async close() {
      for (const { transport, server } of sessions.values()) { try { await transport.close(); await server.close(); } catch { /* ignore */ } }
      sessions.clear();
      httpServer.closeAllConnections?.();
      await new Promise<void>((r) => httpServer.close(() => r()));
    },
  };
}
