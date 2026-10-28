'use strict'
const { contextBridge, ipcRenderer } = require('electron')

/** What the pages may say to the main process, and hear from it. */
const SEND = new Set([
  'pet:ready', 'pet:contextmenu', 'pet:toggle', 'pet:open', 'pet:glide-done',
  'ask:ready', 'ask:submit', 'ask:cancel', 'ask:pick',
])
const RECEIVE = new Set([
  'pet:init', 'pet:view', 'pet:sessions', 'pet:motion', 'pet:gaze', 'pet:drag-begin', 'pet:drag-dir',
  'pet:drag-end', 'pet:react',
  'ask:show', 'ask:workspace',
])

contextBridge.exposeInMainWorld('bridge', {
  send(channel, payload) {
    if (SEND.has(channel)) ipcRenderer.send(channel, payload)
  },
  on(channel, listener) {
    if (!RECEIVE.has(channel)) return
    ipcRenderer.on(channel, (_event, payload) => listener(payload))
  },
})
