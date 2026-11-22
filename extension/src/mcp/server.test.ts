// @ts-nocheck -- bun test file; excluded from the extension typecheck (bun:test types are not installed)
// bun test src/mcp  (uses the flask checkout read-only + a temp workspace for writes)
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ContextEngine } from '../context/engine';
import { resolveInRoot, startMcpServer } from './server';
import { FakeHost } from './standalone';

const FLASK = process.env.FLASK_ROOT ?? '/mnt/volume_blr1_1795277818626/forgeathon/flask';

type Srv = Awaited<ReturnType<typeof startMcpServer>>;
let flaskSrv: Srv;
let flaskHost: FakeHost;
let client: Client;
let tmpRoot: string;
let tmpSrv: Srv;
let tmpClient: Client;

const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join('\n');

async function connect(url: string): Promise<Client> {
  const c = new Client({ name: 'anvil-test', version: '0' });
  await c.connect(new StreamableHTTPClientTransport(new URL(url)));
  return c;
}

beforeAll(async () => {
  flaskHost = new FakeHost(FLASK, { readOnly: true, quiet: true });
  const engine = new ContextEngine(FLASK);
  await engine.index();
  flaskSrv = await startMcpServer({ port: 0, host: flaskHost, context: engine });
  client = await connect(flaskSrv.url);

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'anvil-mcp-'));
  fs.mkdirSync(path.join(tmpRoot, 'pkg'));
  fs.writeFileSync(path.join(tmpRoot, 'pkg', 'mod.py'), 'def greet(name):\n    """Say hi."""\n    return "hi " + name\n\n\ndef other():\n    return 1\n');
  const tHost = new FakeHost(tmpRoot, { quiet: true });
  const tEngine = new ContextEngine(tmpRoot);
  await tEngine.index();
  tmpSrv = await startMcpServer({ port: 0, host: tHost, context: tEngine });
  tmpClient = await connect(tmpSrv.url);
});

afterAll(async () => {
  await client?.close();
  await tmpClient?.close();
  await flaskSrv?.close();
  await tmpSrv?.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('MCP round-trip (SDK client, stateful session)', () => {
  test('lists all tools with annotations', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(['create_file', 'edit_file', 'find_references', 'find_symbol', 'list_files', 'read_file', 'retrieve_context', 'run_command', 'search']);
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const n of ['read_file', 'search', 'find_symbol', 'find_references', 'list_files', 'retrieve_context']) expect(by[n].annotations?.readOnlyHint).toBe(true);
    for (const n of ['edit_file', 'create_file']) { expect(by[n].annotations?.readOnlyHint).toBe(false); expect(by[n].annotations?.destructiveHint).toBe(false); }
    console.log('tools:', names.join(', '));
  });

  test('search', async () => {
    const r = await client.callTool({ name: 'search', arguments: { pattern: 'def get_debug_flag', path_glob: '*.py' } });
    const t = text(r);
    console.log(t.split('\n').slice(0, 3).join('\n'));
    expect(r.isError).toBeFalsy();
    expect(t).toContain('src/flask/helpers.py:28: def get_debug_flag() -> bool:');
  });

  test('search caps results with a note', async () => {
    const t = text(await client.callTool({ name: 'search', arguments: { pattern: 'import', max_results: 5 } }));
    expect(t).toMatch(/… \d+ more matches/);
  });

  test('read_file with range', async () => {
    const t = text(await client.callTool({ name: 'read_file', arguments: { path: 'src/flask/helpers.py', start_line: 28, end_line: 33 } }));
    expect(t).toContain('28 | def get_debug_flag() -> bool:');
    expect(t).toContain('33 |     return bool(val and val.lower() not in {"0", "false", "no"})');
  });

  test('read_file caps at 400 lines with paging note', async () => {
    const t = text(await client.callTool({ name: 'read_file', arguments: { path: 'src/flask/app.py' } }));
    expect(t).toContain('call read_file again with start_line=401');
  });

  test('find_symbol (index) and find_references', async () => {
    const t = text(await client.callTool({ name: 'find_symbol', arguments: { name: 'get_debug_flag' } }));
    expect(t).toContain('src/flask/helpers.py:28 function');
    const m = text(await client.callTool({ name: 'find_symbol', arguments: { name: 'FlaskGroup.get_command' } }));
    expect(m).toContain('src/flask/cli.py:617 method');
    const refs = text(await client.callTool({ name: 'find_references', arguments: { name: 'get_debug_flag' } }));
    expect(refs).toContain('src/flask/cli.py:24:');
    expect(refs).toContain('tests/test_helpers.py:');
  });

  test('list_files', async () => {
    const t = text(await client.callTool({ name: 'list_files', arguments: { dir: 'src/flask', glob: '*.py' } }));
    expect(t).toContain('cli.py');
    expect(t).not.toContain('__pycache__');
  });

  test('retrieve_context returns pack + chosen list and emits a context event', async () => {
    const before = flaskHost.events.length;
    const t = text(await client.callTool({ name: 'retrieve_context', arguments: { query: 'add a flask config CLI command', budget_tokens: 3000 } }));
    expect(t).toContain('## Context pack');
    expect(t).toContain('Chosen (');
    expect(t).toContain('src/flask/cli.py');
    const ev = flaskHost.events.slice(before);
    expect(ev.some((e) => e.kind === 'context' && (e.data as any)?.items?.length > 0)).toBe(true);
    expect(ev.some((e) => e.kind === 'tool' && e.title.startsWith('retrieve_context('))).toBe(true);
  });

  test('edit_file mismatch quotes the closest lines', async () => {
    const r = await client.callTool({ name: 'edit_file', arguments: { path: 'src/flask/helpers.py', old_string: '    return bool(val and val.lower() not in {"0", "false"})', new_string: 'x' } });
    const t = text(r);
    console.log(t);
    expect(r.isError).toBe(true);
    expect(t).toContain('old_string was not found in src/flask/helpers.py');
    expect(t).toContain('33 |     return bool(val and val.lower() not in {"0", "false", "no"})');
  });

  test('edit_file ambiguous match is rejected', async () => {
    const r = await client.callTool({ name: 'edit_file', arguments: { path: 'src/flask/helpers.py', old_string: 'import', new_string: 'x' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/occurs \d+ times/);
  });

  test('every tool call is emitted', () => {
    const tools = flaskHost.events.filter((e) => e.kind === 'tool');
    expect(tools.length).toBeGreaterThan(8);
    expect(tools.some((e) => e.title.includes('failed'))).toBe(true);
  });
});

describe('path safety', () => {
  test('resolveInRoot rejects escapes', () => {
    expect(() => resolveInRoot(FLASK, '../secrets/x')).toThrow(/outside the workspace/);
    expect(() => resolveInRoot(FLASK, '/etc/passwd')).toThrow(/outside the workspace/);
    expect(() => resolveInRoot(FLASK, 'src/../../x')).toThrow(/outside the workspace/);
    expect(resolveInRoot(FLASK, './src/flask/cli.py').rel).toBe('src/flask/cli.py');
  });
  test('symlink escape rejected', () => {
    const link = path.join(tmpRoot, 'escape');
    try { fs.symlinkSync('/etc', link); } catch { return; }
    expect(() => resolveInRoot(tmpRoot, 'escape/passwd')).toThrow(/outside the workspace/);
  });
  test('tools reject traversal over MCP', async () => {
    for (const [name, args] of [
      ['read_file', { path: '../secrets/x' }],
      ['read_file', { path: '/etc/passwd' }],
      ['edit_file', { path: '../../etc/hosts', old_string: 'a', new_string: 'b' }],
      ['create_file', { path: '../evil.py', content: 'x' }],
      ['list_files', { dir: '..' }],
    ] as const) {
      const r = await client.callTool({ name, arguments: args as any });
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/outside the workspace/);
    }
  });
});

describe('write tools (temp workspace, TEST-ONLY host)', () => {
  test('edit_file applies and reports range; create_file refuses existing', async () => {
    const r = await tmpClient.callTool({ name: 'edit_file', arguments: { path: 'pkg/mod.py', old_string: '    return "hi " + name', new_string: '    return f"hello {name}"' } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toContain('Applied: 1 hunk(s)');
    expect(text(r)).toContain('pkg/mod.py: edit at lines 3-3');
    expect(fs.readFileSync(path.join(tmpRoot, 'pkg/mod.py'), 'utf8')).toContain('hello {name}');
    const sym = text(await tmpClient.callTool({ name: 'find_symbol', arguments: { name: 'greet' } }));
    expect(sym).toContain('pkg/mod.py:1 function');
    const c1 = await tmpClient.callTool({ name: 'create_file', arguments: { path: 'pkg/mod.py', content: 'x' } });
    expect(c1.isError).toBe(true);
    const c2 = await tmpClient.callTool({ name: 'create_file', arguments: { path: 'pkg/new/thing.py', content: 'def fresh():\n    pass\n' } });
    expect(c2.isError).toBeFalsy();
    expect(fs.existsSync(path.join(tmpRoot, 'pkg/new/thing.py'))).toBe(true);
    expect(text(await tmpClient.callTool({ name: 'find_symbol', arguments: { name: 'fresh' } }))).toContain('pkg/new/thing.py:1');
  });
  test('run_command returns exit code and output tail', async () => {
    const t = text(await tmpClient.callTool({ name: 'run_command', arguments: { command: 'echo hello && exit 3' } }));
    expect(t).toContain('exit code 3');
    expect(t).toContain('hello');
  });
});

describe('stateless clients', () => {
  test('tools/call without a session id works', async () => {
    const res = await fetch(flaskSrv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'find_symbol', arguments: { name: 'locate_app' } } }),
    });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).toContain('src/flask/cli.py');
  });
});
