"""Verify the Modal vLLM endpoint: models, streaming, tool calls (stream + non-stream), tok/s.

Usage: MODAL_LLM_BASE_URL=... MODAL_LLM_API_KEY=... MODAL_LLM_MODEL=qwen3-coder-30b python verify.py
Stdlib only. Never prints the key.
"""

import json
import os
import time
import urllib.request

BASE = os.environ["MODAL_LLM_BASE_URL"].rstrip("/")
KEY = os.environ["MODAL_LLM_API_KEY"]
MODEL = os.environ.get("MODAL_LLM_MODEL", "qwen3-coder-30b")
H = {"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}

TOOLS = [
    {"type": "function", "function": {
        "name": "read_file", "description": "Read a file from the workspace.",
        "parameters": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}}},
    {"type": "function", "function": {
        "name": "run_command", "description": "Run a shell command in the workspace.",
        "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}}},
]
TOOL_MSG = [{"role": "user", "content": "Open src/flask/helpers.py and tell me what get_debug_flag does. Use a tool."}]


def req(path, body=None, timeout=900):
    r = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body else None, headers=H,
                               method="POST" if body else "GET")
    return urllib.request.urlopen(r, timeout=timeout)


def sse(resp):
    for raw in resp:
        line = raw.decode().strip()
        if line.startswith("data: "):
            d = line[6:]
            if d == "[DONE]":
                return
            yield json.loads(d)


print("== 1. /v1/models")
t = time.time()
print(json.dumps(json.load(req("/models")), indent=1)[:600], f"\n({time.time()-t:.1f}s)")

print("\n== 2. streaming chat")
t0 = time.time()
first = None
n_chunks = 0
text = ""
usage = None
body = {"model": MODEL, "stream": True, "stream_options": {"include_usage": True}, "max_tokens": 400,
        "messages": [{"role": "user", "content": "Write a Python function that parses a semver string, with a docstring."}]}
for ch in sse(req("/chat/completions", body)):
    if ch.get("usage"):
        usage = ch["usage"]
    for c in ch.get("choices", []):
        piece = c["delta"].get("content") or ""
        if piece:
            if first is None:
                first = time.time()
            n_chunks += 1
            text += piece
t1 = time.time()
ct = usage["completion_tokens"] if usage else None
print(text[:300] + " ...")
print(f"content chunks={n_chunks} TTFT={first-t0:.2f}s total={t1-t0:.2f}s completion_tokens={ct} "
      f"decode tok/s={ct/(t1-first):.1f}" if ct else "")

print("\n== 3a. tool call, non-streaming")
r = json.load(req("/chat/completions", {"model": MODEL, "messages": TOOL_MSG, "tools": TOOLS, "tool_choice": "auto",
                                        "max_tokens": 300}))
m = r["choices"][0]
print("finish_reason:", m["finish_reason"])
print("tool_calls:", json.dumps(m["message"].get("tool_calls"), indent=1))
print("content:", repr(m["message"].get("content")))
tc = m["message"].get("tool_calls") or []
ok_ns = bool(tc) and tc[0]["function"]["name"] in ("read_file", "run_command") and \
    isinstance(json.loads(tc[0]["function"]["arguments"]), dict)

print("\n== 3b. tool call, streaming")
calls = {}
fr = None
for ch in sse(req("/chat/completions", {"model": MODEL, "messages": TOOL_MSG, "tools": TOOLS, "tool_choice": "auto",
                                        "max_tokens": 300, "stream": True})):
    for c in ch.get("choices", []):
        fr = c.get("finish_reason") or fr
        for d in c["delta"].get("tool_calls") or []:
            e = calls.setdefault(d["index"], {"id": None, "name": "", "arguments": ""})
            e["id"] = d.get("id") or e["id"]
            f = d.get("function") or {}
            e["name"] += f.get("name") or ""
            e["arguments"] += f.get("arguments") or ""
print("finish_reason:", fr)
print("assembled tool_calls:", json.dumps(calls, indent=1))
ok_s = bool(calls) and isinstance(json.loads(calls[0]["arguments"]), dict)

print("\n== 3c. tool result round-trip")
msgs = TOOL_MSG + [m["message"], {"role": "tool", "tool_call_id": tc[0]["id"] if tc else "x",
                                  "content": "def get_debug_flag() -> bool:\n    val = os.environ.get('FLASK_DEBUG')\n    return bool(val and val.lower() not in {'0', 'false', 'no'})"}]
r2 = json.load(req("/chat/completions", {"model": MODEL, "messages": msgs, "tools": TOOLS, "max_tokens": 200}))
print("answer:", (r2["choices"][0]["message"].get("content") or "")[:300])

print(f"\nRESULT tool_calls non-stream={'PASS' if ok_ns else 'FAIL'} stream={'PASS' if ok_s else 'FAIL'}")
