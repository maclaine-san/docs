import { contextBridge, ipcRenderer } from 'electron';
import type { TroupeApi } from '../shared/types';

const call = (method: string) => (...args: unknown[]) => ipcRenderer.invoke('troupe', method, ...args);
const methods = [
  'getState', 'getLive', 'addAgent', 'updateAgent', 'removeAgent', 'newChat', 'setChatTarget', 'renameChat',
  'deleteChat', 'sendMessage', 'stopChat', 'updateSettings', 'checkClaude', 'chooseDirectory',
] as const;

const api = Object.fromEntries(methods.map((m) => [m, call(m)])) as unknown as TroupeApi;
const listen = (channel: string) => (cb: (v: any) => void) => {
  const fn = (_: unknown, v: any) => cb(v);
  ipcRenderer.on(channel, fn);
  return () => void ipcRenderer.off(channel, fn);
};
api.onState = listen('state');
api.onLive = listen('live');

contextBridge.exposeInMainWorld('troupe', api);
