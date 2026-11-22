#!/usr/bin/env node
// Idempotent TrueForge setup for Anvil (no UI clicks). Node 18+, no dependencies.
//
// Registers, via the TrueForge HTTP API (default http://127.0.0.1:8790):
//   - custom model provider `modal`          -> MODAL_LLM_BASE_URL (OpenAI-compatible, e.g. vLLM on Modal)
//   - custom model provider `modal-fallback` -> FALLBACK_LLM_BASE_URL (defaults to the Modal endpoint again)
//   - custom model provider `broken`         -> http://127.0.0.1:9/v1, key "invalid"   (Task C: unreachable model)
//   - MCP connector `anvil-editor`           -> ANVIL_MCP_URL (default http://127.0.0.1:7391/mcp), no auth
//   - saved agents from ./agents/*.json, plus generated variants:
//       <agent>-fallback  (same spec, model modal-fallback/<model>)
//       anvil-inline-broken (anvil-inline on the broken provider, for the Task C demo)
//
// Secrets come from the environment, or from a KEY=VALUE file (ANVIL_SECRETS_FILE, default
// $B/secrets/modal.env, then ./secrets/modal.env). Nothing is hard-coded and nothing is printed.
//   MODAL_LLM_BASE_URL      e.g. https://<workspace>--anvil-vllm-serve.modal.run/v1
//   MODAL_LLM_API_KEY       bearer key the vLLM server expects (optional)
//   MODAL_LLM_MODEL         upstream model id = vLLM --served-model-name (default: qwen3-coder-30b)
//   MODAL_LLM_CONTEXT_LENGTH (default 65536), MODAL_LLM_MAX_OUTPUT_TOKENS (default 16384)
//   FALLBACK_LLM_BASE_URL / FALLBACK_LLM_API_KEY / FALLBACK_LLM_MODEL   (default: same as MODAL_*)
//   STUB_LLM_BASE_URL       used for `modal` when MODAL_LLM_BASE_URL is unset (default http://127.0.0.1:7399/v1)
//   TRUEFORGE_BASE_URL, ANVIL_MCP_URL
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(file) {
  if (!file || !fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}
const secretsCandidates = [
  process.env.ANVIL_SECRETS_FILE,
  process.env.B && path.join(process.env.B, 'secrets/modal.env'),
  '/mnt/volume_blr1_1795277818626/forgeathon/secrets/modal.env',
  path.join(HERE, 'secrets/modal.env'),
].filter(Boolean);
const secretsFile = secretsCandidates.find((f) => loadEnvFile(f));

const env = process.env;
const TF = (env.TRUEFORGE_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/, '') + '/api/v1';
const MCP_URL = env.ANVIL_MCP_URL || 'http://127.0.0.1:7391/mcp';
const MODEL_NAME = 'qwen3-coder-30b'; // TrueForge-side name; FQN = <provider>/qwen3-coder-30b
const STUB_URL = env.STUB_LLM_BASE_URL || 'http://127.0.0.1:7399/v1';
let usingStub = !env.MODAL_LLM_BASE_URL;
const modal = {
  base_url: env.MODAL_LLM_BASE_URL || STUB_URL,
  api_key: env.MODAL_LLM_API_KEY || (usingStub ? 'stub' : ''),
  model_id: env.MODAL_LLM_MODEL || env.MODAL_LLM_MODEL_ID || 'qwen3-coder-30b',
};
let fallback = {
  base_url: env.FALLBACK_LLM_BASE_URL || modal.base_url,
  api_key: env.FALLBACK_LLM_API_KEY || modal.api_key,
  model_id: env.FALLBACK_LLM_MODEL || env.FALLBACK_LLM_MODEL_ID || modal.model_id,
};
const props = {
  context_length: Number(env.MODAL_LLM_CONTEXT_LENGTH || env.MODAL_LLM_CONTEXT || 65536),
  max_output_tokens: Number(env.MODAL_LLM_MAX_OUTPUT_TOKENS || env.MODAL_LLM_MAX_OUTPUT || 16384),
};

async function api(method, p, body) {
  const r = await fetch(TF + p, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = text; }
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status}: ${typeof json === 'string' ? json : JSON.stringify(json)}`);
  return json;
}

/** true when the OpenAI-compatible endpoint answers GET /models with 200 (Modal cold start can take minutes). */
async function probe(cfg) {
  try {
    const r = await fetch(cfg.base_url.replace(/\/$/, '') + '/models', {
      headers: cfg.api_key ? { authorization: `Bearer ${cfg.api_key}` } : {},
      signal: AbortSignal.timeout(Number(env.PROBE_TIMEOUT_MS || 240000)),
    });
    return r.ok;
  } catch {
    return false;
  }
}

function providerManifest(name, cfg, modelName = MODEL_NAME) {
  const m = { type: 'custom', name, base_url: cfg.base_url, models: [{ name: modelName, model_id: cfg.model_id, properties: props }] };
  if (cfg.api_key) m.auth = { api_key: cfg.api_key };
  return m;
}

async function upsertProvider(manifest) {
  const { data } = await api('GET', '/settings/model-providers');
  const exists = data.some((p) => p.name === manifest.name);
  await api(exists ? 'PUT' : 'POST', '/settings/model-providers', { manifest });
  console.log(`model provider ${manifest.name}: ${exists ? 'updated' : 'created'} -> ${manifest.base_url}`);
}

async function upsertMcp(manifest) {
  const { data } = await api('GET', '/settings/mcp-servers');
  const exists = (data || []).some((s) => (s.name || s.manifest?.name) === manifest.name);
  await api(exists ? 'PUT' : 'POST', '/settings/mcp-servers', { manifest });
  console.log(`mcp server ${manifest.name}: ${exists ? 'updated' : 'created'} -> ${manifest.url}`);
}

async function listAgents() {
  const out = [];
  let token;
  do {
    const q = token ? `?page_token=${encodeURIComponent(token)}&limit=100` : '?limit=100';
    const r = await api('GET', '/agents' + q);
    out.push(...r.data);
    token = r.pagination?.next_page_token || r.pagination?.nextPageToken;
  } while (token);
  return out;
}

async function upsertAgent(def, existing) {
  const found = existing.find((a) => a.name === def.name);
  if (found) await api('PUT', `/agents/${found.id}`, { description: def.description, manifest: def.manifest });
  else await api('POST', '/agents', def);
  console.log(`agent ${def.name}: ${found ? 'updated' : 'created'} (model ${def.manifest.model.name})`);
}

function withModel(def, name, description, modelFqn) {
  const copy = JSON.parse(JSON.stringify(def));
  copy.name = name;
  copy.description = description;
  copy.manifest.model.name = modelFqn;
  return copy;
}

async function main() {
  console.log(`TrueForge API: ${TF}`);
  console.log(secretsFile ? `secrets: loaded ${secretsFile}` : 'secrets: none found; using env only');
  if (usingStub) console.log(`MODAL_LLM_BASE_URL not set: provider "modal" points at the stub ${modal.base_url}`);
  else if (!(await probe(modal)) && env.ANVIL_STUB_IF_DOWN !== '0') {
    // Keep the rest of the team unblocked: until the real endpoint answers /models, point at the stub.
    console.log(`WARNING: ${modal.base_url} is not serving (GET /models failed); provider "modal" points at the stub ${STUB_URL}. Re-run when it is live (wait-for-modal.sh does this).`);
    const wasSame = fallback.base_url === modal.base_url;
    Object.assign(modal, { base_url: STUB_URL, api_key: 'stub' });
    if (wasSame) fallback = { ...modal };
    usingStub = true;
  } else console.log(`model endpoint ${modal.base_url} is live`);

  await upsertProvider(providerManifest('modal', modal));
  await upsertProvider(providerManifest('modal-fallback', fallback));
  await upsertProvider(providerManifest('broken', { base_url: 'http://127.0.0.1:9/v1', api_key: 'invalid', model_id: modal.model_id }));

  await upsertMcp({
    type: 'remote',
    name: 'anvil-editor',
    url: MCP_URL,
    description: 'Anvil VS Code editor tools: context retrieval, search, symbol lookup, file reads, reviewed edits, and test commands in the open workspace.',
  });

  const existing = await listAgents();
  const dir = path.join(HERE, 'agents');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const def = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    await upsertAgent(def, existing);
    const model = def.manifest.model.name.split('/').slice(1).join('/');
    await upsertAgent(withModel(def, `${def.name}-fallback`, `${def.description} (fallback model)`, `modal-fallback/${model}`), existing);
    if (def.name === 'anvil-inline')
      await upsertAgent(withModel(def, 'anvil-inline-broken', 'Anvil inline edit pointed at an unreachable model endpoint (Task C resilience demo).', `broken/${model}`), existing);
  }

  const models = await api('GET', '/models');
  console.log('available models: ' + models.data.map((m) => m.name).join(', '));
}

main().catch((e) => {
  console.error('setup failed: ' + e.message);
  process.exit(1);
});
