import * as vscode from 'vscode';
import { AnvilHost } from '../host';
import { ReviewManager } from '../review/reviewManager';
import { TrueForgeClient } from '../trueforge/client';
import { cfg, runTurn, Sink } from '../agentRunner';
import { runs } from '../run';
import { splitLines } from '../review/hunks';

export interface InlineArgs { instruction?: string; path?: string; startLine?: number; endLine?: number; autoAccept?: boolean; }
export interface InlineResult { status: string; applied: boolean; acceptedHunks: number; rejectedHunks: number; error?: string; text?: string; }

export interface ContextLike { retrieve(q: string, o: any): Promise<any>; }

/** Expand an empty selection to the enclosing function/class (symbol provider, else indentation). */
async function enclosingRange(doc: vscode.TextDocument, line: number): Promise<{ start: number; end: number }> {
  try {
    const syms = (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>('vscode.executeDocumentSymbolProvider', doc.uri)) ?? [];
    let best: vscode.DocumentSymbol | undefined;
    const walk = (list: vscode.DocumentSymbol[]) => {
      for (const s of list) {
        if (!s.range || s.range.start.line > line || s.range.end.line < line) continue;
        if ([vscode.SymbolKind.Function, vscode.SymbolKind.Method].includes(s.kind)) best = s;
        if (s.children?.length) walk(s.children);
      }
    };
    walk(syms);
    if (best) return { start: best.range.start.line, end: best.range.end.line };
  } catch { /* no symbol provider */ }
  const lines = doc.getText().split('\n');
  const indent = (s: string) => s.length - s.trimStart().length;
  let start = line;
  for (let i = line; i >= 0; i--) {
    if (/^\s*(async\s+def|def|function|async\s+function|class)\b/.test(lines[i]) ||
      /^\s*(export\s+)?(async\s+)?function\b/.test(lines[i])) { start = i; break; }
  }
  // include decorators
  while (start > 0 && /^\s*@/.test(lines[start - 1])) start--;
  const base = indent(lines[start]);
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') continue;
    if (indent(lines[i]) <= base && !/^\s*[)\]}]/.test(lines[i])) break;
    end = i;
  }
  return { start, end };
}

/** Extract the replacement from a (possibly partial) fenced block. */
export function extractFenced(text: string, final: boolean): string | undefined {
  const open = text.match(/```[^\n]*\n/);
  if (!open || open.index === undefined) return undefined;
  const rest = text.slice(open.index + open[0].length);
  const close = rest.search(/(^|\n)```/);
  if (close >= 0) return rest.slice(0, close + (rest[close] === '\n' ? 1 : 0));
  // partial: hide a trailing partial fence
  return rest.replace(/\n`{1,3}$/, '\n');
}

function stripLineNumbers(s: string): string {
  const ls = s.split('\n');
  const nonEmpty = ls.filter((l) => l.trim());
  if (nonEmpty.length && nonEmpty.every((l) => /^\s*\d+\s*[|:]\s?/.test(l))) return ls.map((l) => l.replace(/^\s*\d+\s*[|:]\s?/, '')).join('\n');
  return s;
}

export async function inlineEdit(deps: { tf: TrueForgeClient; host: AnvilHost; reviews: ReviewManager; context?: ContextLike; sink: Sink; status: vscode.StatusBarItem },
  args: InlineArgs = {}): Promise<InlineResult> {
  const { tf, host, reviews, sink } = deps;
  if (runs.current) {
    void vscode.window.showWarningMessage('Anvil is already running. Cancel it first (Esc).');
    return { status: 'busy', applied: false, acceptedHunks: 0, rejectedHunks: 0 };
  }
  let editor = vscode.window.activeTextEditor;
  if (args.path) {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(host.checkpoints.abs(args.path)));
    editor = await vscode.window.showTextDocument(doc);
  }
  if (!editor) { void vscode.window.showErrorMessage('Anvil: open a file and select code first.'); return { status: 'no-editor', applied: false, acceptedHunks: 0, rejectedHunks: 0 }; }
  const doc = editor.document;
  let startLine: number, endLine: number;
  if (args.startLine !== undefined && args.endLine !== undefined) { startLine = args.startLine - 1; endLine = args.endLine - 1; }
  else if (editor.selection.isEmpty) { ({ start: startLine, end: endLine } = await enclosingRange(doc, editor.selection.active.line)); }
  else {
    startLine = editor.selection.start.line;
    endLine = editor.selection.end.line;
    if (editor.selection.end.character === 0 && endLine > startLine) endLine--;
  }
  editor.selection = new vscode.Selection(startLine, 0, endLine, doc.lineAt(endLine).text.length);

  const instruction = args.instruction ?? await vscode.window.showInputBox({
    title: 'Anvil inline edit', prompt: `Edit lines ${startLine + 1}-${endLine + 1}`, placeHolder: 'Describe the change', ignoreFocusOut: true,
  });
  if (!instruction) return { status: 'no-instruction', applied: false, acceptedHunks: 0, rejectedHunks: 0 };

  const relPath = host.rel(doc.uri.fsPath);
  const original = doc.getText();
  const lines = splitLines(original);
  const before = lines.slice(0, startLine).join('');
  const selected = lines.slice(startLine, endLine + 1).join('');
  const after = lines.slice(endLine + 1).join('');
  const numbered = selected.replace(/\n$/, '').split('\n').map((l, i) => `${String(startLine + 1 + i).padStart(4)}| ${l}`).join('\n');
  const ctxBefore = lines.slice(Math.max(0, startLine - 15), startLine).join('');
  const ctxAfter = lines.slice(endLine + 1, endLine + 16).join('');

  let packText = '';
  if (deps.context) {
    try {
      const pack = await deps.context.retrieve(instruction, { budgetTokens: 2000, selection: { path: relPath, startLine: startLine + 1, endLine: endLine + 1 } });
      packText = pack?.rendered ?? '';
      sink.post({ type: 'context', pack: { ...pack, rendered: undefined } });
    } catch (e: any) { host.emit({ kind: 'context', title: 'context retrieval failed', detail: String(e?.message ?? e) }); }
  }
  const lang = doc.languageId;
  const message = [
    `Instruction: ${instruction}`,
    '',
    `<selection path="${relPath}" lines="${startLine + 1}-${endLine + 1}" language="${lang}">`,
    selected.replace(/\n$/, ''),
    '</selection>',
    '',
    'Selected lines with line numbers (reference only; never output the numbers):',
    numbered,
    '',
    '<before_selection>', ctxBefore.replace(/\n$/, ''), '</before_selection>',
    '<after_selection>', ctxAfter.replace(/\n$/, ''), '</after_selection>',
    packText ? `\n<repository_context>\n${packText}\n</repository_context>` : '',
    '',
    `Reply with ONLY the complete replacement for lines ${startLine + 1}-${endLine + 1} of ${relPath} in a single fenced \`\`\`${lang} block, preserving indentation. No explanation.`,
  ].join('\n');

  const run = runs.start('inline');
  host.checkpoints.beginRun();
  sink.post({ type: 'runStart', kind: 'inline', request: `Inline: ${instruction}`, file: relPath });
  const status = deps.status;
  const prevText = status.text, prevCmd = status.command, prevTip = status.tooltip;
  status.text = '$(sync~spin) Anvil: streaming edit… (Esc to cancel)';
  status.command = 'anvil.cancel';
  status.tooltip = 'Click to cancel';
  const live = await reviews.openLive(relPath, original, `Anvil (streaming): ${relPath}`);
  let resultText = '';
  try {
    const r = await runTurn({
      tf, host, run, agent: cfg().inlineAgent, message, sink,
      onText: (_d, all) => {
        const part = extractFenced(all, false);
        if (part !== undefined) live.update(before + stripLineNumbers(part) + (part.endsWith('\n') || !part ? '' : '\n') + after);
      },
      onReset: () => live.update(original),
    });
    resultText = r.text;
    await live.close();
    if (r.status === 'cancelled' || run.abort.signal.aborted) {
      sink.post({ type: 'runEnd', status: 'cancelled' });
      return { status: 'cancelled', applied: false, acceptedHunks: 0, rejectedHunks: 0 };
    }
    if (r.status !== 'done') {
      void vscode.window.showErrorMessage(`Anvil inline edit failed: ${r.error}`);
      sink.post({ type: 'runEnd', status: 'error', error: r.error });
      return { status: 'error', applied: false, acceptedHunks: 0, rejectedHunks: 0, error: r.error };
    }
    const fenced = extractFenced(r.text, true);
    if (fenced === undefined) {
      const msg = 'the model reply contained no fenced code block, so nothing was changed.';
      void vscode.window.showErrorMessage(`Anvil inline edit: ${msg}`);
      sink.post({ type: 'runEnd', status: 'error', error: msg });
      return { status: 'error', applied: false, acceptedHunks: 0, rejectedHunks: 0, error: msg, text: r.text };
    }
    let replacement = stripLineNumbers(fenced);
    if (replacement && !replacement.endsWith('\n') && (selected.endsWith('\n'))) replacement += '\n';
    const proposed = before + replacement + after;
    if (proposed === original) {
      void vscode.window.showInformationMessage('Anvil: the model proposed no change.');
      sink.post({ type: 'runEnd', status: 'done' });
      return { status: 'nochange', applied: false, acceptedHunks: 0, rejectedHunks: 0, text: r.text };
    }
    status.text = '$(eye) Anvil: review hunks';
    const prevAuto = reviews.autoDecide;
    if (args.autoAccept) reviews.autoDecide = (_p, hs) => hs.map(() => true);
    let rv;
    try { rv = await reviews.review(relPath, original, proposed, 'inline'); } finally { reviews.autoDecide = prevAuto; }
    if (!rv || run.abort.signal.aborted) {
      sink.post({ type: 'runEnd', status: 'cancelled' });
      return { status: 'cancelled', applied: false, acceptedHunks: 0, rejectedHunks: 0 };
    }
    const res = await host.writeAccepted(relPath, original, rv.hunks, rv.accepted, false, 'inline');
    sink.post({ type: 'runEnd', status: 'done', summary: res.summary });
    if (res.applied) void vscode.window.setStatusBarMessage(`Anvil: ${res.summary}`, 6000);
    return { status: 'done', applied: res.applied, acceptedHunks: res.acceptedHunks, rejectedHunks: res.rejectedHunks, text: r.text };
  } catch (e: any) {
    await live.close();
    const msg = String(e?.message ?? e);
    void vscode.window.showErrorMessage(`Anvil inline edit failed: ${msg}`);
    sink.post({ type: 'runEnd', status: 'error', error: msg });
    return { status: 'error', applied: false, acceptedHunks: 0, rejectedHunks: 0, error: msg, text: resultText };
  } finally {
    status.text = prevText; status.command = prevCmd; status.tooltip = prevTip;
    host.checkpoints.endRun();
    runs.end(run);
  }
}
