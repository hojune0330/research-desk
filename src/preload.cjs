const { contextBridge, ipcRenderer, webUtils } = require('electron');
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const subscribe = channel => callback => { const listener = (_event, value) => callback(value); ipcRenderer.on(channel, listener); return () => ipcRenderer.removeListener(channel, listener); };
contextBridge.exposeInMainWorld('researchDesk', {
  status: invoke('app:status'), saveSettings: invoke('settings:save'), clearKey: invoke('key:clear'), checkKey: invoke('key:check'),
  list: invoke('library:list'), pickFiles: invoke('files:pick'), dropFiles: invoke('files:drop'), addMaterial: invoke('material:add'),
  setPolicy: invoke('source:policy'), remove: invoke('source:remove'), view: invoke('source:view'), open: invoke('source:open'), openLink: invoke('link:open'),
  search: invoke('search:run'), cancel: invoke('job:cancel'), history: invoke('history:list'), clearHistory: invoke('history:clear'), saveReport: invoke('report:save'),
  filePath: file => webUtils.getPathForFile(file),
  onActivity: subscribe('activity'), onLocal: subscribe('search:local'), onLibrary: subscribe('library:changed')
});
