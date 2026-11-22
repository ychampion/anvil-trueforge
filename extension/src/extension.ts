import * as vscode from 'vscode';
import { ContextEngine } from './context/engine';
import { startMcpServer } from './mcp/server';
import { AnvilHost } from './host';
import { ReviewManager } from './review/reviewManager';
import { Checkpoints } from './review/checkpoints';
import { TrueForgeClient } from './trueforge/client';
import { AnvilPanel } from './ui/panel';
import { cfg, runTurn, sessionUrl, timelineLog, targetsFor } from './agentRunner';
import { inlineEdit, InlineArgs } from './inline/inlineEdit';
import { runs } from './run';

export interface AnvilApi {
  host: AnvilHost;
  reviews: ReviewManager;
  context?: ContextEngine;
  mcpUrl?: string;
  ready: Promise<void>;
  timeline: string[];
  /** Test helper: run an agent-panel request and resolve when it ends. */
  runAgent(text: string): Promise<{ status: string; text: string; error?: string }>;
}

export async function activate(ctx: vscode.ExtensionContext): Promise<AnvilApi | undefined> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const root = folder?.uri.fsPath ?? process.cwd();

  // Per-hunk Accept/Reject lives in CodeLens on the review diff, and VS Code hides CodeLens in diff editors by
  // default. Turn it on (user scope, so the reviewed repo's working tree stays untouched).
  const diffCfg = vscode.workspace.getConfiguration('diffEditor');
  if (diffCfg.get<boolean>('codeLens') !== true) {
    void diffCfg.update('codeLens', true, vscode.ConfigurationTarget.Global);
  }

  const reviews = new ReviewManager();
  const checkpoints = new Checkpoints(root);
  const host = new AnvilHost(root, reviews, checkpoints);
  let tf = new TrueForgeClient(cfg().url);
  const context = new ContextEngine(root);
  ctx.subscriptions.push(reviews, host.output);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = 'anvil.selectModel';
  ctx.subscriptions.push(status);
  let connected: boolean | undefined;
  const modelLabel = () => { const t = targetsFor(cfg().agent)[0]; return runs.current?.model ?? (t.model ?? t.agent); };
  const renderStatus = () => {
    if (runs.current) return; // inline edit owns the status bar while running
    status.text = `${connected === false ? '$(debug-disconnect)' : '$(flame)'} Anvil: ${modelLabel()}`;
    status.tooltip = connected === false
      ? `TrueForge not reachable at ${cfg().url}. Start it: npx @truefoundry/trueforge@latest`
      : `TrueForge ${cfg().url} connected. Click to choose the model order.`;
  };
  renderStatus();
  status.show();

  // ---- panel ----
  let agentRunDone: ((r: { status: string; text: string; error?: string }) => void) | undefined;
  const panel: AnvilPanel = new AnvilPanel(ctx.extensionUri, {
    send: (text, mentions) => { void sendAgent(text, mentions); },
    cancel: () => { void vscode.commands.executeCommand('anvil.cancel'); },
    undoRun: () => { void vscode.commands.executeCommand('anvil.undoRun'); },
    undoLast: () => { void vscode.commands.executeCommand('anvil.undoLast'); },
    openSession: () => { void vscode.commands.executeCommand('anvil.openSession'); },
    mentionQuery: (q) => ({ files: context.files(q, 10), symbols: context.symbols(q, 10) }),
  });
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider(AnvilPanel.viewId, panel, { webviewOptions: { retainContextWhenHidden: true } }));
  reviews.onDidUpdateReview((info) => panel.post({ type: 'review', ...info }));
  host.onEvent((e) => panel.post({ type: 'event', kind: e.kind, title: e.title, detail: e.detail }));

  const refreshIndex = (rel: string) => { try { (context as any).refresh?.(rel); } catch { /* best effort */ } };
  checkpoints.onDidChange(() => undefined);

  async function restoreIfCancelled(run: { abort: AbortController; editsApplied: boolean }): Promise<string | undefined> {
    if (!run.abort.signal.aborted || !run.editsApplied && !checkpoints.hasRun) return undefined;
    const files = await checkpoints.undoRun();
    files.forEach(refreshIndex);
    return files.length ? `Restored ${files.length} file(s) to their pre-run state: ${files.join(', ')}` : undefined;
  }

  async function sendAgent(text: string, mentions: { files: string[]; symbols: string[] }) {
    if (runs.current) { void vscode.window.showWarningMessage('Anvil is already running. Cancel it first.'); return; }
    const run = runs.start('agent');
    checkpoints.beginRun();
    panel.post({ type: 'runStart', kind: 'agent', request: text });
    let result: { status: string; text: string; error?: string } = { status: 'error', text: '' };
    try {
      let packText = '';
      try {
        const pack = await context.retrieve(text, { budgetTokens: cfg().budget, mentions });
        packText = pack.rendered;
        panel.post({ type: 'context', pack: { ...pack, rendered: undefined } });
      } catch (e: any) {
        panel.post({ type: 'event', kind: 'context', title: 'Context retrieval failed', detail: String(e?.message ?? e) });
      }
      const message = packText
        ? `${packText}\n\n---\nUser request:\n${text}`
        : text;
      const r = await runTurn({ tf, host, run, agent: cfg().agent, message, sink: panel });
      result = { status: r.status, text: r.text, error: r.error };
      if (r.status === 'cancelled' || run.abort.signal.aborted) {
        const restored = await restoreIfCancelled(run);
        panel.post({ type: 'runEnd', status: 'cancelled', restored });
        result.status = 'cancelled';
      } else if (r.status === 'error') {
        panel.post({ type: 'runEnd', status: 'error', error: r.error });
        void vscode.window.showErrorMessage(`Anvil: ${r.error}`);
      } else {
        const n = checkpoints.runFileCount;
        panel.post({ type: 'runEnd', status: 'done', summary: n ? `Run finished · ${n} file(s) changed. "Undo run" restores them.` : 'Run finished · no files changed.' });
      }
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      result = { status: 'error', text: '', error: msg };
      if (run.abort.signal.aborted) {
        const restored = await restoreIfCancelled(run);
        panel.post({ type: 'runEnd', status: 'cancelled', restored });
      } else {
        panel.post({ type: 'runEnd', status: 'error', error: msg });
      }
    } finally {
      checkpoints.endRun();
      runs.end(run);
      renderStatus();
      agentRunDone?.(result);
    }
  }

  // ---- commands ----
  const reg = (id: string, fn: (...a: any[]) => any) => ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  reg('anvil.openPanel', () => panel.reveal());
  reg('anvil.inlineEdit', (args?: InlineArgs) => inlineEdit({ tf, host, reviews, context, sink: panel, status }, args ?? {}).finally(() => renderStatus()));
  reg('anvil.cancel', async () => {
    const r = runs.current;
    if (!r) { await reviews.discardAll(); return; }
    const p = r.cancel();               // aborts streams immediately, sessions.cancel in background
    await reviews.discardAll();
    status.text = '$(circle-slash) Anvil: cancelled';
    void p;
    if (r.kind === 'inline') {
      // inline flow returns on abort; restore if anything was written
      const restored = await restoreIfCancelled(r);
      if (restored) void vscode.window.setStatusBarMessage(`Anvil: ${restored}`, 5000);
    }
  });
  reg('anvil.undoLast', async () => {
    const c = await checkpoints.undoLast();
    if (!c) { void vscode.window.showInformationMessage('Anvil: nothing to undo.'); return; }
    refreshIndex(c.relPath);
    panel.post({ type: 'event', kind: 'undo', title: `Undid last change to ${c.relPath}` });
    void vscode.window.setStatusBarMessage(`Anvil: undid last change to ${c.relPath}`, 4000);
  });
  reg('anvil.undoRun', async () => {
    const files = await checkpoints.undoRun();
    files.forEach(refreshIndex);
    const msg = files.length ? `Restored ${files.length} file(s): ${files.join(', ')}` : 'Nothing to undo for the last run.';
    panel.post({ type: 'event', kind: 'undo', title: msg });
    void vscode.window.showInformationMessage(`Anvil: ${msg}`);
  });
  reg('anvil.selectModel', async () => {
    const c = vscode.workspace.getConfiguration('anvil');
    let models = (c.get<string[]>('models') ?? []).slice();
    let available: string[] = [];
    try {
      const page: any = await (tf.client as any).models.list();
      const arr = page?.data ?? page;
      if (Array.isArray(arr)) available = arr.map((m: any) => m.fqn ?? m.name ?? m.id).filter(Boolean);
      else for await (const m of page) available.push(m.fqn ?? m.name ?? m.id);
    } catch { /* offline: only configured models */ }
    const all = [...new Set([...models, ...available])];
    if (!all.length) { void vscode.window.showInformationMessage('Anvil: no models configured (anvil.models) and TrueForge lists none.'); return; }
    const pick = await vscode.window.showQuickPick(all.map((m) => ({ label: m, description: models[0] === m ? 'primary' : models.includes(m) ? `fallback ${models.indexOf(m)}` : '' })),
      { title: 'Anvil: choose the primary model (others stay as fallbacks in order)' });
    if (!pick) return;
    models = [pick.label, ...models.filter((m) => m !== pick.label)];
    await c.update('models', models, vscode.ConfigurationTarget.Workspace);
    renderStatus();
  });
  reg('anvil.openSession', () => {
    const id = runs.current?.sessionId ?? runs.lastSessionId;
    if (!id) { void vscode.window.showInformationMessage('Anvil: no TrueForge session yet.'); return; }
    void vscode.env.openExternal(vscode.Uri.parse(sessionUrl(id)));
  });

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('anvil.trueforgeUrl')) tf = new TrueForgeClient(cfg().url);
    if (e.affectsConfiguration('anvil')) renderStatus();
  }));
  ctx.subscriptions.push(vscode.workspace.onDidSaveTextDocument((d) => {
    if (d.uri.scheme === 'file') refreshIndex(host.rel(d.uri.fsPath));
  }));

  // ---- connection polling ----
  const poll = async () => {
    const ok = await tf.ping();
    if (ok !== connected) { connected = ok; renderStatus(); panel.post({ type: 'header', connected: ok }); }
  };
  void poll();
  const timer = setInterval(() => void poll(), 10_000);
  ctx.subscriptions.push({ dispose: () => clearInterval(timer) });

  // ---- background: index + MCP server ----
  let mcpUrl: string | undefined;
  const apiRef: { mcpUrl?: string } = {};
  const ready = (async () => {
    const t0 = Date.now();
    try {
      await context.index();
      panel.post({ type: 'event', kind: 'context', title: `Indexed workspace in ${Date.now() - t0} ms` });
    } catch (e: any) {
      host.output.appendLine(`index failed: ${e?.message ?? e}`);
    }
  })();
  const mcpReady = (async () => {
    try {
      const srv = await startMcpServer({ port: cfg().mcpPort, host, context });
      mcpUrl = srv.url;
      apiRef.mcpUrl = srv.url;
      host.output.appendLine(`Anvil MCP server listening at ${srv.url}`);
      ctx.subscriptions.push({ dispose: () => void srv.close() });
    } catch (e: any) {
      const msg = `Anvil: MCP server failed to start on port ${cfg().mcpPort}: ${e?.message ?? e}`;
      host.output.appendLine(msg);
      void vscode.window.showErrorMessage(msg);
    }
  })();

  const api: AnvilApi = {
    host, reviews, context, get mcpUrl() { return apiRef.mcpUrl ?? mcpUrl; },
    ready: Promise.all([ready, mcpReady]).then(() => undefined),
    timeline: timelineLog,
    runAgent: (text) => new Promise((res) => { agentRunDone = res; void sendAgent(text, { files: [], symbols: [] }); }),
  };
  return api;
}

export function deactivate() {
  const r = runs.current;
  if (r) return r.cancel();
  return undefined;
}
