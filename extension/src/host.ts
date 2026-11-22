import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { ApplyResult, EditorHost } from './shared/types';
import { ReviewManager } from './review/reviewManager';
import { Checkpoints } from './review/checkpoints';
import { applyHunks, computeHunks, Hunk, sha256 } from './review/hunks';
import { runs } from './run';
import type { ApprovalDecision, PendingToolCall } from './trueforge/client';

interface Decision { original: string; hunks: Hunk[]; accepted: boolean[]; }

export interface HostEvent { kind: string; title: string; detail?: string; data?: unknown; }

export class AnvilHost implements EditorHost {
  private decisions = new Map<string, Decision>();
  private emitter = new vscode.EventEmitter<HostEvent>();
  readonly onEvent = this.emitter.event;
  readonly output: vscode.OutputChannel;

  constructor(public workspaceRoot: string, private reviews: ReviewManager, public checkpoints: Checkpoints) {
    this.output = vscode.window.createOutputChannel('Anvil');
  }

  rel(p: string): string {
    let r = p.replace(/\\/g, '/');
    if (path.isAbsolute(p)) r = path.relative(this.workspaceRoot, p).replace(/\\/g, '/');
    r = r.replace(/^\.\//, '').replace(/^\/+/, '');
    if (r.startsWith('..')) throw new Error(`path outside workspace: ${p}`);
    return r;
  }

  async readFile(relPath: string): Promise<string> {
    const t = await this.checkpoints.currentText(this.rel(relPath));
    if (t === null) throw new Error(`file not found: ${relPath}`);
    return t;
  }

  emit(event: HostEvent): void {
    this.emitter.fire(event);
  }

  private key(relPath: string, proposed: string) { return `${this.rel(relPath)}\u0000${sha256(proposed)}`; }

  // ---------- approvals (called by the turn runner on tool.approval_required) ----------

  async decide(call: PendingToolCall): Promise<ApprovalDecision> {
    const name = call.name;
    const a = call.args ?? {};
    try {
      if (name === 'edit_file') return await this.decideEdit(a);
      if (name === 'create_file' || name === 'write_file') return await this.decideCreate(a);
      if (name === 'run_command') return await this.decideCommand(a);
    } catch (e: any) {
      return { status: 'deny', reason: `Anvil could not prepare this change: ${e?.message ?? e}` };
    }
    const pick = await vscode.window.showWarningMessage(`Anvil: allow tool ${name}?`, { detail: JSON.stringify(a).slice(0, 400) }, 'Allow', 'Deny');
    return pick === 'Allow' ? { status: 'allow' } : { status: 'deny', reason: 'user denied' };
  }

  private async decideEdit(a: any): Promise<ApprovalDecision> {
    const relPath = this.rel(String(a.path ?? a.file_path ?? ''));
    const oldS: string = a.old_string ?? a.oldString ?? '';
    const newS: string = a.new_string ?? a.newString ?? '';
    const current = await this.checkpoints.currentText(relPath);
    if (current === null) {
      this.emit({ kind: 'auto-deny', title: `Denied edit_file: ${relPath} does not exist` });
      return { status: 'deny', reason: `${relPath} does not exist. Use create_file for new files, or list/search files to find the right path.` };
    }
    const count = oldS ? current.split(oldS).length - 1 : 0;
    if (count === 0 || (count > 1 && !a.replace_all)) {
      const reason = count === 0 ? this.notFoundReason(relPath, current, oldS) : this.multiReason(relPath, current, oldS, count);
      this.emit({ kind: 'auto-deny', title: `Auto-denied edit_file on ${relPath}`, detail: reason });
      return { status: 'deny', reason };
    }
    const proposed = a.replace_all ? current.split(oldS).join(newS) : current.replace(oldS, () => newS);
    return this.reviewAndRecord(relPath, current, proposed);
  }

  private notFoundReason(relPath: string, current: string, oldS: string): string {
    const first = oldS.split('\n').map((l) => l.trim()).find((l) => l.length > 3);
    const lines = current.split('\n');
    let near = -1;
    if (first) near = lines.findIndex((l) => l.includes(first));
    if (near < 0 && first) {
      const tok = first.split(/\W+/).filter((t) => t.length > 3).sort((x, y) => y.length - x.length)[0];
      if (tok) near = lines.findIndex((l) => l.includes(tok));
    }
    if (near >= 0) {
      const s = Math.max(1, near + 1 - 5), e = Math.min(lines.length, near + 1 + 20);
      return `old_string not found in ${relPath} (no exact match; closest text is near line ${near + 1}). Re-read lines ${s}-${e} with read_file and copy old_string exactly, including whitespace.`;
    }
    return `old_string not found in ${relPath} — that text/symbol does not exist in the file. Re-read the file (read_file ${relPath}) or search_code before editing.`;
  }

  private multiReason(relPath: string, current: string, oldS: string, count: number): string {
    const at: number[] = [];
    let i = -1;
    while ((i = current.indexOf(oldS, i + 1)) >= 0 && at.length < 6) at.push(current.slice(0, i).split('\n').length);
    return `old_string matches ${count} places in ${relPath} (lines ${at.join(', ')}); include more surrounding lines so it matches exactly once.`;
  }

  private async decideCreate(a: any): Promise<ApprovalDecision> {
    const relPath = this.rel(String(a.path ?? a.file_path ?? ''));
    const content: string = a.content ?? '';
    const current = (await this.checkpoints.currentText(relPath)) ?? '';
    return this.reviewAndRecord(relPath, current, content);
  }

  private async reviewAndRecord(relPath: string, original: string, proposed: string): Promise<ApprovalDecision> {
    if (original === proposed) return { status: 'deny', reason: `no change: the proposed content of ${relPath} equals the current content` };
    const r = await this.reviews.review(relPath, original, proposed, 'agent');
    if (!r) return { status: 'deny', reason: 'review cancelled by user' };
    const n = r.accepted.filter(Boolean).length;
    if (n === 0) return { status: 'deny', reason: `user rejected all ${r.hunks.length} hunks for ${relPath}` };
    this.decisions.set(this.key(relPath, proposed), { original, hunks: r.hunks, accepted: r.accepted });
    return { status: 'allow' };
  }

  private async decideCommand(a: any): Promise<ApprovalDecision> {
    const cmd = String(a.command ?? '').trim();
    const pats = vscode.workspace.getConfiguration('anvil').get<string[]>('autoApproveCommands') ?? [];
    for (const p of pats) {
      try {
        if (new RegExp(p).test(cmd)) {
          this.emit({ kind: 'command', title: `Auto-approved: ${cmd}`, detail: `matches ${p}` });
          return { status: 'allow' };
        }
      } catch { /* bad regex in settings */ }
    }
    if (process.env.ANVIL_TEST_AUTO_ALLOW_COMMANDS === '1') return { status: 'allow' };
    const pick = await vscode.window.showWarningMessage(`Anvil wants to run: ${cmd}`, { modal: false }, 'Allow', 'Deny');
    if (pick === 'Allow') { this.emit({ kind: 'command', title: `Allowed: ${cmd}` }); return { status: 'allow' }; }
    this.emit({ kind: 'command', title: `Denied: ${cmd}` });
    return { status: 'deny', reason: 'user denied the command' };
  }

  // ---------- writes ----------

  async applyProposal(relPathIn: string, proposedContent: string, isNewFile: boolean): Promise<ApplyResult> {
    const relPath = this.rel(relPathIn);
    const current = (await this.checkpoints.currentText(relPath)) ?? '';
    const k = this.key(relPath, proposedContent);
    let d = this.decisions.get(k);
    this.decisions.delete(k);
    let hunks: Hunk[];
    let accepted: boolean[];
    if (d && d.original === current) {
      hunks = d.hunks; accepted = d.accepted;
    } else {
      hunks = computeHunks(current, proposedContent);
      if (d && d.hunks.length === hunks.length) {
        accepted = d.accepted;
      } else {
        const r = await this.reviews.review(relPath, current, proposedContent, 'agent');
        if (!r) return { applied: false, acceptedHunks: 0, rejectedHunks: hunks.length, summary: `Review of ${relPath} was cancelled; nothing written.` };
        hunks = r.hunks; accepted = r.accepted;
      }
    }
    return this.writeAccepted(relPath, current, hunks, accepted, isNewFile, 'agent');
  }

  /** Shared with inline edit. */
  async writeAccepted(relPath: string, original: string, hunks: Hunk[], accepted: boolean[], isNewFile: boolean, label: string): Promise<ApplyResult> {
    const nAcc = accepted.filter(Boolean).length;
    const nRej = hunks.length - nAcc;
    const desc = (h: Hunk) => `#${h.index + 1} (line ${h.origStart + 1}, -${h.removed.length} +${h.added.length})`;
    if (nAcc === 0) {
      this.emit({ kind: 'apply', title: `Nothing applied to ${relPath}`, detail: 'all hunks rejected' });
      return { applied: false, acceptedHunks: 0, rejectedHunks: nRej, summary: `User rejected all ${hunks.length} hunks; ${relPath} unchanged.` };
    }
    const content = applyHunks(original, hunks, accepted);
    if (runs.current?.abort.signal.aborted) {
      return { applied: false, acceptedHunks: 0, rejectedHunks: hunks.length, summary: 'Run cancelled; nothing written.' };
    }
    await this.checkpoints.write(relPath, content, label);
    if (runs.current) runs.current.editsApplied = true;
    const acc = hunks.filter((h) => accepted[h.index]).map(desc);
    const rej = hunks.filter((h) => !accepted[h.index]).map(desc);
    const summary = `${isNewFile ? 'Created' : 'Edited'} ${relPath}: applied ${nAcc}/${hunks.length} hunks [${acc.join(', ')}]` +
      (rej.length ? `; user REJECTED ${rej.join(', ')} — those parts were not written, do not assume them.` : '.');
    this.emit({ kind: 'apply', title: `Applied ${nAcc}/${hunks.length} hunks to ${relPath}`, data: { relPath, accepted: nAcc, total: hunks.length } });
    return { applied: true, acceptedHunks: nAcc, rejectedHunks: nRej, summary };
  }

  // ---------- commands ----------

  runCommand(command: string, signal?: AbortSignal): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
    return new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = { ...process.env };
      const venvBin = path.join(this.workspaceRoot, '.venv', process.platform === 'win32' ? 'Scripts' : 'bin');
      if (fs.existsSync(venvBin)) {
        env.PATH = venvBin + path.delimiter + (env.PATH ?? '');
        env.VIRTUAL_ENV = path.join(this.workspaceRoot, '.venv');
      }
      this.output.appendLine(`$ ${command}`);
      const child = spawn(command, { cwd: this.workspaceRoot, env, shell: true, detached: process.platform !== 'win32' });
      let out = '';
      let timedOut = false;
      let finished = false;
      const kill = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* already exited */ }
      };
      const timer = setTimeout(() => { timedOut = true; kill(); }, 120_000);
      const onAbort = () => { this.output.appendLine('[cancelled]'); kill(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      const runSignal = runs.current?.abort.signal;
      runSignal?.addEventListener('abort', onAbort, { once: true });
      const onData = (b: Buffer) => {
        const s = b.toString('utf8');
        out += s;
        if (out.length > 200_000) out = out.slice(-200_000);
        this.output.append(s);
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const done = (code: number | null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        runSignal?.removeEventListener('abort', onAbort);
        this.output.appendLine(`[exit ${code}${timedOut ? ', timed out after 120 s' : ''}]`);
        this.emit({ kind: 'command', title: `${command} → exit ${code}${timedOut ? ' (timed out)' : ''}` });
        resolve({ exitCode: code, output: out, timedOut });
      };
      child.on('error', (e) => { out += String(e); done(null); });
      child.on('close', (code) => done(code));
    });
  }
}
