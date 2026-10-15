# Groupies — Capture Protection + Local-AI Support Assistant

A tiny, self-contained Electron app demonstrating two features for a
Zoom-style video call UI:

1. **Hide from screen share / recording** — a per-window toggle
   (`win.setContentProtection`). The window stays on your monitor but is
   omitted from OS screen-capture buffers.
2. **In-call Support Assistant** — a chat panel that streams answers from a
   **local AI model** (your self-hosted Gemma) over an OpenAI-compatible API.

## Run

```bash
cd groupies-capture-protection
npm install        # installs electron (needs internet once)
npm start
```

- **Shield:** click 🛡️ *Hide from share* or press **Ctrl/Cmd+Shift+P**, then
  check a recording (OBS / Win+G / Teams share) — the window should vanish from it.
- **Assistant:** click 💬 *Assistant* to open the chat panel, type, press Enter.

## Point it at your Gemma model

Your model runs on another device, so set its LAN address. Two ways:

**A. Environment variables (no code edit):**
```bash
# Windows PowerShell
$env:GROUPIES_AI_BASE_URL = "http://192.168.1.50:11434/v1"   # the Gemma device
$env:GROUPIES_AI_MODEL    = "gemma3n:e4b"
npm start
```

**B. Edit `AI_CONFIG` at the top of `main.js`.**

Base URL by server:

| Server     | Base URL                          | Notes |
|------------|-----------------------------------|-------|
| Ollama     | `http://<LAN-IP>:11434/v1`        | `ollama serve`; model id like `gemma3n:e4b` |
| LM Studio  | `http://<LAN-IP>:1234/v1`         | enable the local server; use the listed model id |
| llama.cpp  | `http://<LAN-IP>:8080/v1`         | `llama-server`                                   |

> **Make the model reachable from your PC, not just localhost.**
> On the Gemma device, bind to `0.0.0.0` and open the firewall port.
> Ollama: set env `OLLAMA_HOST=0.0.0.0` before `ollama serve`.
> Verify from your PC first: `curl http://<LAN-IP>:11434/v1/models`.

> **Model name:** `main.js` defaults to `gemma3n:e4b`. Use the exact id your
> server reports (`ollama list`, or LM Studio's model list). A wrong id usually
> comes back as an HTTP 404 — shown in the chat panel.

## How it works

- The renderer never calls the model directly (it's a sandboxed page). It asks
  the **main process** over IPC (`ai-chat-start`); main does the `fetch` to your
  device — no CORS issues reaching another host.
- Main streams `POST /v1/chat/completions` with `stream: true`, parses the SSE
  token deltas, and forwards each as an `ai-chat-chunk` event; the panel appends
  them live. Ends with `ai-chat-done` (or `ai-chat-error`).
- **Stop** cancels the in-flight stream (`AbortController`).

## Robustness (the "bug-free" bits)

- Server down / wrong IP / wrong port → friendly message instead of a crash
  (`ECONNREFUSED`, `ENOTFOUND`, timeout all handled).
- 120s request timeout; **Stop** button aborts mid-stream.
- Malformed/partial SSE frames are skipped, not fatal.
- Non-streaming servers handled via a single-JSON fallback.
- Window closed mid-stream → streams aborted, no "destroyed webContents" crash.
- Model/user text rendered with `textContent` (no HTML injection).
- Conversation history capped (last 20 turns, 8k chars each); failed turns are
  rolled back so retries aren't polluted.

## Drop into the real Groupies

Copy `main.js`'s AI section (`AI_CONFIG`, `streamAiCompletion`, the three
`ai-chat-*` IPC handlers) and the `ai` block from `preload.js`, then reuse the
assistant panel markup/JS from `index.html`. The only external dependency is
`fetch`, built into Electron's main process.

## Scope note

This assistant is a **visible** support chatbot — users can see it and the model
only answers what they type. It does not read the call audio/video or other
participants. Keep it that way: an in-call AI that silently captured other people
would be a very different, non-consensual thing.
