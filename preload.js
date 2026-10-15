// Groupies — preload bridge (capture protection + AI assistant).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('groupies', {
  // --- capture protection ---
  setCaptureProtection: (enabled) => ipcRenderer.invoke('set-capture-protection', enabled),
  getCaptureProtection: () => ipcRenderer.invoke('get-capture-protection'),
  onProtectionChanged: (cb) => ipcRenderer.on('protection-changed', (_e, v) => cb(v)),
  onRdpStatus: (cb) => ipcRenderer.on('rdp-status', (_e, v) => cb(v)),

  // --- local AI support assistant ---
  ai: {
    // messages: [{ role: 'user'|'assistant', content: string }]
    // returns { requestId } or { error }
    send: (messages) => ipcRenderer.invoke('ai-chat-start', messages),
    cancel: (requestId) => ipcRenderer.invoke('ai-chat-cancel', requestId),
    onChunk: (cb) => ipcRenderer.on('ai-chat-chunk', (_e, p) => cb(p)), // { requestId, delta }
    onDone: (cb) => ipcRenderer.on('ai-chat-done', (_e, p) => cb(p)),   // { requestId, text }
    onError: (cb) => ipcRenderer.on('ai-chat-error', (_e, p) => cb(p)), // { requestId, message }
    onConfig: (cb) => ipcRenderer.on('ai-config', (_e, p) => cb(p)),    // { model, baseUrl }
  },
});
