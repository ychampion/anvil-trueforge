"""Anvil: Qwen3-Coder-30B-A3B served by vLLM on Modal behind an OpenAI-compatible API.

Deploy:   modal deploy serve_vllm.py
Endpoint: https://<workspace>--anvil-vllm-serve.modal.run/v1   (printed by `modal deploy`)
Auth:     Bearer token from the Modal Secret `anvil-vllm-key` (env var VLLM_API_KEY)

Swap the model by changing MODEL_ID / SERVED_NAME / TOOL_PARSER below.
"""

import os
import subprocess

import modal

MODEL_ID = "Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8"
SERVED_NAME = "qwen3-coder-30b"
TOOL_PARSER = "qwen3_coder"
MAX_MODEL_LEN = 65536
GPU = os.environ.get("ANVIL_GPU", "H100")  # deploy-time only
# Deploy-time only: ANVIL_MIN_CONTAINERS=0 modal deploy serve_vllm.py  -> scale to zero
MIN_CONTAINERS = int(os.environ.get("ANVIL_MIN_CONTAINERS", "1"))
VLLM_IMAGE = "vllm/vllm-openai:v0.11.0"

VLLM_PORT = 8000
MINUTES = 60

image = (
    modal.Image.from_registry(VLLM_IMAGE)
    .entrypoint([])
    .env(
        {
            "HF_HOME": "/models/hf",
            "HF_HUB_ENABLE_HF_TRANSFER": "1",
            "VLLM_CACHE_ROOT": "/models/vllm-cache",
        }
    )
    .run_commands("python3 -m pip install -q hf_transfer || true")
)

models_vol = modal.Volume.from_name("anvil-model-weights", create_if_missing=True)

app = modal.App("anvil-vllm")


@app.function(
    image=image,
    gpu=GPU,
    volumes={"/models": models_vol},
    secrets=[modal.Secret.from_name("anvil-vllm-key")],  # model is public; add an HF_TOKEN secret if rate-limited
    min_containers=MIN_CONTAINERS,
    max_containers=1,
    scaledown_window=30 * MINUTES,
    timeout=24 * 60 * MINUTES,
)
@modal.concurrent(max_inputs=16)
@modal.web_server(port=VLLM_PORT, startup_timeout=30 * MINUTES)
def serve():
    cmd = [
        "vllm", "serve", MODEL_ID,
        "--served-model-name", SERVED_NAME,
        "--host", "0.0.0.0",
        "--port", str(VLLM_PORT),
        "--api-key", os.environ["VLLM_API_KEY"],
        "--max-model-len", str(MAX_MODEL_LEN),
        "--enable-auto-tool-choice",
        "--tool-call-parser", TOOL_PARSER,
        "--gpu-memory-utilization", "0.92",
        "--max-num-seqs", "16",
        "--enable-prefix-caching",
        "--uvicorn-log-level", "warning",
    ]
    print("launching:", " ".join(c if c != os.environ["VLLM_API_KEY"] else "***" for c in cmd), flush=True)
    subprocess.Popen(cmd)
