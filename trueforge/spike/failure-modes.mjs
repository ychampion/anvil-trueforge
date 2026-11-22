// Measures how TrueForge reports model-endpoint failures: refused port, HTTP 401, HTTP 500.
// Registers temporary providers, runs one inline-spec turn on each, prints timing + turn.done.state, then deletes them.
import http from 'node:http';
import { TrueForge } from '@truefoundry/trueforge-sdk';

const baseUrl = process.env.TRUEFORGE_BASE_URL || 'http://127.0.0.1:8790';
const client = new TrueForge({ baseUrl, timeoutInSeconds: 600 });
const api = (m, p, b) => fetch(baseUrl + '/api/v1' + p, { method: m, headers: { 'content-type': 'application/json' }, body: b && JSON.stringify(b) }).then(async (r) => ({ status: r.status, body: await r.text() }));

let hits = { 401: 0, 500: 0 };
const srv = http.createServer((req, res) => {
  const code = req.url.startsWith('/s401') ? 401 : 500;
  hits[code]++;
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message: code === 401 ? 'Invalid API key' : 'upstream exploded', type: 'error' } }));
}).listen(7397, '127.0.0.1');

const cases = [
  ['fm-refused', 'http://127.0.0.1:7398/v1'],
  ['fm-401', 'http://127.0.0.1:7397/s401/v1'],
  ['fm-500', 'http://127.0.0.1:7397/s500/v1'],
];
for (const [name, base_url] of cases) {
  const r = await api('POST', '/settings/model-providers', { manifest: { type: 'custom', name, base_url, auth: { api_key: 'invalid' }, models: [{ name: 'mm', model_id: 'mm', properties: { context_length: 8192, max_output_tokens: 512 } }] } });
  if (r.status >= 300) console.log(name, 'register', r.status, r.body);
  const t0 = Date.now();
  const { data: s } = await client.sessions.create({ agent: { spec: { model: { name: `${name}/mm` }, instructions: 'x' } } });
  const stream = await client.sessions.createTurnStream(s.id, { input: [{ type: 'user.message', content: 'hi' }] });
  let done;
  for await (const ev of stream) if (ev.type === 'turn.done') done = ev;
  console.log(JSON.stringify({ case: name, ms: Date.now() - t0, state: done?.state, upstreamHits: { ...hits } }));
  await api('DELETE', `/settings/model-providers/${name}`);
}
srv.close();
