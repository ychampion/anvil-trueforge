import * as vscode from 'vscode';
import { PanelMsg, Sink } from '../agentRunner';

export interface PanelHandlers {
  send(text: string, mentions: { files: string[]; symbols: string[] }): void;
  cancel(): void;
  undoRun(): void;
  undoLast(): void;
  openSession(): void;
  mentionQuery(q: string): { files: string[]; symbols: { name: string; path: string; line: number; kind: string }[] };
}

export class AnvilPanel implements vscode.WebviewViewProvider, Sink {
  static readonly viewId = 'anvil.panel';
  private view?: vscode.WebviewView;
  private ready = false;
  private backlog: PanelMsg[] = [];
  private header: PanelMsg = { type: 'header' };

  constructor(private extUri: vscode.Uri, private h: PanelHandlers) {}

  post(msg: PanelMsg) {
    if (msg.type === 'header') this.header = { ...this.header, ...msg };
    this.backlog.push(msg);
    if (this.backlog.length > 3000) this.backlog.splice(0, this.backlog.length - 3000);
    if (this.ready) void this.view?.webview.postMessage(msg);
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    this.ready = false;
    view.onDidDispose(() => { this.ready = false; this.view = undefined; });
    const w = view.webview;
    w.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extUri, 'media')] };
    const js = w.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'panel.js'));
    const css = w.asWebviewUri(vscode.Uri.joinPath(this.extUri, 'media', 'panel.css'));
    const nonce = Math.random().toString(36).slice(2);
    w.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body>
<header id="hdr"><span id="conn" class="dot"></span><span id="model">model: –</span><a id="sess" href="#" title="Open this session in TrueForge"></a></header>
<main id="log"><div class="empty">Ask Anvil to change the code. Use <b>@</b> to mention files and symbols.<br>Agent runs on TrueForge; every edit is reviewed hunk by hunk.</div></main>
<footer>
  <div id="chips"></div>
  <div id="ac" hidden></div>
  <textarea id="inp" rows="3" placeholder="Describe a change… (@ to mention, Enter to send, Shift+Enter for newline)"></textarea>
  <div class="row">
    <button id="send">Send</button>
    <button id="cancel" class="sec" disabled>Cancel (Esc)</button>
    <span class="grow"></span>
    <button id="undoLast" class="sec" title="Undo last applied change">Undo last</button>
    <button id="undoRun" class="sec" title="Restore every file changed in the last run">Undo run</button>
  </div>
</footer>
<script nonce="${nonce}" src="${js}"></script></body></html>`;
    w.onDidReceiveMessage((m: any) => {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          for (const b of this.backlog) void w.postMessage(b);
          break;
        case 'send': this.h.send(m.text, m.mentions ?? { files: [], symbols: [] }); break;
        case 'cancel': this.h.cancel(); break;
        case 'undoRun': this.h.undoRun(); break;
        case 'undoLast': this.h.undoLast(); break;
        case 'openSession': this.h.openSession(); break;
        case 'mentionQuery': {
          let res: ReturnType<PanelHandlers['mentionQuery']> = { files: [], symbols: [] };
          try { res = this.h.mentionQuery(m.q ?? ''); } catch { /* engine not ready */ }
          void w.postMessage({ type: 'mentionResults', q: m.q, ...res });
          break;
        }
      }
    });
  }

  reveal() {
    void vscode.commands.executeCommand('anvil.panel.focus');
  }
}
