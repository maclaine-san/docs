import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, Notification, screen, shell, Tray } from 'electron';
import path from 'node:path';
import { Store } from '../core/store';
import { Orchestrator } from '../core/orchestrator';
import { ClaudeCliRunner, childEnv, claudeVersion, findClaude, loginShellPath } from '../core/claudeRunner';
import type { AppState, Message, TroupeApi } from '../shared/types';

let win: BrowserWindow | null = null;
let quick: BrowserWindow | null = null;
let tray: Tray | null = null;
let orch: Orchestrator;
let pathVar = process.env.PATH ?? '';
let registeredShortcut = '';
let quitting = false;

const preload = path.join(__dirname, 'preload.js');
const webPreferences = { preload, contextIsolation: true, nodeIntegration: false, sandbox: true };

function openLinksExternally(w: BrowserWindow) {
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createWindow(openChatId = '') {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 720,
    minHeight: 560,
    title: 'Troupe',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#161618' : '#ffffff',
    webPreferences,
  });
  win.loadFile(path.join(__dirname, 'index.html'));
  openLinksExternally(win);
  if (openChatId) win.webContents.once('did-finish-load', () => win?.webContents.send('open-chat', openChatId));
  win.on('closed', () => (win = null));
}

/** Show the main window, optionally on a specific chat. */
function showMain(chatId = '') {
  if (!win) return createWindow(chatId);
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (chatId) win.webContents.send('open-chat', chatId);
}

/**
 * Light/dark: setting nativeTheme makes prefers-color-scheme follow it in
 * every window, and also switches native parts (dialogs, scrollbars, vibrancy).
 */
function applyTheme(theme: string) {
  nativeTheme.themeSource = theme === 'light' || theme === 'dark' ? theme : 'system';
  const bg = nativeTheme.shouldUseDarkColors ? '#161618' : '#ffffff';
  win?.setBackgroundColor(bg);
}

// ---------------------------------------------------------------- quick chat (menu bar)

function createQuick() {
  quick = new BrowserWindow({
    width: 640,
    height: 460,
    show: false,
    frame: false,
    resizable: true,
    minWidth: 420,
    minHeight: 260,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    backgroundColor: '#161618',
    ...(process.platform === 'darwin' ? { vibrancy: 'popover' as const, visualEffectState: 'active' as const, backgroundColor: '#00000000' } : {}),
    webPreferences,
  });
  quick.loadFile(path.join(__dirname, 'index.html'), { query: { mode: 'quick' } });
  openLinksExternally(quick);
  // Like Spotlight: clicking elsewhere hides it.
  quick.on('blur', () => {
    if (!quick?.webContents.isDevToolsOpened()) quick?.hide();
  });
  quick.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      quick?.hide();
    }
  });
}

function showQuick(chatId = '') {
  if (!quick) createQuick();
  const q = quick!;
  // Centre near the top of the screen the mouse is on.
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const { x, y, width, height } = display.workArea;
  const [w, h] = q.getSize();
  q.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height * 0.18));
  if (process.platform === 'darwin') q.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  q.show();
  q.focus();
  const send = () => q.webContents.send('quick-shown', chatId);
  if (q.webContents.isLoading()) q.webContents.once('did-finish-load', send);
  else send();
}

function toggleQuick() {
  if (quick?.isVisible() && quick.isFocused()) quick.hide();
  else showQuick();
}
// Lets automated UI tests open the quick window without a real key press.
(globalThis as any).__troupeToggleQuick = toggleQuick;

function registerShortcut(accelerator: string) {
  if (registeredShortcut) globalShortcut.unregister(registeredShortcut);
  registeredShortcut = '';
  if (!accelerator) return;
  try {
    if (globalShortcut.register(accelerator, toggleQuick)) registeredShortcut = accelerator;
  } catch {
    /* invalid accelerator: reported by shortcutStatus */
  }
}

function trayIcon() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'trayTemplate.png'));
  img.setTemplateImage(true);
  return img;
}

function trayMenu() {
  const s = orch.state.settings;
  const u = orch.state.usage;
  const shortcut = registeredShortcut ? registeredShortcut.replace('Alt', '⌥').replace('CommandOrControl', '⌘').replace(/\+/g, '') : '';
  return Menu.buildFromTemplate([
    { label: `Quick chat${shortcut ? `    ${shortcut}` : ''}`, click: () => showQuick() },
    { label: 'Open Troupe', click: () => showMain() },
    { type: 'separator' },
    {
      label: u.fiveHour ? `5-hour usage: ${Math.round(u.fiveHour.utilization * 100)}%` : '5-hour usage: not reported yet',
      enabled: false,
    },
    { label: `${u.turnsToday}${s.dailyTurnCap ? ` / ${s.dailyTurnCap}` : ''} turns today`, enabled: false },
    { label: s.paused ? 'Resume team' : 'Pause team', click: () => orch.updateSettings({ paused: !s.paused }) },
    {
      label: 'Appearance',
      submenu: (['system', 'light', 'dark'] as const).map((t) => ({
        label: { system: 'Match macOS', light: 'Light', dark: 'Dark' }[t],
        type: 'radio' as const,
        checked: s.theme === t,
        click: () => {
          orch.updateSettings({ theme: t });
          applyTheme(t);
        },
      })),
    },
    { type: 'separator' },
    { label: 'Quit Troupe', role: 'quit' },
  ]);
}

function createTray() {
  tray = new Tray(trayIcon());
  tray.setToolTip('Troupe');
  // Build the menu on demand so the usage numbers are current.
  tray.on('click', () => tray?.popUpContextMenu(trayMenu()));
  tray.on('right-click', () => tray?.popUpContextMenu(trayMenu()));
}

// ---------------------------------------------------------------- state + notifications

/** Throttle full-state pushes to the renderers. */
let stateTimer: NodeJS.Timeout | null = null;
function pushState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    const s = snapshot();
    win?.webContents.send('state', s);
    quick?.webContents.send('state', s);
  }, 60);
}

function snapshot(): AppState {
  return JSON.parse(JSON.stringify(orch.state));
}

function notify(msg: Message) {
  if (!orch.state.settings.notifications || !Notification.isSupported()) return;
  const chat = orch.state.chats.find((c) => c.id === msg.chatId);
  // Only while you're looking elsewhere.
  const watching = chat?.quick ? quick?.isVisible() && quick.isFocused() : win?.isFocused();
  if (watching || win?.isFocused()) return;
  const agent = orch.state.agents.find((a) => a.id === msg.from);
  const n = new Notification({
    title: `${agent?.emoji ?? ''} ${agent?.name ?? 'Troupe'}`.trim(),
    subtitle: chat?.title,
    body: msg.text.replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').slice(0, 180),
    silent: false,
  });
  n.on('click', () => (chat?.quick ? showQuick(chat.id) : showMain(msg.chatId)));
  n.show();
}

async function main() {
  await app.whenReady();
  const dataDir = app.getPath('userData');
  const store = new Store(dataDir);
  pathVar = await loginShellPath();

  orch = new Orchestrator(store, new ClaudeCliRunner(), {
    claudePath: findClaude(pathVar),
    childEnv: () => childEnv(pathVar, store.state.settings.forceSubscription),
  });
  orch.seedStarterTeam();
  orch.on('state', pushState);
  orch.on('live', (l) => {
    win?.webContents.send('live', l);
    quick?.webContents.send('live', l);
  });
  orch.on('message', notify);

  const api: Omit<TroupeApi, 'onState' | 'onLive' | 'onOpenChat' | 'onQuickShown' | 'pathForFile'> = {
    getState: async () => snapshot(),
    getLive: async () => orch.getLive(),
    addAgent: async (d) => orch.addAgent(d),
    updateAgent: async (id, p) => orch.updateAgent(id, p),
    removeAgent: async (id) => orch.removeAgent(id),
    newChat: async (t, p, q) => orch.newChat(t, p, q),
    searchFiles: async (c, q) => orch.searchFiles(c, q),
    moveChat: async (c, p) => orch.moveChat(c, p),
    createProject: async (n, f) => orch.createProject(n, f),
    updateProject: async (id, p) => orch.updateProject(id, p),
    deleteProject: async (id) => orch.deleteProject(id),
    chooseDirectories: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory', 'multiSelections'] });
      return r.canceled ? [] : r.filePaths;
    },
    showInFinder: async (p) => void (await shell.openPath(p)),
    openInMain: async (c) => {
      quick?.hide();
      showMain(c);
    },
    hideQuick: async () => quick?.hide(),
    restoreCheckpoint: async (id) => orch.restoreCheckpoint(id),
    checkpointConflicts: async (id) => orch.checkpointConflicts(id),
    getActivityView: async () => orch.activityView(),
    shortcutStatus: async () => ({ accelerator: orch.state.settings.quickShortcut, ok: Boolean(registeredShortcut) }),
    setChatTarget: async (c, t) => orch.setChatTarget(c, t),
    renameChat: async (c, t) => orch.renameChat(c, t),
    deleteChat: async (c) => orch.deleteChat(c),
    sendMessage: async (c, t) => orch.userMessage(c, t),
    stopChat: async (c) => orch.stopChat(c),
    updateSettings: async (p) => {
      orch.updateSettings(p);
      if (p.theme !== undefined) applyTheme(p.theme);
      if (p.quickShortcut !== undefined) registerShortcut(p.quickShortcut);
    },
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

  applyTheme(orch.state.settings.theme);
  orch.start();
  createWindow();
  createTray();
  createQuick();
  registerShortcut(orch.state.settings.quickShortcut);
}

// Troupe keeps running in the menu bar when its window is closed. Quit from the tray menu.
app.on('window-all-closed', () => {
  /* stay alive in the menu bar */
});
app.on('activate', () => showMain());
app.on('before-quit', () => {
  quitting = true;
  orch?.shutdown();
});
app.on('will-quit', () => globalShortcut.unregisterAll());

main().catch((err) => {
  dialog.showErrorBox('Troupe failed to start', String(err?.stack ?? err));
  app.quit();
});
