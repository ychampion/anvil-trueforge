// Stand-in for the Anvil editor MCP server (streamable HTTP, stateless) on 127.0.0.1:7391/mcp.
// Exposes read_file (readOnlyHint), edit_file + run_command (gated by TrueForge), and logs every request's
// headers + JSON-RPC body (to find whether TrueForge passes a tool_call_id) to $MCP_LOG.
import http from 'node:http';
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const LOG = process.env.MCP_LOG || './standin-mcp.log.jsonl';
const files = { 'hello.txt': 'hello\nsecond line\n' };

function build() {
  const s = new McpServer({ name: 'anvil-editor-standin', version: '0.0.1' });
  s.registerTool('read_file', { description: 'Read a workspace file (optionally a line range).', inputSchema: { path: z.string(), start_line: z.number().optional(), end_line: z.number().optional() }, annotations: { readOnlyHint: true } },
    async ({ path }, extra) => ({ content: [{ type: 'text', text: files[path] ?? `ERROR: no such file ${path}` }] }));
  s.registerTool('edit_file', { description: 'Replace old_string with new_string in a file (proposes a diff for review).', inputSchema: { path: z.string(), old_string: z.string(), new_string: z.string() }, annotations: { readOnlyHint: false, destructiveHint: false } },
    async ({ path, old_string, new_string }, extra) => {
      fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), kind: 'edit_file.extra', meta: extra?._meta, requestId: extra?.requestId }) + '\n');
      files[path] = (files[path] || '').replace(old_string, new_string);
      return { content: [{ type: 'text', text: `Applied 1/1 hunks to ${path}.` }] };
    });
  s.registerTool('run_command', { description: 'Run a shell command in the workspace.', inputSchema: { command: z.string() }, annotations: { readOnlyHint: false } },
    async ({ command }) => ({ content: [{ type: 'text', text: `stub ran: ${command}` }] }));
  s.registerTool('find_symbol', { description: 'Find symbol definitions by name.', inputSchema: { name: z.string() }, annotations: { readOnlyHint: true } },
    async ({ name }) => ({ content: [{ type: 'text', text: `no symbols for ${name}` }] }));
  return s;
}

http.createServer(async (req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    let parsed;
    try { parsed = body ? JSON.parse(body) : undefined; } catch {}
    fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), method: req.method, url: req.url, headers: req.headers, body: parsed }) + '\n');
    if (!req.url.startsWith('/mcp')) { res.writeHead(404); return res.end(); }
    if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
    const server = build();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, parsed);
  });
}).listen(Number(process.env.MCP_PORT || 7391), '127.0.0.1', () => console.log('standin MCP on http://127.0.0.1:7391/mcp'));
