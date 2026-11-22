// Runs the extension inside a real VS Code (under xvfb-run on Linux) against a workspace.
// env: ANVIL_VSCODE (path to code executable, optional), ANVIL_WS (workspace folder), ANVIL_E2E=1 to also run Task A.
const path = require('path');
const fs = require('fs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, '..');
  const extensionTestsPath = path.resolve(__dirname, 'suite', 'index.js');
  const ws = process.env.ANVIL_WS;
  if (!ws) throw new Error('set ANVIL_WS to the workspace folder');
  const userDir = path.join(process.env.TMPDIR || '/tmp', 'anvil-test-user');
  const extDir = path.join(process.env.TMPDIR || '/tmp', 'anvil-test-exts');
  fs.mkdirSync(path.join(userDir, 'User'), { recursive: true });
  const settings = {};
  if (process.env.ANVIL_MCP_PORT) settings['anvil.mcpPort'] = Number(process.env.ANVIL_MCP_PORT);
  if (process.env.ANVIL_MODELS) settings['anvil.models'] = process.env.ANVIL_MODELS.split(',');
  if (process.env.ANVIL_INLINE_CHAIN) settings['anvil.inlineAgentChain'] = process.env.ANVIL_INLINE_CHAIN.split(',');
  if (process.env.ANVIL_INLINE_AGENT) settings['anvil.inlineAgent'] = process.env.ANVIL_INLINE_AGENT;
  fs.writeFileSync(path.join(userDir, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
  const opts = {
    extensionDevelopmentPath, extensionTestsPath,
    launchArgs: [ws, '--disable-extensions', '--disable-workspace-trust', '--no-sandbox', '--disable-gpu', `--user-data-dir=${userDir}`, `--extensions-dir=${extDir}`],
    extensionTestsEnv: { ...process.env },
  };
  if (process.env.ANVIL_VSCODE) opts.vscodeExecutablePath = process.env.ANVIL_VSCODE;
  else opts.cachePath = path.join(process.env.XDG_CACHE_HOME || '/tmp', 'vscode-test');
  await runTests(opts);
}
main().catch((e) => { console.error('SMOKE FAILED', e); process.exit(1); });
