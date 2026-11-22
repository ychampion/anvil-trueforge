import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

export interface RetryConfig { attempts: number; backoffMs: number; factor: number; }

export interface PendingToolCall {
  id: string;
  threadId: string | null;
  /** The real tool name (MCP tool name, unwrapped from deferred call_tool). */
  name: string;
  server?: string;
  args: any;
  rawName: string;
}

export type ApprovalDecision = { status: 'allow' } | { status: 'deny'; reason: string };

export interface TimelineEntry { kind: 'start' | 'fail' | 'retry' | 'fallback' | 'ok' | 'give-up'; model: string; text: string; }

export interface TurnHandlers {
  onText?(delta: string, threadId: string | null): void;
  onEvent?(ev: any): void;
  onToolCall?(call: PendingToolCall, eventId: string): void;
  onToolResult?(toolCallId: string, content: string): void;
  onApproval(calls: PendingToolCall[]): Promise<ApprovalDecision[]>;
  onTimeline?(e: TimelineEntry): void;
  onSession?(sessionId: string, model: string): void;
  /** True once any edit was written to the workspace in this run (disables retry/fallback). */
  editsApplied?(): boolean;
  /** Called before a retry/fallback attempt starts (e.g. to clear partial streamed text). */
  onAttemptReset?(): void;
}

export interface TurnResult {
  status: 'done' | 'cancelled' | 'error';
  text: string;
  error?: string;
  sessionId?: string;
  model: string;
}

export class TrueForgeUnreachable extends Error {}

/** Iterate a stream but stop immediately when the signal aborts (cancel must be instant in the UI). */
async function* abortable<T>(it: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  if (signal.aborted) return;
  const iter = it[Symbol.asyncIterator]();
  const abortP = new Promise<'abort'>((res) => signal.addEventListener('abort', () => res('abort'), { once: true }));
  for (;;) {
    const r = await Promise.race([iter.next(), abortP]);
    if (r === 'abort') { void iter.return?.(undefined)?.catch?.(() => undefined); return; }
    if (r.done) return;
    yield r.value;
  }
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true });
  });

function errText(e: any): string {
  if (!e) return 'unknown error';
  const body = e.body ?? e.rawResponse;
  const cause = e.cause?.code || e.cause?.message;
  let s = e.message || String(e);
  if (body && typeof body === 'object') {
    try { s += ' ' + JSON.stringify(body).slice(0, 300); } catch { /* ignore */ }
  }
  if (cause && !s.includes(cause)) s += ` (${cause})`;
  return s.replace(/\s+/g, ' ').trim();
}

function isConnErr(e: any): boolean {
  const t = `${e?.message ?? ''} ${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''} ${e?.code ?? ''}`;
  return /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed|socket hang up|ECONNRESET|Timeout/i.test(t);
}

export function unwrapToolCall(call: any): { name: string; server?: string; args: any } {
  let args: any = {};
  try { args = JSON.parse(call?.function?.arguments || '{}'); } catch { args = {}; }
  const info = call?.toolInfo ?? {};
  if (info.type === 'mcp') return { name: info.name ?? call.function?.name, server: info.serverName, args };
  const n = info.name ?? call?.function?.name;
  if (n === 'call_tool' && args && args.tool_name) {
    let inner = args.arguments ?? args.args ?? args.tool_args ?? args.input ?? args.parameters ?? {};
    if (typeof inner === 'string') { try { inner = JSON.parse(inner); } catch { /* leave */ } }
    return { name: args.tool_name, server: args.mcp_server, args: inner };
  }
  return { name: n, args };
}

export class TrueForgeClient {
  client: TrueForge;
  private specCache = new Map<string, any>();

  constructor(public baseUrl: string) {
    this.client = new TrueForge({ baseUrl, timeoutInSeconds: 600 } as any);
  }

  async ping(): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 2500);
      const r = await fetch(this.baseUrl.replace(/\/+$/, '') + '/', { signal: ctl.signal });
      clearTimeout(t);
      return r.status < 500;
    } catch { return false; }
  }

  async cancel(sessionId: string) {
    try { await this.client.sessions.cancel(sessionId); } catch { /* idempotent */ }
  }

  private async agentSpec(name: string): Promise<any> {
    if (this.specCache.has(name)) return this.specCache.get(name);
    let agent: any;
    try {
      agent = (await this.client.agents.get(name)).data;
    } catch {
      const page = await this.client.agents.list();
      for await (const a of page as any) { if (a.name === name) { agent = a; break; } }
    }
    if (!agent?.manifest) throw new Error(`agent '${name}' not found in TrueForge`);
    this.specCache.set(name, agent.manifest);
    return agent.manifest;
  }

  /** Creates a session for the saved agent; if `model` is set, runs the saved definition with the model swapped. */
  async createSession(agentName: string, model?: string): Promise<{ id: string; model: string }> {
    try {
      if (!model) {
        const { data } = await this.client.sessions.create({ agent: { name: agentName } } as any);
        let m = 'agent default';
        try { m = (await this.agentSpec(agentName)).model?.name ?? m; } catch { /* informational only */ }
        return { id: (data as any).id, model: m };
      }
      const spec = JSON.parse(JSON.stringify(await this.agentSpec(agentName)));
      spec.model = { ...(spec.model ?? {}), name: model };
      const { data } = await this.client.sessions.create({ agent: { spec } } as any);
      return { id: (data as any).id, model };
    } catch (e: any) {
      if (isConnErr(e)) throw new TrueForgeUnreachable(errText(e));
      throw e;
    }
  }

  /** One turn on one session, handling approval pauses. Throws on stream errors. */
  async runOnce(sessionId: string, message: string, h: TurnHandlers, signal: AbortSignal,
    onSessionCancelHook: (cancel: () => Promise<void>) => void): Promise<TurnResult & { sawOutput: boolean }> {
    const events = new Map<string, any>();
    let turnId: string | undefined;
    let lastEventId: string | undefined;
    let text = '';
    let sawOutput = false;
    const seenToolCalls = new Set<string>();
    onSessionCancelHook(() => this.cancel(sessionId));

    let stream: AsyncIterable<any> = await this.client.sessions.createTurnStream(sessionId, {
      input: [{ type: 'user.message', content: message }],
    } as any);

    for (;;) {
      const pending: any[] = [];
      let paused = false;
      let final: any;
      for await (const ev of abortable(stream, signal)) {
        if (ev?.id) lastEventId = ev.id;
        if (ev.type === 'turn.created') turnId = ev.turnId;
        if (isEventDelta(ev)) {
          const base = events.get(ev.id);
          if (base) mergeEventDelta(base, ev);
          if (typeof ev.content === 'string' && ev.content) {
            sawOutput = true;
            if ((ev.threadId ?? 'main') === 'main') text += ev.content;
            h.onText?.(ev.content, ev.threadId ?? null);
          }
          continue;
        }
        events.set(ev.id, ev);
        h.onEvent?.(ev);
        if (ev.type === 'model.message') {
          if (ev.content) {
            // Non-streamed full content (e.g. replay): emit whatever we haven't seen.
            sawOutput = true;
          }
        }
        if (ev.type === 'tool.response') h.onToolResult?.(ev.toolCallId, typeof ev.content === 'string' ? ev.content : JSON.stringify(ev.content));
        if (ev.type === 'tool.approval_required') pending.push(ev);
        if (ev.type === 'turn.update' && ev.state?.status === 'paused') { paused = true; break; }
        if (ev.type === 'turn.done') { final = ev; break; }
        // Surface tool calls as soon as their message is complete.
        this.surfaceToolCalls(events, seenToolCalls, h);
      }
      this.surfaceToolCalls(events, seenToolCalls, h);

      if (final) {
        const st = final.state ?? {};
        if (st.status === 'done') {
          const out = st.output?.content;
          return { status: 'done', text: text || (typeof out === 'string' ? out : ''), sessionId, model: '', sawOutput };
        }
        if (st.status === 'cancelled') return { status: 'cancelled', text, sessionId, model: '', sawOutput, error: st.reason };
        return { status: 'error', text, sessionId, model: '', sawOutput, error: st.message ?? 'turn ended in error' };
      }
      if (!paused) {
        if (signal.aborted) return { status: 'cancelled', text, sessionId, model: '', sawOutput };
        throw new Error('stream ended without turn.done');
      }
      // Paused: collect pending approvals.
      const calls: PendingToolCall[] = [];
      for (const p of pending) {
        for (const ref of p.toolCalls ?? []) {
          const msg = events.get(ref.sourceEventId);
          const call = msg?.toolCalls?.find((tc: any) => tc.id === ref.id);
          const u = unwrapToolCall(call);
          calls.push({ id: ref.id, threadId: p.threadId ?? 'main', name: u.name, server: u.server, args: u.args, rawName: call?.function?.name ?? u.name });
        }
      }
      if (signal.aborted) return { status: 'cancelled', text, sessionId, model: '', sawOutput };
      const decisions = calls.length ? await h.onApproval(calls) : [];
      if (signal.aborted) return { status: 'cancelled', text, sessionId, model: '', sawOutput };
      const resume = await this.client.sessions.subscribeToTurn(sessionId, turnId!, { afterEventId: lastEventId } as any, { timeoutInSeconds: 600 } as any);
      await this.client.sessions.createTurnEvents(sessionId, turnId!, {
        events: calls.map((c, i) => ({
          type: 'user.tool_approval',
          threadId: c.threadId,
          toolCallId: c.id,
          approval: decisions[i] ?? { status: 'deny', reason: 'no decision' },
        })),
      } as any);
      stream = resume as any;
    }
  }

  private surfaceToolCalls(events: Map<string, any>, seen: Set<string>, h: TurnHandlers) {
    for (const ev of events.values()) {
      if (ev.type !== 'model.message' || !ev.toolCalls || ev.finishReason == null) continue;
      for (const tc of ev.toolCalls) {
        if (!tc?.id || seen.has(tc.id)) continue;
        seen.add(tc.id);
        const u = unwrapToolCall(tc);
        h.onToolCall?.({ id: tc.id, threadId: ev.threadId ?? 'main', name: u.name, server: u.server, args: u.args, rawName: tc.function?.name ?? u.name }, ev.id);
      }
    }
  }

  /**
   * Runs a turn with retry + automatic model fallback. models: ordered FQNs (empty = agent default only).
   * Retries and fallbacks happen only while no edit has been applied.
   */
  async runResilient(opts: {
    targets: { agent: string; model?: string }[]; message: string; retry: RetryConfig; handlers: TurnHandlers; signal: AbortSignal;
    setCanceller: (c: () => Promise<void>) => void;
  }): Promise<TurnResult> {
    const { message, retry, handlers: h, signal } = opts;
    const targets = opts.targets;
    const multiAgent = new Set(targets.map((t) => t.agent)).size > 1;
    let lastErr = '';
    for (let mi = 0; mi < targets.length; mi++) {
      const { agent, model } = targets[mi];
      let label = model ?? agent;
      for (let attempt = 0; attempt <= retry.attempts; attempt++) {
        if (signal.aborted) return { status: 'cancelled', text: '', model: label };
        if (attempt > 0 || mi > 0) h.onAttemptReset?.();
        let sessionId: string | undefined;
        try {
          const s = await this.createSession(agent, model);
          sessionId = s.id;
          label = multiAgent ? `${agent} (${s.model})` : s.model;
          h.onSession?.(s.id, label);
          h.onTimeline?.({ kind: 'start', model: s.model, text: `${mi === 0 ? 'Primary' : 'Fallback'} \`${label}\`${attempt ? ` · attempt ${attempt + 1}` : ''}` });
          const r = await this.runOnce(s.id, message, h, signal, opts.setCanceller);
          if (r.status === 'done') {
            h.onTimeline?.({ kind: 'ok', model: s.model, text: `\`${label}\` completed` });
            return { ...r, model: label };
          }
          if (r.status === 'cancelled') return { ...r, model: s.model };
          lastErr = r.error ?? 'error';
        } catch (e: any) {
          if (signal.aborted) return { status: 'cancelled', text: '', model: label, sessionId };
          if (e instanceof TrueForgeUnreachable) {
            h.onTimeline?.({ kind: 'give-up', model: label, text: `TrueForge unreachable at ${this.baseUrl}` });
            return { status: 'error', model: label, text: '', error:
              `TrueForge is not reachable at ${this.baseUrl}. Start it with: npx @truefoundry/trueforge@latest  (then run the agent registration script in trueforge/).` };
          }
          lastErr = errText(e);
        }
        if (signal.aborted) return { status: 'cancelled', text: '', model: label, sessionId };
        const short = lastErr.length > 160 ? lastErr.slice(0, 160) + '…' : lastErr;
        h.onTimeline?.({ kind: 'fail', model: label, text: `${mi === 0 ? 'Primary' : 'Fallback'} \`${label}\` failed: ${short}` });
        if (h.editsApplied?.()) {
          return { status: 'error', model: label, text: '', sessionId,
            error: `Model \`${label}\` failed after edits were applied; not retrying (use "Undo run" to revert). ${short}` };
        }
        if (attempt < retry.attempts) {
          const wait = retry.backoffMs * Math.pow(retry.factor, attempt);
          h.onTimeline?.({ kind: 'retry', model: label, text: `retry ${attempt + 1}/${retry.attempts} in ${(wait / 1000).toFixed(1)} s` });
          await sleep(wait, signal);
        }
      }
      if (mi + 1 < targets.length) {
        const nx = targets[mi + 1];
        const nl = nx.model ?? nx.agent;
        h.onTimeline?.({ kind: 'fallback', model: nl, text: `falling back to \`${nl}\`` });
      }
    }
    h.onTimeline?.({ kind: 'give-up', model: '', text: 'every configured model failed; workspace untouched' });
    return { status: 'error', model: '', text: '', error: `All configured models failed. Last error: ${lastErr}. No files were changed.` };
  }
}
