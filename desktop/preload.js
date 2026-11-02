'use strict'

const { contextBridge, ipcRenderer } = require('electron')

// The only thing the setup page can do is hand a URL to the main process.
contextBridge.exposeInMainWorld('voidz', {
    saveUrl: url => ipcRenderer.invoke('voidz-save-url', url)
})
