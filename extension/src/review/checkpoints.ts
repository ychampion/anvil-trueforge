import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export interface Change { relPath: string; before: string | null; after: string; label: string; at: number; }

/** Writes go through WorkspaceEdit (so Ctrl+Z works) and are recorded for "undo last" and "undo run". */
export class Checkpoints {
  private stack: Change[] = [];
  private run: Map<string, string | null> | undefined;
  private runWrites = 0;
  private emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;

  constructor(private root: string) {}

  abs(relPath: string) { return path.isAbsolute(relPath) ? relPath : path.join(this.root, relPath); }
  uri(relPath: string) { return vscode.Uri.file(this.abs(relPath)); }

  async currentText(relPath: string): Promise<string | null> {
    const uri = this.uri(relPath);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === uri.fsPath);
    if (open) return open.getText();
    try { return await fs.promises.readFile(uri.fsPath, 'utf8'); } catch { return null; }
  }

  beginRun() { this.run = new Map(); this.runWrites = 0; this.emitter.fire(); }
  endRun() { /* keep run map so "Undo whole run" works after the run finishes */ this.emitter.fire(); }
  get hasRun() { return !!this.run && this.run.size > 0; }
  get canUndoLast() { return this.stack.length > 0; }
  get runFileCount() { return this.run?.size ?? 0; }

  /** Write `content` to relPath, recording checkpoints. */
  async write(relPath: string, content: string, label: string): Promise<void> {
    const before = await this.currentText(relPath);
    if (this.run && !this.run.has(relPath)) this.run.set(relPath, before);
    await this.rawWrite(relPath, content, before !== null);
    this.stack.push({ relPath, before, after: content, label, at: Date.now() });
    this.runWrites++;
    this.emitter.fire();
  }

  private async rawWrite(relPath: string, content: string, exists: boolean) {
    const uri = this.uri(relPath);
    const we = new vscode.WorkspaceEdit();
    if (!exists) {
      await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
      we.createFile(uri, { ignoreIfExists: true, contents: Buffer.from(content, 'utf8') });
      const ok = await vscode.workspace.applyEdit(we);
      if (!ok) throw new Error(`could not create ${relPath}`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const full = new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));
    we.replace(uri, full, content);
    const ok = await vscode.workspace.applyEdit(we);
    if (!ok) throw new Error(`could not edit ${relPath}`);
    await doc.save();
  }

  private async restore(relPath: string, before: string | null) {
    const uri = this.uri(relPath);
    if (before === null) {
      const we = new vscode.WorkspaceEdit();
      we.deleteFile(uri, { ignoreIfNotExists: true });
      await vscode.workspace.applyEdit(we);
      return;
    }
    const exists = fs.existsSync(uri.fsPath);
    await this.rawWrite(relPath, before, exists);
  }

  async undoLast(): Promise<Change | undefined> {
    const c = this.stack.pop();
    if (!c) return undefined;
    await this.restore(c.relPath, c.before);
    this.emitter.fire();
    return c;
  }

  /** Restore every file touched in the current/last run to its pre-run content. */
  async undoRun(): Promise<string[]> {
    if (!this.run) return [];
    const files = [...this.run.entries()];
    for (const [rel, before] of files) await this.restore(rel, before);
    const touched = new Set(files.map(([r]) => r));
    this.stack = this.stack.filter((c) => !touched.has(c.relPath));
    this.run = new Map();
    this.emitter.fire();
    return files.map(([r]) => r);
  }
}
