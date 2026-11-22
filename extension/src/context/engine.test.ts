// @ts-nocheck -- bun test file; excluded from the extension typecheck (bun:test types are not installed)
// bun test src/context  (FLASK_ROOT defaults to the VPS checkout of pallets/flask 3.1.3; read-only)
import { describe, expect, test, beforeAll } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ContextEngine } from './engine';

const FLASK = process.env.FLASK_ROOT ?? '/mnt/volume_blr1_1795277818626/forgeathon/flask';
const OUT = process.env.CONTEXT_OUT; // optional dir to save rendered packs

export const TASK_A = `Treat the values 'off' and 'n' as false as well, case-insensitively, and update the docstring to list every value that is treated as false.`;
export const TASK_B = `Add a new built-in CLI command flask config that prints the loaded application's configuration as JSON, masking the values of any key containing SECRET, PASSWORD, TOKEN or KEY as "***". It must appear in flask --help, be covered by a test, and be documented alongside the other built-in commands.`;

let engine: ContextEngine;
let indexMs = 0;

beforeAll(async () => {
  engine = new ContextEngine(FLASK);
  const t0 = performance.now();
  await engine.index();
  indexMs = performance.now() - t0;
});

describe('index', () => {
  test('indexes flask in < 2 s', () => {
    const s = engine.stats();
    console.log(`index: ${indexMs.toFixed(0)} ms, ${s.files} files, ${s.chunks} chunks, ${s.symbols} symbols`);
    expect(indexMs).toBeLessThan(2000);
    expect(s.files).toBeGreaterThan(100);
  });
  test('skips junk dirs', () => {
    expect(engine.listAllFiles().some((p) => p.includes('__pycache__') || p.startsWith('.git/'))).toBe(false);
  });
  test('symbols / files autocomplete', () => {
    expect(engine.symbols('get_debug')[0]).toMatchObject({ name: 'get_debug_flag', path: 'src/flask/helpers.py', line: 28, kind: 'function' });
    expect(engine.symbols('FlaskGroup.get_c')[0].name).toBe('FlaskGroup.get_command');
    expect(engine.symbols('routes_command')[0].path).toBe('src/flask/cli.py');
    expect(engine.files('cli')[0]).toBe('src/flask/cli.py');
    expect(engine.files('test_cli')[0]).toBe('tests/test_cli.py');
    expect(engine.findSymbol('cli').some((s) => s.path === 'src/flask/cli.py' && s.kind === 'variable')).toBe(true);
  });
});

describe('Task B retrieval (agent panel, no files named)', () => {
  test('pack has cli.py, tests/test_cli.py and docs/cli.rst with reasons, within 6000 tokens, < 200 ms', async () => {
    const t0 = performance.now();
    const pack = await engine.retrieve(TASK_B, { budgetTokens: 6000 });
    const ms = performance.now() - t0;
    console.log(`Task B retrieve: ${ms.toFixed(1)} ms, ${pack.usedTokens}/${pack.budgetTokens} tok, ${pack.items.length} items`);
    for (const i of pack.items) console.log(`  [${i.source}] ${i.path}:L${i.startLine}-L${i.endLine} (${i.tokens} tok) — ${i.reason}`);
    if (OUT) fs.writeFileSync(path.join(OUT, 'context-taskB.md'), `# Task B context pack\n\nQuery: ${TASK_B}\n\nRetrieve time: ${ms.toFixed(1)} ms\n\n${pack.rendered}\n\n## Items\n${pack.items.map((i) => `- [${i.source}] ${i.path}:L${i.startLine}-L${i.endLine} (${i.tokens} tok) — ${i.reason}`).join('\n')}\n\n## Excluded\n${pack.excluded.map((e) => `- ${e.path}: ${e.reason}`).join('\n')}\n`);
    expect(ms).toBeLessThan(200);
    expect(pack.usedTokens).toBeLessThanOrEqual(6000);
    const paths = pack.items.map((i) => i.path);
    for (const p of ['src/flask/cli.py', 'tests/test_cli.py', 'docs/cli.rst']) expect(paths).toContain(p);
    // the cli.py chunk that registers the built-in commands is in, and says why
    const init = pack.items.find((i) => i.path === 'src/flask/cli.py' && i.reason.includes('FlaskGroup'));
    expect(init).toBeDefined();
    expect(pack.items.find((i) => i.path === 'tests/test_cli.py')!.source).toBe('test-sibling');
    expect(pack.items.find((i) => i.path === 'docs/cli.rst')!.source).toBe('docs-sibling');
    for (const i of pack.items) expect(i.reason.length).toBeGreaterThan(15);
    expect(pack.rendered).toContain('### src/flask/cli.py:L');
    expect(pack.rendered).toMatch(/Context pack — [\d,]+ \/ 6,000 tokens/);
  });
  test('tighter budget degrades to outlines and records exclusions', async () => {
    const pack = await engine.retrieve(TASK_B, { budgetTokens: 1500 });
    expect(pack.usedTokens).toBeLessThanOrEqual(1500);
    expect(pack.items.length).toBeGreaterThan(2);
    expect(pack.excluded.some((e) => /over budget/.test(e.reason))).toBe(true);
  });
});

describe('Task A retrieval (inline edit with selection)', () => {
  test('selection get_debug_flag first, its test next, under budget', async () => {
    const t0 = performance.now();
    const pack = await engine.retrieve(TASK_A, { budgetTokens: 4000, selection: { path: 'src/flask/helpers.py', startLine: 28, endLine: 33 } });
    const ms = performance.now() - t0;
    console.log(`Task A retrieve: ${ms.toFixed(1)} ms, ${pack.usedTokens}/${pack.budgetTokens} tok`);
    for (const i of pack.items) console.log(`  [${i.source}] ${i.path}:L${i.startLine}-L${i.endLine} (${i.tokens} tok) — ${i.reason}`);
    if (OUT) fs.writeFileSync(path.join(OUT, 'context-taskA.md'), `# Task A context pack\n\nInstruction: ${TASK_A}\nSelection: src/flask/helpers.py L28-L33 (get_debug_flag)\n\nRetrieve time: ${ms.toFixed(1)} ms\n\n${pack.rendered}\n\n## Items\n${pack.items.map((i) => `- [${i.source}] ${i.path}:L${i.startLine}-L${i.endLine} (${i.tokens} tok) — ${i.reason}`).join('\n')}\n`);
    expect(ms).toBeLessThan(200);
    const first = pack.items[0];
    expect(first.source).toBe('selection');
    expect(first.path).toBe('src/flask/helpers.py');
    expect(first.startLine).toBeLessThanOrEqual(28);
    expect(first.endLine).toBeGreaterThanOrEqual(33);
    expect(first.reason).toContain('get_debug_flag');
    expect(pack.items.some((i) => i.path === 'tests/test_helpers.py' && i.source === 'test-sibling')).toBe(true);
    expect(pack.usedTokens).toBeLessThanOrEqual(4000);
  });
});

describe('mentions', () => {
  test('@file and @symbol mentions come first', async () => {
    const pack = await engine.retrieve('make this faster', { budgetTokens: 3000, mentions: { files: ['src/flask/config.py'], symbols: ['url_for'] } });
    const srcs = pack.items.slice(0, 3).map((i) => i.source);
    expect(srcs.every((s) => s === 'mention-file' || s === 'mention-symbol')).toBe(true);
    expect(pack.items.some((i) => i.source === 'mention-symbol' && i.reason.includes('url_for'))).toBe(true);
  });
  test('missing mention is reported, not thrown', async () => {
    const pack = await engine.retrieve('x', { budgetTokens: 1000, mentions: { files: ['nope.py'], symbols: ['no_such_symbol_zz'] } });
    expect(pack.excluded.map((e) => e.path)).toContain('nope.py');
  });
});
