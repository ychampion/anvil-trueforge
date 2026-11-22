// Spike: drive TrueForge sessions/turns with the TS SDK and capture real event samples.
// Scenarios (argv[2], default "all"): allow | deny | cancel | broken | inline | all
// Writes every non-delta event (and the first few deltas) to $SPIKE_OUT/<scenario>.jsonl.
// Env: TRUEFORGE_BASE_URL (default http://127.0.0.1:8790), SPIKE_OUT (default ./spike-out), SPIKE_PROMPT.
import fs from 'node:fs';
import path from 'node:path';
import { TrueForge, isEventDelta, mergeEventDelta } from '@truefoundry/trueforge-sdk';

const baseUrl = process.env.TRUEFORGE_BASE_URL || 'http://127.0.0.1:8790';
const OUT = process.env.SPIKE_OUT || './spike-out';
fs.mkdirSync(OUT, { recursive: true });
const client = new TrueForge({ baseUrl, timeoutInSeconds: 600 });

function recorder(name) {
  const file = path.join(OUT, name + '.jsonl');
  fs.writeFileSync(file, '');
  let deltas = 0;
  const t0 = Date.now();
  return {
    write(ev, note) {
      if (isEventDelta(ev)) { deltas++; if (deltas > 4) return; }
      fs.appendFileSync(file, JSON.stringify({ ms: Date.now() - t0, note, event: ev }) + '\n');
    },
    get deltas() { return deltas; },
    t0,
  };
}

/** Consume a stream into the id-keyed index; stop at pause (returns 'paused') or turn.done (returns the done event). */
async function consume(stream, st, rec, { cancelAfterMs, onDelta } = {}) {
  let cancelTimer;
  if (cancelAfterMs) cancelTimer = setTimeout(async () => {
    rec.write({ type: 'spike.note', text: 'calling sessions.cancel' }, 'cancel');
    const r = await client.sessions.cancel(st.sessionId);
    rec.write({ type: 'spike.cancel_response', data: r.data }, 'cancel-response');
  }, cancelAfterMs);
  try {
    for await (const ev of stream) {
      st.lastEventId = ev.id;
      rec.write(ev);
      if (ev.type === 'turn.created') st.turnId = ev.turnId;
      if (isEventDelta(ev)) {
        const base = st.events.get(ev.id);
        if (base) mergeEventDelta(base, ev);
        onDelta?.(ev);
      } else st.events.set(ev.id, ev);
      if (ev.type === 'tool.approval_required') st.pending.push(ev);
      if (ev.type === 'turn.update' && ev.state?.status === 'paused') return 'paused';
      if (ev.type === 'turn.done') return ev;
    }
    return 'stream-ended';
  } finally { clearTimeout(cancelTimer); }
}

function resolvePending(st) {
  const calls = [];
  for (const p of st.pending.splice(0)) {
    for (const ref of p.toolCalls) {
      const msg = st.events.get(ref.sourceEventId);
      const call = msg?.toolCalls?.find((tc) => tc.id === ref.id);
      calls.push({ threadId: p.threadId, toolCallId: ref.id, name: call?.toolInfo?.name, server: call?.toolInfo?.serverName, args: call?.function?.arguments, toolInfo: call?.toolInfo });
    }
  }
  return calls;
}

async function runScenario(name, { agent, prompt, decide, cancelAfterMs }) {
  const rec = recorder(name);
  const { data: session } = await client.sessions.create({ agent });
  rec.write({ type: 'spike.session', session }, 'session');
  const st = { sessionId: session.id, events: new Map(), pending: [], turnId: undefined, lastEventId: undefined };
  let firstDeltaMs;
  const stream = await client.sessions.createTurnStream(session.id, { input: [{ type: 'user.message', content: prompt }] });
  let r = await consume(stream, st, rec, { cancelAfterMs, onDelta: () => { firstDeltaMs ??= Date.now() - rec.t0; } });
  const approvals = [];
  for (let round = 0; r === 'paused' && round < 10; round++) {
    const calls = resolvePending(st);
    const evs = calls.map((c) => {
      const d = decide(c);
      approvals.push({ ...c, decision: d });
      return { type: 'user.tool_approval', threadId: c.threadId, toolCallId: c.toolCallId, approval: d };
    });
    rec.write({ type: 'spike.resolved_calls', calls, sending: evs }, 'approval');
    const resume = await client.sessions.subscribeToTurn(session.id, st.turnId, { afterEventId: st.lastEventId }, { timeoutInSeconds: 600 });
    const sent = await client.sessions.createTurnEvents(session.id, st.turnId, { events: evs });
    rec.write({ type: 'spike.createTurnEvents_response', data: sent.data }, 'sent');
    r = await consume(resume, st, rec, { cancelAfterMs });
  }
  const summary = {
    scenario: name, sessionId: session.id, turnId: st.turnId, ms: Date.now() - rec.t0, firstDeltaMs, deltas: rec.deltas,
    end: typeof r === 'string' ? r : r.state, approvals,
    uiUrl: `${baseUrl}/sessions/${session.id}`,
  };
  fs.writeFileSync(path.join(OUT, name + '.summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ...summary, end: typeof r === 'string' ? r : { status: r.state.status, reason: r.state.reason, message: r.state.message } }));
  return summary;
}

const prompt = process.env.SPIKE_PROMPT || 'In hello.txt change the word hello to hello world.';
const scenarios = {
  allow: () => runScenario('allow', { agent: { name: 'anvil-coder' }, prompt, decide: () => ({ status: 'allow' }) }),
  deny: () => runScenario('deny', { agent: { name: 'anvil-coder' }, prompt, decide: () => ({ status: 'deny', reason: 'user rejected all hunks' }) }),
  cancel: () => runScenario('cancel', { agent: { name: 'anvil-coder' }, prompt, decide: () => ({ status: 'allow' }), cancelAfterMs: Number(process.env.CANCEL_MS || 400) }),
  subagent: () => runScenario('subagent', { agent: { name: 'anvil-coder' }, prompt: 'SUBAGENT: find the greeting file.', decide: () => ({ status: 'allow' }) }),
  deferred: () => runScenario('deferred', { agent: { name: 'anvil-coder' }, prompt: 'DEFERRED: run the tests.', decide: () => ({ status: 'allow' }) }),
  bigread: () => runScenario('bigread', { agent: { name: 'anvil-coder' }, prompt: 'BIGREAD: read the core flask modules.', decide: () => ({ status: 'allow' }) }),
  slowcancel: () => runScenario('slowcancel', { agent: { name: 'anvil-coder' }, prompt: 'SLOW: write a lot.', decide: () => ({ status: 'allow' }), cancelAfterMs: 1500 }),
  broken: () => runScenario('broken', { agent: { name: 'anvil-inline-broken' }, prompt: 'Rewrite: x = 1', decide: () => ({ status: 'allow' }) }),
  inline: () => runScenario('inline', { agent: { name: 'anvil-inline' }, prompt: 'Rewrite: x = 1', decide: () => ({ status: 'allow' }) }),
  inlinespec: async () => {
    const found = [];
    for await (const a of await client.agents.list()) if (a.name === 'anvil-inline') found.push(a);
    const spec = JSON.parse(JSON.stringify(found[0].manifest));
    spec.model.name = 'modal-fallback/qwen3-coder-30b';
    return runScenario('inlinespec', { agent: { spec }, prompt: 'Rewrite: x = 1', decide: () => ({ status: 'allow' }) });
  },
};
const which = process.argv[2] || 'all';
for (const k of which === 'all' ? Object.keys(scenarios) : which.split(',')) {
  try { await scenarios[k](); } catch (e) { console.log(JSON.stringify({ scenario: k, error: String(e?.stack || e), body: e?.body })); }
}
