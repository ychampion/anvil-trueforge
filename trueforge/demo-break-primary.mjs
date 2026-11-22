#!/usr/bin/env node
// Task C helper: breaks the PRIMARY model provider ("modal") inside TrueForge, leaving "modal-fallback" intact.
//   node trueforge/demo-break-primary.mjs            # unreachable endpoint (http://127.0.0.1:9/v1)
//   node trueforge/demo-break-primary.mjs --bad-key  # real endpoint, invalid API key
//   node trueforge/setup.mjs                         # restore everything
const TF = (process.env.TRUEFORGE_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/, '') + '/api/v1';
const badKey = process.argv.includes('--bad-key');

async function api(method, p, body) {
  const r = await fetch(TF + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

const { data } = await api('GET', '/settings/model-providers');
const list = Array.isArray(data) ? data : data?.items ?? [];
const current = list.map((x) => x.manifest ?? x).find((m) => m.name === 'modal');
if (!current) throw new Error('provider "modal" not found; run trueforge/setup.mjs first');

const manifest = {
  type: 'custom',
  name: 'modal',
  base_url: badKey ? current.base_url : 'http://127.0.0.1:9/v1',
  auth: { api_key: 'invalid-key-for-task-c' },
  models: current.models,
};
await api('PUT', '/settings/model-providers', { manifest });

const after = await api('GET', '/settings/model-providers');
const rows = (Array.isArray(after.data) ? after.data : after.data?.items ?? []).map((x) => x.manifest ?? x);
console.log(`Primary provider "modal" is now BROKEN (${badKey ? 'invalid API key' : 'unreachable endpoint'}):`);
for (const m of rows) console.log(`  ${m.name.padEnd(15)} ${m.base_url}${m.name === 'modal' ? '   <- broken' : ''}`);
console.log('Restore with: node trueforge/setup.mjs');
