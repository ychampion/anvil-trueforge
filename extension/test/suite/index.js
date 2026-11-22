// Executed inside the VS Code extension host by @vscode/test-electron.
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function log(...a) { console.log('[anvil-smoke]', ...a); }

async function run() {
  const results = { ok: true, checks: [] };
  const check = (name, pass, detail) => {
    results.checks.push({ name, pass: !!pass, detail });
    if (!pass) results.ok = false;
    log(pass ? 'PASS' : 'FAIL', name, detail === undefined ? '' : JSON.stringify(detail).slice(0, 500));
  };
  const ext = vscode.extensions.getExtension('anvil.anvil');
  check('extension found', !!ext);
  const api = await ext.activate();
  await Promise.race([api.ready, new Promise((r) => setTimeout(r, 30000))]);
  const cmds = await vscode.commands.getCommands(true);
  for (const c of ['anvil.inlineEdit', 'anvil.openPanel', 'anvil.cancel', 'anvil.undoLast', 'anvil.undoRun', 'anvil.selectModel', 'anvil.openSession']) {
    check(`command ${c} registered`, cmds.includes(c));
  }
  // MCP server answers
  const port = vscode.workspace.getConfiguration('anvil').get('mcpPort') || 7391;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'anvil-smoke', version: '0' } } }),
    });
    const body = await r.text();
    check('MCP server answers initialize on :' + port, r.status === 200 && /serverInfo|protocolVersion/.test(body), { status: r.status, body: body.slice(0, 300) });
    const sid = r.headers.get('mcp-session-id');
    const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (sid) h['mcp-session-id'] = sid;
    await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    const t = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) });
    const tb = await t.text();
    const names = [...tb.matchAll(/"name":"([a-z_]+)"/g)].map((m) => m[1]);
    check('MCP tools/list', t.status === 200 && names.length > 0, names);
  } catch (e) {
    check('MCP server answers on :' + port, false, String(e));
  }

  check('extension MCP server started (api.mcpUrl)', !!api.mcpUrl && api.mcpUrl !== 'stub', api.mcpUrl);
  if (process.env.ANVIL_E2E === '1') {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const rel = 'src/flask/helpers.py';
    const text = fs.readFileSync(path.join(root, rel), 'utf8');
    const lines = text.split('\n');
    const s = lines.findIndex((l) => l.startsWith('def get_debug_flag'));
    let e = s + 1;
    while (e < lines.length && (lines[e].startsWith(' ') || lines[e].trim() === '')) e++;
    while (lines[e - 1].trim() === '') e--;
    log('Task A selection', s + 1, e);
    const t0 = Date.now();
    const res = await vscode.commands.executeCommand('anvil.inlineEdit', {
      path: rel, startLine: s + 1, endLine: e, autoAccept: true,
      instruction: "Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.",
    });
    check('Task A inline edit applied', res && res.applied, { ...res, ms: Date.now() - t0 });
    log('timeline', JSON.stringify(api.timeline));
    try {
      const py = fs.existsSync(path.join(root, '.venv/bin/python')) ? path.join(root, '.venv/bin/python') : 'python3';
      const out = execSync(`${py} -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`, { cwd: root, env: { ...process.env, FLASK_DEBUG: 'off' } }).toString().trim();
      check('Task A: FLASK_DEBUG=off prints False', out === 'False', out);
      const diff = execSync('git diff --stat', { cwd: root }).toString();
      check('Task A: diff touches helpers.py', /helpers\.py/.test(diff), diff);
    } catch (err) { check('Task A python check', false, String(err)); }
  }
  if (process.env.ANVIL_E2E_CANCEL === '1') {
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const f = path.join(root, 'hello.txt');
    fs.writeFileSync(f, 'hello\nsecond line\n');
    // leave the review open (no autoDecide) so the turn is paused, then cancel
    const p = api.runAgent('In hello.txt change the word hello to hello world.');
    await new Promise((r) => setTimeout(r, Number(process.env.ANVIL_CANCEL_AFTER_MS || 2000)));
    const t0 = Date.now();
    await vscode.commands.executeCommand('anvil.cancel');
    const r = await p;
    check('cancel ends the run quickly', r.status === 'cancelled' && Date.now() - t0 < 1500, { ...r, ms: Date.now() - t0 });
    check('cancel leaves file untouched', fs.readFileSync(f, 'utf8') === 'hello\nsecond line\n');
    fs.unlinkSync(f);
  }
  if (process.env.ANVIL_SHOT) {
    await vscode.commands.executeCommand('anvil.openPanel');
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const f = path.join(root, 'hello.txt');
    fs.writeFileSync(f, 'hello\nsecond line\n');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(path.join(root, 'src/flask/cli.py')));
    const p = api.runAgent('In hello.txt change the word hello to hello world. @src/flask/cli.py');
    await new Promise((r) => setTimeout(r, 2500));
    try { execSync(`ffmpeg -y -loglevel error -f x11grab -video_size 1600x1000 -i ${process.env.DISPLAY} -frames:v 1 ${process.env.ANVIL_SHOT}-review.png`); } catch (e) { log('shot failed', String(e)); }
    await vscode.commands.executeCommand('anvil.review.acceptAll');
    await p;
    await new Promise((r) => setTimeout(r, 800));
    try { execSync(`ffmpeg -y -loglevel error -f x11grab -video_size 1600x1000 -i ${process.env.DISPLAY} -frames:v 1 ${process.env.ANVIL_SHOT}-done.png`); } catch (e) { log('shot failed', String(e)); }
    await vscode.commands.executeCommand('anvil.undoRun');
    fs.unlinkSync(f);
  }
  if (process.env.ANVIL_E2E_AGENT === '1') {
    // Agent-mode approval round trip: TrueForge pause -> review (auto-accepted) -> allow -> MCP edit_file -> applyProposal.
    const root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const f = path.join(root, 'hello.txt');
    fs.writeFileSync(f, 'hello\nsecond line\n');
    api.reviews.autoDecide = (_p, hs) => hs.map(() => true);
    const t0 = Date.now();
    const r = await api.runAgent(process.env.ANVIL_AGENT_PROMPT || 'In hello.txt change the word hello to hello world.');
    api.reviews.autoDecide = undefined;
    const after = fs.readFileSync(f, 'utf8');
    check('agent run finished', r.status === 'done', { ...r, ms: Date.now() - t0 });
    log('agent timeline', JSON.stringify(api.timeline));
    check('agent edit applied via approval + MCP', after !== 'hello\nsecond line\n', after);
    await vscode.commands.executeCommand('anvil.undoRun');
    check('undo run restores file', fs.readFileSync(f, 'utf8') === 'hello\nsecond line\n', fs.readFileSync(f, 'utf8'));
    fs.unlinkSync(f);
  }
  const outFile = process.env.ANVIL_TEST_OUT;
  if (outFile) fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  if (!results.ok) throw new Error('smoke checks failed: ' + results.checks.filter((c) => !c.pass).map((c) => c.name).join(', '));
}

module.exports = { run };
