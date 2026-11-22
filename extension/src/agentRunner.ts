import * as vscode from 'vscode';
import { TrueForgeClient, RetryConfig, TurnResult, PendingToolCall, ApprovalDecision } from './trueforge/client';
import { AnvilHost } from './host';
import { Run, runs } from './run';

/** Every timeline line of this window (tests + output channel). */
export const timelineLog: string[] = [];

export type PanelMsg = { type: string; [k: string]: any };
export interface Sink { post(msg: PanelMsg): void; }

export function cfg() {
  const c = vscode.workspace.getConfiguration('anvil');
  return {
    url: c.get<string>('trueforgeUrl') || 'http://localhost:8790',
    uiUrl: c.get<string>('trueforgeUiUrl') || '',
    agent: c.get<string>('agent') || 'anvil-coder',
    inlineAgent: c.get<string>('inlineAgent') || 'anvil-inline',
    models: (c.get<string[]>('models') ?? []).filter(Boolean),
    agentChain: (c.get<string[]>('agentChain') ?? []).filter(Boolean),
    inlineAgentChain: (c.get<string[]>('inlineAgentChain') ?? []).filter(Boolean),
    retry: { attempts: 2, backoffMs: 800, factor: 2, ...(c.get<RetryConfig>('retry') ?? {}) } as RetryConfig,
    budget: c.get<number>('contextBudgetTokens') ?? 6000,
    mcpPort: c.get<number>('mcpPort') ?? 7391,
  };
}

export function summarizeArgs(name: string, a: any): string {
  if (!a || typeof a !== 'object') return '';
  if (a.path && name === 'edit_file') return `${a.path}`;
  if (a.path) return String(a.path);
  if (a.command) return String(a.command);
  if (a.query) return `"${a.query}"`;
  if (a.pattern) return `/${a.pattern}/`;
  const s = JSON.stringify(a);
  return s.length > 120 ? s.slice(0, 120) + '…' : s;
}

/** Runs one agent turn with retry/fallback, wiring events to the sink and approvals to the host. */
export async function runTurn(opts: {
  tf: TrueForgeClient; host: AnvilHost; run: Run; agent: string; message: string; sink: Sink;
  onText?: (delta: string, all: string) => void; onReset?: () => void;
}): Promise<TurnResult> {
  const { tf, host, run, sink } = opts;
  const c = cfg();
  let all = '';
  const toolNames = new Map<string, string>();
  return tf.runResilient({
    targets: targetsFor(opts.agent),
    message: opts.message,
    retry: c.retry,
    signal: run.abort.signal,
    setCanceller: (cc) => run.setCanceller(cc),
    handlers: {
      onText: (d, threadId) => {
        if ((threadId ?? 'main') !== 'main') { sink.post({ type: 'subText', threadId, delta: d }); return; }
        all += d;
        sink.post({ type: 'text', delta: d });
        opts.onText?.(d, all);
      },
      onEvent: (ev) => {
        if (ev.type === 'thread.created') sink.post({ type: 'event', kind: 'subagent', title: `Subagent: ${ev.title ?? ev.threadId}`, detail: ev.agentInfo?.input ? String(ev.agentInfo.input).slice(0, 300) : undefined });
        if (ev.type === 'thread.done') {
          const out = ev.state?.output?.content;
          sink.post({ type: 'event', kind: 'subagent', title: `Subagent ${ev.threadId} ${ev.state?.status ?? 'done'}`, detail: typeof out === 'string' ? out.slice(0, 400) : ev.state?.error ? String(ev.state.error) : undefined });
        }
        if (ev.type === 'model.message' && ev.usage?.inputTokens) sink.post({ type: 'usage', usage: ev.usage });
        if (ev.type === 'turn.update' && ev.state?.status) sink.post({ type: 'status', text: ev.state.status === 'paused' ? 'waiting for your review' : 'running' });
        if (/compact/i.test(ev.type)) {
          const started = /started/.test(ev.type);
          const d: any = ev;
          const det = [d.tokensBefore ?? d.inputTokensBefore, d.tokensAfter ?? d.inputTokensAfter].filter((x) => x != null).join(' → ');
          sink.post({ type: 'event', kind: 'compaction', title: started ? 'TrueForge is compacting the context…' : 'TrueForge compacted the context', detail: det ? `${det} tokens` : undefined });
        }
      },
      onToolCall: (call) => {
        toolNames.set(call.id, call.name);
        sink.post({ type: 'toolCall', id: call.id, name: call.name, server: call.server, summary: summarizeArgs(call.name, call.args) });
      },
      onToolResult: (id, content) => {
        sink.post({ type: 'toolResult', id, name: toolNames.get(id), summary: content.length > 300 ? content.slice(0, 300) + '…' : content });
      },
      onApproval: async (calls: PendingToolCall[]): Promise<ApprovalDecision[]> => {
        const out: ApprovalDecision[] = [];
        for (const call of calls) {
          if (run.abort.signal.aborted) { out.push({ status: 'deny', reason: 'cancelled' }); continue; }
          sink.post({ type: 'approval', id: call.id, name: call.name, summary: summarizeArgs(call.name, call.args) });
          const d = await host.decide(call);
          sink.post({ type: 'approvalResult', id: call.id, name: call.name, status: d.status, reason: (d as any).reason });
          out.push(d);
        }
        return out;
      },
      onTimeline: (e) => { timelineLog.push(e.text); host.output.appendLine(`[timeline] ${e.text}`); sink.post({ type: 'timeline', kind: e.kind, text: e.text }); },
      onSession: (id, model) => {
        run.sessionId = id; run.model = model; runs.lastSessionId = id;
        sink.post({ type: 'session', id, model, url: sessionUrl(id) });
      },
      editsApplied: () => run.editsApplied,
      onAttemptReset: () => { all = ''; sink.post({ type: 'resetText' }); opts.onReset?.(); },
    },
  });
}

/** Ordered (agent, model) attempts: the agent chain if set for this agent kind, else the model list, else the agent alone. */
export function targetsFor(agent: string): { agent: string; model?: string }[] {
  const c = cfg();
  const chain = agent === c.inlineAgent ? c.inlineAgentChain : agent === c.agent ? c.agentChain : [];
  if (chain.length) return chain.map((a) => ({ agent: a }));
  if (c.models.length) return c.models.map((m) => ({ agent, model: m }));
  return [{ agent }];
}

export function sessionUrl(id: string): string {
  const c = cfg();
  const base = (c.uiUrl || c.url).replace(/\/+$/, '');
  return `${base}/sessions/${id}`;
}
