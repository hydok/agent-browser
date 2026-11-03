import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { Browser, HOME_URL, normalizeUrl } from './browser';
import { startControlServer } from './control-server';
import { Library, type Entry } from './library';

// Fixed userData path so the MCP server can find control.json.
app.setPath('userData', path.join(app.getPath('appData'), 'AgentBrowser'));
app.setName('AgentBrowser');

const STATIC_DIR = path.join(__dirname, '../../static');

function registerUiCommands(win: BrowserWindow, browser: Browser) {
  const { library } = browser;
  ipcMain.on('cmd', (_e, name: string, arg: any) => {
    const space = browser.currentSpace();
    const tab = space.tabs.find((t) => t.id === space.activeTabId);
    // In an agent space the user must take control before browsing.
    const userMayAct = space.control === 'user';
    // Opens a bookmark/history entry in the current tab, or in a new tab of the
    // user's own space while an agent controls the current one.
    const open = (url: string) => {
      if (userMayAct && tab) tab.view.webContents.loadURL(url).catch(() => {});
      else browser.showTab(browser.newTab(browser.space(0), url, 'user'));
    };
    const menuItems = (entries: Entry[]) =>
      entries.map((e) => ({ label: e.title.slice(0, 60), sublabel: e.url.slice(0, 80), click: () => open(e.url) }));
    switch (name) {
      case 'toggleBookmark':
        if (tab) {
          library.toggleBookmark(tab.view.webContents.getURL(), tab.view.webContents.getTitle());
          browser.pushState();
        }
        break;
      case 'bookmarksMenu': {
        const items = menuItems([...library.bookmarks].reverse());
        Menu.buildFromTemplate(items.length ? items : [{ label: '북마크가 없습니다', enabled: false }]).popup({ window: win });
        break;
      }
      case 'historyMenu': {
        const items = menuItems(library.history.slice(0, 25));
        Menu.buildFromTemplate([
          ...(items.length ? items : [{ label: '방문 기록이 없습니다', enabled: false }]),
          { type: 'separator' },
          { label: '방문 기록 지우기', enabled: items.length > 0, click: () => library.clearHistory() },
        ]).popup({ window: win });
        break;
      }
      case 'space':
        browser.showSpace(browser.space(Number(arg)));
        break;
      case 'closeSpace':
        browser.closeSpace(browser.space(Number(arg)));
        break;
      case 'tab': {
        const target = browser.tabById(Number(arg));
        if (target) browser.showTab(target);
        break;
      }
      case 'newTab':
        if (userMayAct) browser.newTab(space, HOME_URL, 'user');
        break;
      case 'closeTab': {
        const target = browser.tabById(Number(arg));
        if (target && target.space.control === 'user') browser.closeTab(target);
        break;
      }
      case 'navigate':
        if (userMayAct && tab) tab.view.webContents.loadURL(normalizeUrl(String(arg))).catch(() => {});
        break;
      case 'back':
        if (userMayAct && tab) tab.view.webContents.navigationHistory.goBack();
        break;
      case 'forward':
        if (userMayAct && tab) tab.view.webContents.navigationHistory.goForward();
        break;
      case 'reload':
        if (userMayAct && tab) tab.view.webContents.reload();
        break;
      case 'takeControl':
        browser.setControl(space, 'user', '사용자가 직접 가져감');
        break;
      case 'returnControl':
        browser.setControl(space, 'agent');
        break;
    }
  });
}

// One instance only: a second one would overwrite control.json and split the
// agent's actions and approval dialogs across two windows.
const isPrimary = app.requestSingleInstanceLock();
if (!isPrimary) app.quit();

app.whenReady().then(async () => {
  if (!isPrimary) return;
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    title: 'AgentBrowser',
    titleBarStyle: 'hiddenInset',
    webPreferences: { preload: path.join(STATIC_DIR, 'preload.js'), sandbox: true, contextIsolation: true },
  });
  app.on('second-instance', () => {
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  await win.loadFile(path.join(STATIC_DIR, 'index.html'));
  const library = new Library(app.getPath('userData'));
  const filesDir = process.env.AGENT_BROWSER_FILES_DIR ?? path.join(app.getPath('downloads'), 'AgentBrowser');
  fs.mkdirSync(filesDir, { recursive: true });
  const browser = new Browser(win, library, filesDir);
  registerUiCommands(win, browser);
  const stopServer = await startControlServer(browser, app.getPath('userData'), STATIC_DIR);
  app.on('will-quit', () => {
    stopServer();
    library.saveHistory();
  });
});

app.on('window-all-closed', () => app.quit());
