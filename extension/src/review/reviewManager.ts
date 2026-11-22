import * as vscode from 'vscode';
import { computeHunks, Hunk, HunkState } from './hunks';

export const REVIEW_SCHEME = 'anvil-review';

export interface ReviewResult {
  accepted: boolean[];
  hunks: Hunk[];
  original: string;
  proposed: string;
}

export interface ReviewInfo {
  id: string;
  relPath: string;
  hunks: number;
  accepted: number;
  rejected: number;
  status: 'pending' | 'applied' | 'rejected' | 'discarded' | 'undone';
  origin: string;
}

class ReviewSession {
  states: HunkState[];
  resolve!: (r: ReviewResult | null) => void;
  promise: Promise<ReviewResult | null>;
  done = false;
  constructor(
    public id: string,
    public relPath: string,
    public original: string,
    public proposed: string,
    public hunks: Hunk[],
    public leftUri: vscode.Uri,
    public rightUri: vscode.Uri,
    public origin: string,
  ) {
    this.states = hunks.map(() => 'pending');
    this.promise = new Promise((res) => (this.resolve = res));
  }
}

let seq = 0;

export class ReviewManager implements vscode.TextDocumentContentProvider, vscode.CodeLensProvider, vscode.Disposable {
  private contents = new Map<string, string>();
  private sessions = new Map<string, ReviewSession>();
  private changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;
  private lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private infoEmitter = new vscode.EventEmitter<ReviewInfo>();
  /** Fires whenever a review card should update in the panel. */
  readonly onDidUpdateReview = this.infoEmitter.event;
  private disposables: vscode.Disposable[] = [];

  /** Test-only hook: if set, every review is decided immediately by this function. */
  autoDecide?: (relPath: string, hunks: Hunk[]) => boolean[];

  private decoPending = vscode.window.createTextEditorDecorationType({
    after: { contentText: '  ● pending review', color: new vscode.ThemeColor('editorCodeLens.foreground'), margin: '0 0 0 2em' },
    isWholeLine: true,
  });
  private decoAccepted = vscode.window.createTextEditorDecorationType({
    after: { contentText: '  ✓ accepted', color: new vscode.ThemeColor('testing.iconPassed'), margin: '0 0 0 2em' },
    isWholeLine: true,
  });
  private decoRejected = vscode.window.createTextEditorDecorationType({
    after: { contentText: '  ✗ rejected', color: new vscode.ThemeColor('testing.iconFailed'), margin: '0 0 0 2em' },
    textDecoration: 'line-through',
    opacity: '0.55',
    isWholeLine: true,
  });

  constructor() {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider(REVIEW_SCHEME, this),
      vscode.languages.registerCodeLensProvider({ scheme: REVIEW_SCHEME }, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshDecorations()),
      vscode.commands.registerCommand('anvil.review.acceptHunk', (id: string, i: number) => this.setState(id, i, 'accepted')),
      vscode.commands.registerCommand('anvil.review.rejectHunk', (id: string, i: number) => this.setState(id, i, 'rejected')),
      vscode.commands.registerCommand('anvil.review.acceptAll', (id?: string) => this.decideAll(id, true)),
      vscode.commands.registerCommand('anvil.review.rejectAll', (id?: string) => this.decideAll(id, false)),
      vscode.commands.registerCommand('anvil.review.apply', (id?: string) => this.finish(id)),
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  private makeUris(id: string, relPath: string) {
    const p = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    return {
      left: vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${id}/original/${p}` }),
      right: vscode.Uri.from({ scheme: REVIEW_SCHEME, path: `/${id}/proposed/${p}` }),
    };
  }

  /** Opens a diff whose proposed side can be updated while tokens stream in. */
  async openLive(relPath: string, original: string, title: string) {
    const id = `live${++seq}`;
    const { left, right } = this.makeUris(id, relPath);
    this.contents.set(left.toString(), original);
    this.contents.set(right.toString(), original);
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: false, preserveFocus: true });
    let pending: string | undefined;
    let timer: NodeJS.Timeout | undefined;
    return {
      update: (text: string) => {
        pending = text;
        if (timer) return;
        timer = setTimeout(() => {
          timer = undefined;
          if (pending === undefined) return;
          this.contents.set(right.toString(), pending);
          this.changeEmitter.fire(right);
        }, 30);
      },
      close: async () => {
        if (timer) clearTimeout(timer);
        await this.closeTabs(right);
        this.contents.delete(left.toString());
        this.contents.delete(right.toString());
      },
    };
  }

  /** Shows per-hunk review. Resolves with the decision, or null if discarded (cancel). */
  async review(relPath: string, original: string, proposed: string, origin = 'agent'): Promise<ReviewResult | null> {
    const hunks = computeHunks(original, proposed);
    if (hunks.length === 0) {
      return { accepted: [], hunks, original, proposed };
    }
    if (this.autoDecide) {
      const accepted = this.autoDecide(relPath, hunks);
      const id = `r${++seq}`;
      this.infoEmitter.fire({ id, relPath, hunks: hunks.length, accepted: accepted.filter(Boolean).length,
        rejected: accepted.filter((x) => !x).length, status: accepted.some(Boolean) ? 'applied' : 'rejected', origin });
      return { accepted, hunks, original, proposed };
    }
    const id = `r${++seq}`;
    const { left, right } = this.makeUris(id, relPath);
    this.contents.set(left.toString(), original);
    this.contents.set(right.toString(), proposed);
    const s = new ReviewSession(id, relPath, original, proposed, hunks, left, right, origin);
    this.sessions.set(id, s);
    this.fireInfo(s, 'pending');
    await vscode.commands.executeCommand('vscode.diff', left, right,
      `Anvil review: ${relPath} (${hunks.length} hunk${hunks.length === 1 ? '' : 's'})`, { preview: false });
    this.lensEmitter.fire();
    setTimeout(() => this.refreshDecorations(), 150);
    void vscode.window
      .showInformationMessage(`Anvil proposes ${hunks.length} hunk${hunks.length === 1 ? '' : 's'} in ${relPath}. Review each in the diff (CodeLens), or:`,
        'Accept all', 'Reject all')
      .then((choice) => {
        if (s.done) return;
        if (choice === 'Accept all') this.decideAll(id, true);
        else if (choice === 'Reject all') this.decideAll(id, false);
      });
    return s.promise;
  }

  private fireInfo(s: ReviewSession, status: ReviewInfo['status']) {
    this.infoEmitter.fire({
      id: s.id, relPath: s.relPath, hunks: s.hunks.length,
      accepted: s.states.filter((x) => x === 'accepted').length,
      rejected: s.states.filter((x) => x === 'rejected').length,
      status, origin: s.origin,
    });
  }

  private latestId(): string | undefined {
    const ids = [...this.sessions.keys()];
    return ids[ids.length - 1];
  }

  private setState(id: string, i: number, st: HunkState) {
    const s = this.sessions.get(id);
    if (!s || s.done) return;
    s.states[i] = st;
    this.fireInfo(s, 'pending');
    this.lensEmitter.fire();
    this.refreshDecorations();
    if (!s.states.includes('pending')) void this.finish(id);
  }

  private decideAll(id: string | undefined, accept: boolean) {
    const s = this.sessions.get(id ?? this.latestId() ?? '');
    if (!s || s.done) return;
    s.states = s.states.map(() => (accept ? 'accepted' : 'rejected'));
    void this.finish(s.id);
  }

  private async finish(id?: string) {
    const s = this.sessions.get(id ?? this.latestId() ?? '');
    if (!s || s.done) return;
    s.done = true;
    const accepted = s.states.map((x) => x === 'accepted');
    this.fireInfo(s, accepted.some(Boolean) ? 'applied' : 'rejected');
    this.sessions.delete(s.id);
    await this.closeTabs(s.rightUri);
    this.contents.delete(s.leftUri.toString());
    this.contents.delete(s.rightUri.toString());
    this.lensEmitter.fire();
    s.resolve({ accepted, hunks: s.hunks, original: s.original, proposed: s.proposed });
  }

  /** Cancel: discard every open review without applying anything. */
  async discardAll() {
    for (const s of [...this.sessions.values()]) {
      s.done = true;
      this.fireInfo(s, 'discarded');
      this.sessions.delete(s.id);
      await this.closeTabs(s.rightUri);
      s.resolve(null);
    }
    this.lensEmitter.fire();
  }

  get openCount() { return this.sessions.size; }

  private async closeTabs(right: vscode.Uri) {
    const tabs: vscode.Tab[] = [];
    for (const g of vscode.window.tabGroups.all) {
      for (const t of g.tabs) {
        const inp = t.input as any;
        if (inp && ((inp.modified && inp.modified.toString() === right.toString()) || (inp.uri && inp.uri.toString() === right.toString()))) tabs.push(t);
      }
    }
    if (tabs.length) {
      try { await vscode.window.tabGroups.close(tabs, true); } catch { /* tab already gone */ }
    }
  }

  private sessionFor(uri: vscode.Uri): ReviewSession | undefined {
    for (const s of this.sessions.values()) if (s.rightUri.toString() === uri.toString()) return s;
    return undefined;
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    const s = this.sessionFor(doc.uri);
    if (!s) return [];
    const lenses: vscode.CodeLens[] = [];
    const top = new vscode.Range(0, 0, 0, 0);
    const nAcc = s.states.filter((x) => x === 'accepted').length;
    lenses.push(
      new vscode.CodeLens(top, { title: `$(check-all) Apply ${nAcc} accepted hunk${nAcc === 1 ? '' : 's'}`, command: 'anvil.review.apply', arguments: [s.id] }),
      new vscode.CodeLens(top, { title: 'Accept all', command: 'anvil.review.acceptAll', arguments: [s.id] }),
      new vscode.CodeLens(top, { title: 'Reject all', command: 'anvil.review.rejectAll', arguments: [s.id] }),
    );
    for (const h of s.hunks) {
      const line = Math.min(h.newStart, Math.max(doc.lineCount - 1, 0));
      const r = new vscode.Range(line, 0, line, 0);
      const st = s.states[h.index];
      const label = `Hunk ${h.index + 1}/${s.hunks.length} (-${h.removed.length} +${h.added.length})`;
      lenses.push(
        new vscode.CodeLens(r, { title: `${st === 'accepted' ? '$(pass-filled) ' : ''}✓ Accept`, command: 'anvil.review.acceptHunk', arguments: [s.id, h.index] }),
        new vscode.CodeLens(r, { title: `${st === 'rejected' ? '$(error) ' : ''}✗ Reject`, command: 'anvil.review.rejectHunk', arguments: [s.id, h.index] }),
        new vscode.CodeLens(r, { title: `${label} · ${st}`, command: '' }),
      );
    }
    return lenses;
  }

  private refreshDecorations() {
    for (const ed of vscode.window.visibleTextEditors) {
      const s = this.sessionFor(ed.document.uri);
      if (!s) continue;
      const pend: vscode.Range[] = [], acc: vscode.Range[] = [], rej: vscode.Range[] = [];
      for (const h of s.hunks) {
        const start = Math.min(h.newStart, Math.max(ed.document.lineCount - 1, 0));
        const end = h.added.length ? Math.min(h.newStart + h.added.length - 1, ed.document.lineCount - 1) : start;
        const st = s.states[h.index];
        const ranges = st === 'accepted' ? acc : st === 'rejected' ? rej : pend;
        if (st === 'rejected') ranges.push(new vscode.Range(start, 0, end, 0));
        else ranges.push(new vscode.Range(end, 0, end, 0));
      }
      ed.setDecorations(this.decoPending, pend);
      ed.setDecorations(this.decoAccepted, acc);
      ed.setDecorations(this.decoRejected, rej);
    }
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
    this.decoPending.dispose();
    this.decoAccepted.dispose();
    this.decoRejected.dispose();
  }
}
