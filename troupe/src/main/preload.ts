import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { TroupeApi } from '../shared/types';

const call = (method: string) => (...args: unknown[]) => ipcRenderer.invoke('troupe', method, ...args);
const methods = [
  'getState', 'getLive', 'addAgent', 'updateAgent', 'removeAgent', 'newChat', 'moveChat', 'setChatTarget', 'renameChat',
  'deleteChat', 'sendMessage', 'stopChat', 'updateSettings', 'checkClaude', 'chooseDirectory', 'chooseDirectories',
  'createProject', 'updateProject', 'deleteProject', 'showInFinder', 'searchFiles', 'openInMain', 'hideQuick', 'shortcutStatus', 'restoreCheckpoint', 'checkpointConflicts', 'getActivityView',
] as const;

const api = Object.fromEntries(methods.map((m) => [m, call(m)])) as unknown as TroupeApi;
const listen = (channel: string) => (cb: (v: any) => void) => {
  const fn = (_: unknown, v: any) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => void ipcRenderer.off(channel, fn);
};
api.onState = listen('state');
api.onLive = listen('live');
api.onOpenChat = listen('open-chat');
api.onQuickShown = listen('quick-shown');
api.pathForFile = (file) => webUtils.getPathForFile(file);

contextBridge.exposeInMainWorld('troupe', api);
