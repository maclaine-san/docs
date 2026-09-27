import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { Store } from '../core/store';
import { Orchestrator } from '../core/orchestrator';
import { ClaudeCliRunner, childEnv, claudeVersion, findClaude, loginShellPath } from '../core/claudeRunner';
import { startBridge } from '../core/bridge';
import type { AppState, TroupeApi } from '../shared/types';
import { USER_ID } from '../shared/types';

let win: BrowserWindow | null = null;
let orch: Orchestrator;
let closeBridge = () => {};
let pathVar = process.env.PATH ?? '';

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 560,
    title: 'Troupe',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#101114',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
}

/** Throttle full-state pushes to the renderer. */
let stateTimer: NodeJS.Timeout | null = null;
function pushState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    win?.webContents.send('state', snapshot());
  }, 60);
}

function snapshot(): AppState {
  return JSON.parse(JSON.stringify(orch.state));
}

async function main() {
  await app.whenReady();
  const dataDir = app.getPath('userData');
  const store = new Store(dataDir);
  pathVar = await loginShellPath();

  orch = new Orchestrator(store, new ClaudeCliRunner(), {
    claudePath: findClaude(pathVar),
    childEnv: () => childEnv(pathVar, store.state.settings.forceSubscription),
    // Run the bundled MCP server with Electron's own Node runtime.
    mcpCommand: process.execPath,
    mcpArgs: [path.join(__dirname, 'mcp.js')],
    mcpEnv: { ELECTRON_RUN_AS_NODE: '1' },
  });
  orch.on('state', pushState);
  orch.on('activity', (e) => win?.webContents.send('activity', e));

  const api: Omit<TroupeApi, 'onState' | 'onActivity'> = {
    getState: async () => snapshot(),
    getActivity: async (id) => orch.getActivity(id),
    hireAgent: async (d) => orch.hireAgent(d),
    updateAgent: async (id, p) => orch.updateAgent(id, p),
    fireAgent: async (id) => orch.fireAgent(id),
    resetAgentMemory: async (id) => orch.resetAgentMemory(id),
    stopAgent: async (id) => orch.stopAgent(id),
    createChannel: async (n, m, t) => orch.createChannel(n, m, t),
    updateChannel: async (id, p) => orch.updateChannel(id, p),
    deleteChannel: async (id) => orch.deleteChannel(id),
    openDm: async (id) => orch.dm(USER_ID, id),
    sendMessage: async (c, t) => orch.userMessage(c, t),
    createTask: async (t) => orch.createTask(USER_ID, t, 0),
    updateTask: async (id, p) => void orch.updateTask(USER_ID, id, p, 0),
    updateSettings: async (p) => orch.updateSettings(p),
    clearMessages: async (id) => orch.clearMessages(id),
    chooseDirectory: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    },
    checkClaude: async () => {
      const p = orch.state.settings.claudePath || findClaude(pathVar);
      if (!p) return { ok: false, path: '', version: '', error: 'claude CLI not found. Install Claude Code and run `claude` once to log in.' };
      try {
        const version = await claudeVersion(p, childEnv(pathVar, orch.state.settings.forceSubscription));
        return { ok: true, path: p, version };
      } catch (e) {
        return { ok: false, path: p, version: '', error: (e as Error).message };
      }
    },
  };

  ipcMain.handle('troupe', async (_e, method: keyof typeof api, ...args: unknown[]) => {
    const fn = api[method] as (...a: unknown[]) => Promise<unknown>;
    if (!fn) throw new Error(`Unknown method ${String(method)}`);
    return fn(...args);
  });

  const bridge = await startBridge(orch);
  closeBridge = bridge.close;
  orch.start(bridge.url);
  createWindow();
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (!win && app.isReady()) createWindow();
});
app.on('before-quit', () => {
  orch?.shutdown();
  closeBridge();
});

main().catch((err) => {
  dialog.showErrorBox('Troupe failed to start', String(err?.stack ?? err));
  app.quit();
});
