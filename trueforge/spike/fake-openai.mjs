// Tiny OpenAI-compatible stub for testing TrueForge without a real model.
// Scripted: 1st call -> tool call read_file, 2nd -> edit_file, then a final streamed text answer.
// Logs every request body to $FAKE_LOG (default ./fake-openai.log.jsonl).
// Usage: node fake-openai.mjs [port=7399]
import http from 'node:http';
import fs from 'node:fs';

const port = Number(process.argv[2] || 7399);
const LOG = process.env.FAKE_LOG || './fake-openai.log.jsonl';
let n = 0;
const BIG_FILES = ['src/flask/app.py', 'src/flask/cli.py', 'src/flask/sansio/app.py', 'src/flask/helpers.py', 'src/flask/ctx.py', 'src/flask/config.py', 'src/flask/sansio/scaffold.py', 'src/flask/json/provider.py'];

function pickToolName(tools, want) {
  const names = (tools || []).map((t) => t.function?.name || t.name).filter(Boolean);
  return names.find((x) => x === want) || names.find((x) => x.endsWith(want)) || null;
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    n++;
    let j = {};
    try { j = JSON.parse(body || '{}'); } catch {}
    fs.appendFileSync(LOG, JSON.stringify({ n, t: new Date().toISOString(), url: req.url, headers: req.headers, body: j }) + '\n');
    if (req.method === 'GET' && req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [{ id: 'qwen3-coder-30b', object: 'model' }] }));
    }
    const msgs = j.messages || [];
    const toolMsgs = msgs.filter((m) => m.role === 'tool').length;
    const sys = msgs.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    const isTitleOrAux = !j.tools || j.tools.length === 0;
    const firstUser = msgs.find((m) => m.role === 'user');
    const userText = typeof firstUser?.content === 'string' ? firstUser.content : JSON.stringify(firstUser?.content || '');
    let plan;
    if (isTitleOrAux) plan = { text: 'Stub title' };
    else if (userText.includes('Return paths only'))
      plan = { text: '- hello.txt: holds the greeting string' };
    else if (userText.includes('SUBAGENT') && toolMsgs === 0 && pickToolName(j.tools, 'create_sub_agent'))
      plan = { text: 'Delegating exploration. ', tool: { name: 'create_sub_agent', args: { name: 'file-finder', input: 'Find files that mention hello. Return paths only, one line reason each.' } } };
    else if (userText.includes('DEFERRED') && toolMsgs === 0)
      plan = { text: 'Discovering tools. ', tool: { name: 'list_tools', args: { mcp_server: 'anvil-editor' } } };
    else if (userText.includes('DEFERRED') && toolMsgs === 1)
      plan = { text: 'Running tests. ', tool: { name: 'call_tool', args: { mcp_server: 'anvil-editor', tool_name: 'run_command', input: { command: 'python -m pytest -q' } } } };
    else if (userText.includes('BIGREAD') && toolMsgs < 14)
      plan = { text: `Reading ${BIG_FILES[toolMsgs % BIG_FILES.length]}. `, tool: { name: pickToolName(j.tools, 'read_file') || 'read_file', args: { path: BIG_FILES[toolMsgs % BIG_FILES.length], start_line: 1 + 400 * Math.floor(toolMsgs / BIG_FILES.length) } } };
    else if (userText.includes('BIGREAD'))
      plan = { text: `Read ${toolMsgs} files; request had ${msgs.length} messages, ${JSON.stringify(msgs).length} chars.` };
    else if (userText.includes('SLOW') && toolMsgs === 0)
      plan = { text: Array.from({ length: 200 }, (_, i) => `token${i}`).join(' '), slow: true };
    else if (userText.includes('SUBAGENT') || userText.includes('DEFERRED'))
      plan = { text: `Done (stub saw ${toolMsgs} tool results).` };
    else if (toolMsgs === 0 && pickToolName(j.tools, 'read_file'))
      plan = { text: 'Reading the file first. ', tool: { name: pickToolName(j.tools, 'read_file'), args: { path: 'hello.txt', start_line: 1, end_line: 5 } } };
    else if (toolMsgs === 1 && pickToolName(j.tools, 'edit_file'))
      plan = { text: 'Files chosen: hello.txt because it holds the greeting. ', tool: { name: pickToolName(j.tools, 'edit_file'), args: { path: 'hello.txt', old_string: 'hello', new_string: 'hello world' } } };
    else plan = { text: `Done. Files changed: hello.txt. (stub saw ${toolMsgs} tool results)` };
    const PT = Math.ceil(JSON.stringify(msgs).length / 4) + Math.ceil(JSON.stringify(j.tools || []).length / 4);
    const id = 'chatcmpl-stub-' + n;
    const model = j.model || 'stub';
    const created = Math.floor(Date.now() / 1000);
    const chunk = (delta, finish = null, extra = {}) => ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra });
    if (j.stream === false) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const message = { role: 'assistant', content: plan.text };
      if (plan.tool) message.tool_calls = [{ id: 'call_' + n, type: 'function', function: { name: plan.tool.name, arguments: JSON.stringify(plan.tool.args) } }];
      return res.end(JSON.stringify({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: plan.tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: PT, completion_tokens: 20, total_tokens: PT + 20 } }));
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const out = [chunk({ role: 'assistant', content: '' })];
    for (const w of plan.text.match(/\S+\s*/g) || []) out.push(chunk({ content: w }));
    if (plan.tool) {
      const a = JSON.stringify(plan.tool.args);
      out.push(chunk({ tool_calls: [{ index: 0, id: 'call_' + n, type: 'function', function: { name: plan.tool.name, arguments: '' } }] }));
      out.push(chunk({ tool_calls: [{ index: 0, function: { arguments: a.slice(0, 10) } }] }));
      out.push(chunk({ tool_calls: [{ index: 0, function: { arguments: a.slice(10) } }] }));
    }
    out.push(chunk({}, plan.tool ? 'tool_calls' : 'stop'));
    out.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: PT, completion_tokens: 20, total_tokens: PT + 20 } });
    let i = 0;
    const tick = () => {
      if (res.destroyed) { fs.appendFileSync(LOG, JSON.stringify({ n, aborted_at_chunk: i }) + '\n'); return; }
      if (i < out.length) { res.write('data: ' + JSON.stringify(out[i++]) + '\n\n'); setTimeout(tick, plan.slow ? 100 : 60); }
      else { res.write('data: [DONE]\n\n'); res.end(); }
    };
    tick();
  });
}).listen(port, '127.0.0.1', () => console.log('fake-openai on http://127.0.0.1:' + port + '/v1'));
