/**
 * Standalone Anvil MCP server for spikes and tests, outside VS Code.
 *
 *   bun src/mcp/standalone.ts --root /path/to/workspace [--port 7391] [--read-only]
 *
 * TEST-ONLY: FakeHost.applyProposal writes the proposed content straight to disk with no review UI.
 * The real extension uses the VS Code host, which applies only the hunks the user accepted.
 * Pass --read-only to refuse every write instead (safe for poking at a repo you must not change).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { structuredPatch } from 'diff';
import type { ApplyResult, EditorHost } from '../shared/types';
import { ContextEngine } from '../context/engine';
import { startMcpServer } from './server';

export class FakeHost implements EditorHost {
  readonly events: { kind: string; title: string; detail?: string; data?: unknown }[] = [];
  constructor(public workspaceRoot: string, private opts: { readOnly?: boolean; quiet?: boolean } = {}) {}

  async readFile(relPath: string): Promise<string> {
    return fs.readFileSync(path.join(this.workspaceRoot, relPath), 'utf8');
  }

  /** TEST-ONLY: writes everything, no per-hunk review. */
  async applyProposal(relPath: string, proposedContent: string, isNewFile: boolean): Promise<ApplyResult> {
    const abs = path.join(this.workspaceRoot, relPath);
    const before = isNewFile || !fs.existsSync(abs) ? '' : fs.readFileSync(abs, 'utf8');
    const hunks = structuredPatch(relPath, relPath, before, proposedContent, '', '', { context: 3 }).hunks.length;
    if (this.opts.readOnly) return { applied: false, acceptedHunks: 0, rejectedHunks: hunks, summary: `read-only test host: refused ${hunks} hunk(s)` };
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, proposedContent);
    return { applied: true, acceptedHunks: hunks, rejectedHunks: 0, summary: `TEST-ONLY host wrote ${relPath} (${hunks} hunk(s), no review)` };
  }

  runCommand(command: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const child = spawn(command, { cwd: this.workspaceRoot, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      let timedOut = false;
      const onData = (d: Buffer) => { output += d.toString(); if (output.length > 2_000_000) output = output.slice(-1_000_000); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const t = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
      const onAbort = () => child.kill('SIGKILL');
      signal?.addEventListener('abort', onAbort, { once: true });
      child.on('close', (code) => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); resolve({ exitCode: timedOut || signal?.aborted ? null : code, output, timedOut }); });
      child.on('error', (e) => { clearTimeout(t); resolve({ exitCode: 127, output: output + String(e), timedOut: false }); });
    });
  }

  emit(event: { kind: string; title: string; detail?: string; data?: unknown }): void {
    this.events.push(event);
    if (!this.opts.quiet) process.stderr.write(`[anvil:${event.kind}] ${event.title}${event.detail ? ' — ' + event.detail.split('\n')[0] : ''}\n`);
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const root = path.resolve(arg('root') ?? process.cwd());
  const port = Number(arg('port') ?? 7391);
  const host = new FakeHost(root, { readOnly: process.argv.includes('--read-only') });
  const engine = new ContextEngine(root);
  const t0 = Date.now();
  await engine.index();
  const s = engine.stats();
  const srv = await startMcpServer({ port, host, context: engine });
  process.stderr.write(`anvil MCP (standalone, TEST-ONLY host${process.argv.includes('--read-only') ? ', read-only' : ''}) on ${srv.url} · root ${root} · indexed ${s.files} files / ${s.chunks} chunks / ${s.symbols} symbols in ${Date.now() - t0} ms\n`);
  const stop = async () => { await srv.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

// run only when executed directly (not when imported by tests)
if (/standalone\.(ts|js|mjs|cjs)$/.test(process.argv[1] ?? '')) void main();
