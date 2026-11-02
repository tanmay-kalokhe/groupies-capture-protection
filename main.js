// Groupies — capture-protection + local-AI support assistant (Electron main)
// -----------------------------------------------------------------------------
// Feature 1: per-window "Hide from screen share / recording" toggle
//            (win.setContentProtection).
// Feature 2: in-call support chatbot that streams from a LOCAL AI model
//            (your self-hosted Gemma) over an OpenAI-compatible HTTP API.
//
// The model call runs in the MAIN process on purpose: the renderer is a
// sandboxed page, but main can reach another device on your LAN with no CORS
// restrictions. Tokens are streamed back to the overlay via IPC events.
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, globalShortcut, ipcMain } = require('electron');

// ---------------------------------------------------------------------------
// AI CONFIG  —  EDIT THESE for your setup.
// ---------------------------------------------------------------------------
//  • baseUrl : the OpenAI-compatible base URL of the device running Gemma.
//              Ollama   → http://<LAN-IP>:11434/v1
//              LM Studio→ http://<LAN-IP>:1234/v1
//              llama.cpp→ http://<LAN-IP>:8080/v1
//  • model   : the exact model id your server reports.
//              Ollama example: "gemma3n:e4b"   LM Studio: whatever it lists.
//  Override without editing code via env vars GROUPIES_AI_BASE_URL / _MODEL.
const AI_CONFIG = {
  baseUrl: (process.env.GROUPIES_AI_BASE_URL || 'http://localhost:1234/v1').replace(/\/+$/, ''),
  model: process.env.GROUPIES_AI_MODEL || 'gemma-4-e4b-it-ultra-uncensored-heretic',
  apiKey: process.env.GROUPIES_AI_API_KEY || 'not-needed', // local servers ignore it
  temperature: 0.4,
  requestTimeoutMs: 120000,
  systemPrompt:
    'You are the in-call support assistant for Groupies, a video calling app. ' +
    'Help the user with using the app — audio, video, screen sharing, invites, ' +
    'and the "hide from screen share" privacy toggle. Be concise, friendly, and ' +
    'practical. If you are unsure, say so.',
};

const SHORTCUT = 'CommandOrControl+Shift+P';

let callWindow = null;
let protectionEnabled = false;

/** requestId -> AbortController for in-flight AI calls. */
const activeAiRequests = new Map();

// ---------------------------------------------------------------------------
// Window + capture protection
// ---------------------------------------------------------------------------

function isRemoteDesktopSession() {
  if (process.platform !== 'win32') return false;
  const sessionName = process.env.SESSIONNAME ?? '';
  if (sessionName.startsWith('RDP-')) return true;
  const clientName = process.env.CLIENTNAME ?? '';
  return Boolean(clientName) && clientName !== 'Console';
}

function createCallWindow() {
  callWindow = new BrowserWindow({
    width: 1120,
    height: 720,
    minWidth: 760,
    minHeight: 480,
    backgroundColor: '#0f1115',
    title: 'Groupies',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  callWindow.loadFile(path.join(__dirname, 'index.html'));

  applyProtection(false);

  callWindow.webContents.on('did-finish-load', () => {
    safeSend('rdp-status', isRemoteDesktopSession());
    safeSend('protection-changed', protectionEnabled);
    safeSend('ai-config', { model: AI_CONFIG.model, baseUrl: AI_CONFIG.baseUrl });
  });

  callWindow.on('closed', () => {
    // Abort any streams tied to the dead window.
    for (const controller of activeAiRequests.values()) controller.abort();
    activeAiRequests.clear();
    callWindow = null;
  });
}

/** Send to the renderer only if it still exists. Prevents post-close crashes. */
function safeSend(channel, payload) {
  if (callWindow && !callWindow.isDestroyed() && callWindow.webContents) {
    callWindow.webContents.send(channel, payload);
  }
}

function applyProtection(enabled) {
  if (!callWindow) return protectionEnabled;
  const onRdp = isRemoteDesktopSession();
  const effective = enabled && !onRdp;
  callWindow.setContentProtection(effective);
  protectionEnabled = effective;
  safeSend('protection-changed', protectionEnabled);
  console.log(
    `[groupies] capture protection: ${protectionEnabled ? 'ON' : 'OFF'}` +
      (onRdp ? ' (forced OFF — RDP session)' : ''),
  );
  return protectionEnabled;
}

// ---------------------------------------------------------------------------
// Local AI support assistant
// ---------------------------------------------------------------------------

/**
 * Validate and normalize the message list coming from the renderer.
 * Only {role, content} string pairs with known roles survive.
 */
function sanitizeMessages(input) {
  if (!Array.isArray(input)) return [];
  const allowed = new Set(['user', 'assistant', 'system']);
  const out = [];
  for (const m of input) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? m.role : '';
    const content = typeof m.content === 'string' ? m.content : '';
    if (!allowed.has(role) || content.trim() === '') continue;
    out.push({ role, content: content.slice(0, 8000) }); // cap per-message size
  }
  return out.slice(-20); // keep the last 20 turns of context
}

/** Turn a connection error into a human-readable, non-crashing message. */
function describeAiError(err) {
  if (err?.name === 'AbortError') return 'Request cancelled or timed out.';
  const code = err?.cause?.code || err?.code;
  if (code === 'ECONNREFUSED')
    return `Can't reach the AI server at ${AI_CONFIG.baseUrl}. Is Gemma running and reachable on the LAN?`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return `Host not found for ${AI_CONFIG.baseUrl}. Check the device IP/port.`;
  if (code === 'ETIMEDOUT') return 'The AI server did not respond in time.';
  return err?.message ? `AI request failed: ${err.message}` : 'AI request failed.';
}

/**
 * Stream a completion from the local OpenAI-compatible server and emit
 * 'ai-chat-chunk' events, finishing with 'ai-chat-done' or 'ai-chat-error'.
 * Never throws — all failures become an error event.
 */
async function streamAiCompletion(requestId, messages) {
  const controller = new AbortController();
  activeAiRequests.set(requestId, controller);
  // Idle timeout: restarted whenever data arrives, so a long but still-active
  // answer (slow local model, long reasoning) is not cut off mid-stream.
  let timeout = setTimeout(() => controller.abort(), AI_CONFIG.requestTimeoutMs);
  const resetTimeout = () => {
    clearTimeout(timeout);
    timeout = setTimeout(() => controller.abort(), AI_CONFIG.requestTimeoutMs);
  };

  let full = '';
  try {
    const body = {
      model: AI_CONFIG.model,
      messages: [{ role: 'system', content: AI_CONFIG.systemPrompt }, ...messages],
      temperature: AI_CONFIG.temperature,
      stream: true,
    };

    const response = await fetch(`${AI_CONFIG.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_CONFIG.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);
      throw new Error(`server responded ${response.status} ${response.statusText}. ${detail}`.trim());
    }

    const contentType = response.headers.get('content-type') || '';

    // Fallback: server ignored stream:true and sent one JSON object.
    if (!contentType.includes('text/event-stream')) {
      const json = await response.json().catch(() => null);
      const text = json?.choices?.[0]?.message?.content ?? '';
      if (text) {
        full = text;
        safeSend('ai-chat-chunk', { requestId, delta: text });
      }
      safeSend('ai-chat-done', { requestId, text: full });
      return;
    }

    // Server-Sent Events: lines like  data: {json}\n\n  ending with data: [DONE]
    const decoder = new TextDecoder();
    let buffer = '';
    // Handle one SSE line. Returns true on the [DONE] sentinel.
    const handleLine = (rawLine) => {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) return false;
      const payload = line.slice(5).trim();
      if (payload === '') return false;
      if (payload === '[DONE]') return true;
      let json;
      try {
        json = JSON.parse(payload);
      } catch {
        return false; // skip a partial/garbled SSE frame rather than crash
      }
      const delta = json?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length) {
        full += delta;
        safeSend('ai-chat-chunk', { requestId, delta });
      }
      return false;
    };
    for await (const bytes of response.body) {
      resetTimeout();
      buffer += decoder.decode(bytes, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (handleLine(line)) { buffer = ''; break; }
      }
    }
    // A final frame may arrive without a trailing newline; don't drop it.
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);

    safeSend('ai-chat-done', { requestId, text: full });
  } catch (err) {
    safeSend('ai-chat-error', { requestId, message: describeAiError(err) });
  } finally {
    clearTimeout(timeout);
    activeAiRequests.delete(requestId);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle + IPC
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  createCallWindow();

  globalShortcut.register(SHORTCUT, () => applyProtection(!protectionEnabled));

  ipcMain.handle('set-capture-protection', (_e, enabled) => applyProtection(Boolean(enabled)));
  ipcMain.handle('get-capture-protection', () => protectionEnabled);

  // Start an AI stream. Returns the requestId immediately; tokens arrive as events.
  ipcMain.handle('ai-chat-start', (_e, messages) => {
    const clean = sanitizeMessages(messages);
    if (clean.length === 0) return { error: 'No valid message to send.' };
    const requestId = crypto.randomUUID();
    // Fire and forget — streamAiCompletion emits its own events and never throws.
    streamAiCompletion(requestId, clean);
    return { requestId };
  });

  ipcMain.handle('ai-chat-cancel', (_e, requestId) => {
    const controller = activeAiRequests.get(requestId);
    if (controller) controller.abort();
    return true;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createCallWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  for (const controller of activeAiRequests.values()) controller.abort();
  activeAiRequests.clear();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
