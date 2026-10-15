const { ipcRenderer } = require('electron');
window.ipcRenderer = ipcRenderer;
window.__BB_HUB_STANDALONE__ = true;
