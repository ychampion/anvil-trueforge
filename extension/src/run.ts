import * as vscode from 'vscode';

export class Run {
  abort = new AbortController();
  sessionId?: string;
  model?: string;
  editsApplied = false;
  private cancellers: (() => Promise<void>)[] = [];
  constructor(public kind: 'agent' | 'inline') {}
  setCanceller(c: () => Promise<void>) { this.cancellers = [c]; }
  async cancel() {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    await Promise.all(this.cancellers.map((c) => c().catch(() => undefined)));
  }
}

class RunRegistry {
  current: Run | undefined;
  private emitter = new vscode.EventEmitter<Run | undefined>();
  readonly onDidChange = this.emitter.event;
  start(kind: 'agent' | 'inline'): Run {
    const r = new Run(kind);
    this.current = r;
    void vscode.commands.executeCommand('setContext', 'anvil.busy', true);
    this.emitter.fire(r);
    return r;
  }
  end(r: Run) {
    if (this.current === r) {
      this.current = undefined;
      void vscode.commands.executeCommand('setContext', 'anvil.busy', false);
      this.emitter.fire(undefined);
    }
  }
  /** Last session id, kept after a run ends for "Open in TrueForge". */
  lastSessionId?: string;
}

export const runs = new RunRegistry();
