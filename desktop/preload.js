'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('splitter', Object.freeze({
    request: (action, payload) => ipcRenderer.invoke('splitter:request', action, payload),
    subscribe: (callback) => {
        const listener = (_event, state) => callback(state);
        ipcRenderer.on('splitter:snapshot', listener);
        return () => ipcRenderer.removeListener('splitter:snapshot', listener);
    },
    onCloseConfirmation: (callback) => {
        const listener = () => callback();
        ipcRenderer.on('splitter:confirm-close', listener);
        return () => ipcRenderer.removeListener('splitter:confirm-close', listener);
    },
}));
