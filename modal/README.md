# Anvil model on Modal (vLLM, OpenAI-compatible)

Serves `Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8` (served name `qwen3-coder-30b`) with vLLM on one H100,
with streaming and native tool calling (`--enable-auto-tool-choice --tool-call-parser qwen3_coder`).
TrueForge registers it as a `custom` OpenAI-compatible provider. The extension never calls it directly.

| Setting | Value |
|---|---|
| Base URL | `https://<workspace>--anvil-vllm-serve.modal.run/v1` (printed by `modal deploy`) |
| Model id | `qwen3-coder-30b` |
| Context length | 65,536 tokens |
| Max output tokens (recommended) | 16,384 |
| Auth | `Authorization: Bearer $MODAL_LLM_API_KEY` (vLLM `--api-key`) |
| GPU | 1x H100, one warm container (`min_containers=1`, `max_containers=1`), 16 concurrent requests |
| Weights | Modal Volume `anvil-model-weights` (downloaded inside Modal on first start) |

## Deploy

```bash
pip install modal            # in a venv; `modal setup` once
# one-time: API key the server will require
modal secret create anvil-vllm-key VLLM_API_KEY="$(python -c 'import secrets;print("sk-anvil-"+secrets.token_urlsafe(32))')"
# the model is public, so no HF token is needed (add one as another Secret if downloads are rate-limited)
modal deploy serve_vllm.py
```

Then put the URL and key in a local env file (see `.env.example`) and check it:

```bash
set -a; . ./modal.env; set +a
python verify.py     # /v1/models, streaming, tool calls (streaming + non-streaming), tok/s
```

## Cost and scale-down

An H100 on Modal costs roughly $4/hour while a container is up. With `min_containers=1` one container stays warm
the whole time, so the bill runs until you scale down:

```bash
ANVIL_MIN_CONTAINERS=0 modal deploy serve_vllm.py   # scale to zero when idle (30 min scaledown window)
modal app stop anvil-vllm                           # or stop the app completely
```

With `min_containers=0` the first request after idle pays a cold start (container start + loading weights from
the Volume; see the measured number in the project report).

## Swap the model

Edit the constants at the top of `serve_vllm.py`:

- `MODEL_ID`: any Hugging Face repo vLLM supports, e.g. `Qwen/Qwen3-Coder-30B-A3B-Instruct` (BF16, needs ~61 GB,
  still fits one H100 80 GB at a shorter context).
- `SERVED_NAME`: the model id clients send.
- `TOOL_PARSER`: must match the model family (`qwen3_coder` for Qwen3-Coder, `hermes` for Qwen2.5/Qwen3,
  `llama3_json` for Llama 3.x, `mistral` for Mistral).
- `MAX_MODEL_LEN`, `GPU`, `VLLM_IMAGE` as needed.

Redeploy with `modal deploy serve_vllm.py`; new weights download into the same Volume.
