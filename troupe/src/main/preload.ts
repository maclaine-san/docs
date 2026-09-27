import { contextBridge, ipcRenderer } from 'electron';
import type { TroupeApi } from '../shared/types';

const call = (method: string) => (...args: unknown[]) => ipcRenderer.invoke('troupe', method, ...args);
const methods = [
  'getState', 'getActivity', 'hireAgent', 'updateAgent', 'fireAgent', 'resetAgentMemory', 'stopAgent',
  'createChannel', 'updateChannel', 'deleteChannel', 'openDm', 'sendMessage', 'createTask', 'updateTask',
  'updateSettings', 'checkClaude', 'chooseDirectory', 'clearMessages',
] as const;

const api = Object.fromEntries(methods.map((m) => [m, call(m)])) as unknown as TroupeApi;
api.onState = (cb) => {
  const fn = (_: unknown, s: any) => cb(s);
  ipcRenderer.on('state', fn);
  return () => ipcRenderer.off('state', fn);
};
api.onActivity = (cb) => {
  const fn = (_: unknown, e: any) => cb(e);
  ipcRenderer.on('activity', fn);
  return () => ipcRenderer.off('activity', fn);
};

contextBridge.exposeInMainWorld('troupe', api);
