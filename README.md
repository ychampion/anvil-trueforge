# Anvil: a coding agent for VS Code, running on TrueForge

Anvil is a VS Code extension for coding with an agent. The extension never runs the agent loop itself: that runs on
**[TrueForge](https://github.com/truefoundry/trueforge)** in local mode. Anvil is a TrueForge client, and it exposes
the editor to the agent as an **MCP server**. That way the agent decides what to read, search, edit and run, and you
approve every change hunk by hunk before it reaches the disk.

Built for the TrueFoundry Forge-a-thon (Techfest 2026-27, IIT Bombay).

- **Inline edit:** select code, press `Ctrl+Alt+E` (`Cmd+Alt+E` on macOS) and type an instruction. Tokens stream
  live, then the proposed diff opens in the editor with **Accept / Reject on every hunk**.
- **Agent mode:** the *Anvil* panel. One request drives a TrueForge agent through a tool loop (retrieve context,
  search, read, edit, run commands) until the work is done. You don't name the files: the agent finds them.
- **Context assembly:** `@file` and `@symbol` mentions (with autocomplete), plus automatic retrieval under a token
  budget. The *Context chosen* card shows each file, line range and reason, plus what was left out.
- **Diff review:** every write pauses at TrueForge's tool approval and is shown as per-hunk review. Only the hunks you
  accept get written. **Undo last change** and **Undo whole run** restore the files.
- **Streaming and cancellation:** you see tokens as they arrive, and `Esc` or *Cancel* stops the run instantly. A
  cancelled run puts back every file it touched, so no edit is ever left half-applied.
- **Resilience:** an ordered chain of agents and models. A failing model is retried with exponential backoff, then
  Anvil **automatically falls back** to the next configured model, with no action from you.

## Starting point

**From scratch.** Anvil is not a fork of Cline, Continue, Roo Code or opencode, so there is no fork commit and no
upstream agent loop. Third-party code is limited to ordinary dependencies, credited under
[Credits](#credits). Licence: MIT ([LICENSE](LICENSE)).

## Layout

```
extension/          the VS Code extension (TypeScript, bundled with esbuild)
  src/trueforge/    TrueForge client: sessions, streaming turns, approvals, cancel, retry and fallback chain
  src/mcp/          MCP server "anvil-editor" (streamable HTTP, 127.0.0.1:7391/mcp): the editor's tools
  src/context/      context engine: structural index, BM25, structural expansion, budgeted packs
  src/review/       per-hunk diff review, checkpoints, undo
  src/inline/       inline edit
  src/ui/           agent panel (webview)
trueforge/          agent definitions (agents/*.json), setup.mjs (registers models, MCP server, agents), start script
modal/              optional: serve the open model (Qwen3-Coder-30B) on Modal with vLLM
writeup/            the 1–3 page write-up
```

## Setup from a clean clone

Prerequisites: Node ≥ 22.14, [bun](https://bun.sh), VS Code ≥ 1.90, ripgrep (`rg`) on your PATH, and Python 3.10+
for the Flask tasks.

```bash
git clone https://github.com/ychampion/anvil-trueforge && cd anvil-trueforge
```

### 1. Start TrueForge in local mode

```bash
npx @truefoundry/trueforge@0.185.1          # UI and API on http://localhost:8790
# or, to run it in the background inside tmux:
./trueforge/start-local.sh --daemon
```

### 2. Configure a model, the MCP connector and the agents

Every model is configured **inside TrueForge**. Anvil only refers to agents and models by name, and never calls a
model provider itself.

```bash
cp trueforge/models.example.json trueforge/models.json     # add your endpoint(s); models.json is gitignored
# or set env vars: MODAL_LLM_BASE_URL, MODAL_LLM_API_KEY, MODAL_LLM_MODEL (any OpenAI-compatible endpoint works)
node trueforge/setup.mjs
```

`setup.mjs` is idempotent. It uses TrueForge's settings API to register:
- the model providers (`modal`, `modal-fallback`, and `broken`, an unreachable endpoint used for Task C);
- the MCP connector `anvil-editor`, at `http://127.0.0.1:7391/mcp`;
- the saved agents from `trueforge/agents/`: `anvil-coder`, `anvil-inline`, their `-fallback` twins and
  `anvil-inline-broken`.

You can also add any catalog provider (OpenAI, Anthropic, Gemini, Groq, …) under TrueForge's **Settings → Models**
and point an agent at it.

### 3. Build and install the extension

```bash
cd extension
bun install
bun run build                                   # esbuild → out/extension.js
bunx @vscode/vsce package --no-dependencies     # → anvil-*.vsix
code --install-extension anvil-*.vsix
```

Or open `extension/` in VS Code and press `F5`.

### 4. Open a repository

```bash
git clone https://github.com/pallets/flask && cd flask && git checkout 3.1.3
python -m venv .venv && .venv/bin/pip install -e . "pytest==9.0.2"
code .
```

Anvil starts its MCP server when VS Code starts, and indexes the workspace in the background. That takes about
0.3 s on Flask.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `anvil.trueforgeUrl` | `http://localhost:8790` | TrueForge server (`anvil.trueforgeUiUrl` overrides the link the *Open in TrueForge* button opens) |
| `anvil.agent` / `anvil.inlineAgent` | `anvil-coder` / `anvil-inline` | Saved TrueForge agents for the agent panel and for inline edit |
| `anvil.agentChain` / `anvil.inlineAgentChain` | `[]` | Ordered list of saved agents to try: each is retried with backoff, then Anvil falls back to the next one automatically |
| `anvil.models` | `[]` | An alternative to chains: an ordered list of TrueForge model names (primary first); the saved agent runs with its model swapped |
| `anvil.retry` | `{attempts: 2, backoffMs: 800, factor: 2}` | Retries per agent or model before falling back |
| `anvil.contextBudgetTokens` | `6000` | Token budget for the automatic context pack in agent mode |
| `anvil.mcpPort` | `7391` | Port of the in-editor MCP server (must match the `anvil-editor` connector in TrueForge) |
| `anvil.autoApproveCommands` | pytest, flask, `python -c`, `git status/diff` | Regexes for `run_command` calls approved without a prompt (each still appears in the log) |

Commands: **Anvil: Edit Selection** (`Ctrl+Alt+E`), **Anvil: Open Agent Panel**, **Cancel** (`Esc` while Anvil is
busy), **Undo Last Applied Change**, **Undo Whole Run**, **Select Model**, **Open Session in TrueForge**. Review:
per-hunk **✓ Accept / ✗ Reject**, **Accept all**, **Reject all**, **Apply N accepted hunks** (CodeLens in the review
diff).

### Task C (resilience) configuration

```jsonc
// .vscode/settings.json or user settings
"anvil.inlineAgentChain": ["anvil-inline-broken", "anvil-inline"]
```

`anvil-inline-broken` points at a TrueForge provider whose endpoint can't be reached. Anvil retries it twice with
exponential backoff (0.8 s, then 1.6 s), then switches to `anvil-inline` on its own and shows the whole timeline. The
workspace is never touched until you accept a hunk.

## Tests

```bash
cd extension
bun test src/context src/mcp test/hunks.test.ts   # context engine, MCP server, hunk logic (25+ tests)
bash test/smoke.sh                                # real VS Code under xvfb: activation, MCP, agent round-trip, undo
ANVIL_E2E_CANCEL=1 bash test/smoke.sh             # cancel during review → workspace untouched
```

## Credits

- [TrueForge](https://github.com/truefoundry/trueforge) and `@truefoundry/trueforge-sdk` (MIT): the agent harness
  and its SDK.
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) (MIT): the MCP server.
- [jsdiff](https://github.com/kpdecker/jsdiff) (BSD-3-Clause): hunk computation.
- [zod](https://github.com/colinhacks/zod) (MIT) and [esbuild](https://github.com/evanw/esbuild) (MIT).
- [vLLM](https://github.com/vllm-project/vllm) (Apache-2.0) and
  [Qwen3-Coder](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8) (Apache-2.0): the optional open model
  on Modal.
