const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('bb', {
  profiles: {
    list: () => ipcRenderer.invoke('profiles:list'),
    add: name => ipcRenderer.invoke('profiles:add', name),
    rename: (id, name) => ipcRenderer.invoke('profiles:rename', id, name),
    delete: id => ipcRenderer.invoke('profiles:delete', id),
    logout: id => ipcRenderer.invoke('profiles:logout', id),
    hasSession: id => ipcRenderer.invoke('profiles:hasSession', id)
  },
  auth: {
    has: id => ipcRenderer.invoke('auth:has', id),
    clear: id => ipcRenderer.invoke('auth:clear', id)
  },
  game: {
    launch: id => ipcRenderer.invoke('game:launch', id),
    close: id => ipcRenderer.invoke('game:close', id)
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    save: updates => ipcRenderer.invoke('settings:save', updates)
  },
  server: {
    check: () => ipcRenderer.invoke('server:check'),
    onStatus: cb => { const handler = (_e, data) => cb(data); ipcRenderer.on('server:status', handler); return () => ipcRenderer.removeListener('server:status', handler); }
  },
  cache: { clear: id => ipcRenderer.invoke('cache:clear', id) },
  news: { fetch: () => ipcRenderer.invoke('news:fetch') },
  launcher: { show: () => ipcRenderer.invoke('launcher:show'), hide: () => ipcRenderer.invoke('launcher:hide') },
  client: { openPanel: id => ipcRenderer.invoke('client:open-panel', id) },
  app: { openExternal: url => ipcRenderer.invoke('app:openExternal', url), openPath: target => ipcRenderer.invoke('app:openPath', target), openDataFolder: () => ipcRenderer.invoke('app:openDataFolder'), version: () => ipcRenderer.invoke('app:version') },
  diagnostics: { get: () => ipcRenderer.invoke('diagnostics:get') },
  update: {
    check: () => ipcRenderer.invoke('update:check'),
    apply: () => ipcRenderer.invoke('update:apply'),
    onProgress: cb => { const handler = (_e, step) => cb(step); ipcRenderer.on('update:progress', handler); return () => ipcRenderer.removeListener('update:progress', handler); },
    onAvailable: cb => { const handler = (_e, info) => cb(info); ipcRenderer.on('update:available', handler); return () => ipcRenderer.removeListener('update:available', handler); }
  }
});
