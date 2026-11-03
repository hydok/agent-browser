import { BrowserWindow, WebContentsView, dialog, session, type DownloadItem, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { TabAutomation } from './automation';
import type { Library } from './library';

export const CHROME_HEIGHT = 84;
export const HOME_URL = 'https://www.google.com';

export type Owner = 'user' | 'agent';

export interface Tab {
  id: number;
  label: string;
  space: Space;
  view: WebContentsView;
  auto: TabAutomation;
  openedBy: Owner;
}

export interface Space {
  id: number;
  name: string;
  owner: Owner;
  // Who may act in the space right now. Agent calls fail while it is 'user'.
  control: Owner;
  handoffReason: string | null;
  // Last agent action, shown next to "에이전트 작업 중" in the top bar.
  lastAction: string | null;
  tabs: Tab[];
  activeTabId: number | null;
  nextLabel: number;
}

export interface DownloadInfo {
  filename: string;
  path: string;
  bytes: number;
  state: string;
  url: string;
}

// A free path for name in dir: "report.txt", then "report (1).txt", ...
function uniquePath(dir: string, name: string): string {
  const safe = path.basename(name).replace(/[\\/:]/g, '_') || 'download';
  const { name: stem, ext } = path.parse(safe);
  for (let i = 0; ; i++) {
    const file = path.join(dir, i ? `${stem} (${i})${ext}` : safe);
    if (!fs.existsSync(file)) return file;
  }
}

export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^[^\s]+\.[^\s]+$/.test(s) || s.startsWith('localhost')) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

export class Browser {
  spaces: Space[] = [];
  currentSpaceId = 0;
  private nextSpaceId = 1;
  private nextTabId = 1;
  private controlWaiters = new Map<number, (() => void)[]>();
  private downloadWaiters = new Map<number, ((d: DownloadInfo) => void)[]>();

  // filesDir: where agent downloads are saved, and the folder agents may upload from without approval.
  constructor(private win: BrowserWindow, readonly library: Library, readonly filesDir: string) {
    const mine = this.addSpace('내 탭', 'user');
    this.newTab(mine, HOME_URL, 'user');
    win.on('resize', () => this.layout());
    session.defaultSession.on('will-download', (_e, item, wc) => this.onDownload(item, wc));
  }

  // Agent downloads go straight to filesDir; the user's own keep Electron's save dialog.
  private onDownload(item: DownloadItem, wc: WebContents) {
    const tab = this.spaces.flatMap((s) => s.tabs).find((t) => t.view.webContents === wc);
    if (!tab || tab.space.owner !== 'agent') return;
    const file = uniquePath(this.filesDir, item.getFilename());
    item.setSavePath(file);
    item.once('done', (_e, state) => {
      const info = { filename: path.basename(file), path: file, bytes: item.getReceivedBytes(), state, url: item.getURL() };
      this.downloadWaiters.get(tab.id)?.splice(0).forEach((fn) => fn(info));
    });
  }

  // Resolves when the next download started from this tab finishes.
  waitForDownload(tab: Tab, timeoutMs: number): Promise<DownloadInfo> {
    return new Promise((resolve, reject) => {
      const waiters = this.downloadWaiters.get(tab.id) ?? [];
      this.downloadWaiters.set(tab.id, waiters);
      const done = (info: DownloadInfo) => {
        clearTimeout(timer);
        resolve(info);
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(done), 1);
        reject(new Error(`${timeoutMs / 1000}초 안에 다운로드가 시작되거나 끝나지 않았습니다.`));
      }, timeoutMs);
      waiters.push(done);
    });
  }

  private addSpace(name: string, owner: Owner): Space {
    const space: Space = {
      id: owner === 'user' ? 0 : this.nextSpaceId++,
      name,
      owner,
      control: owner,
      handoffReason: null,
      lastAction: null,
      tabs: [],
      activeTabId: null,
      nextLabel: 1,
    };
    this.spaces.push(space);
    return space;
  }

  space(id: number): Space {
    const space = this.spaces.find((s) => s.id === id);
    if (!space) throw new Error(`Space ${id}가 없습니다. space_list로 확인하세요.`);
    return space;
  }

  // Resumes the agent space with the same name, or creates one with a blank p1.
  openAgentSpace(name: string): Space {
    const existing = this.spaces.find((s) => s.owner === 'agent' && s.name === name);
    if (existing) return existing;
    const space = this.addSpace(name, 'agent');
    this.newTab(space, 'about:blank', 'agent');
    this.pushState();
    return space;
  }

  closeSpace(space: Space) {
    if (space.owner === 'user') return;
    for (const tab of [...space.tabs]) this.destroyTab(tab);
    this.spaces = this.spaces.filter((s) => s !== space);
    this.controlWaiters.get(space.id)?.splice(0).forEach((fn) => fn());
    if (this.currentSpaceId === space.id) this.currentSpaceId = 0;
    this.layout();
    this.pushState();
  }

  newTab(space: Space, url: string, openedBy: Owner): Tab {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false } });
    this.win.contentView.addChildView(view);
    const tab: Tab = {
      id: this.nextTabId++,
      label: `p${space.nextLabel++}`,
      space,
      view,
      auto: new TabAutomation(view.webContents),
      openedBy,
    };
    tab.auto.onAction = (label) => {
      space.lastAction = label;
      this.pushState();
    };
    space.tabs.push(tab);
    space.activeTabId = tab.id;
    const wc = view.webContents;
    for (const event of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-stop-loading'] as const) {
      wc.on(event as 'did-stop-loading', () => this.pushState());
    }
    // History records the user's own browsing only, not what agents visit.
    if (space.owner === 'user') {
      wc.on('did-navigate', (_e, url) => this.library.addVisit(url, wc.getTitle()));
      wc.on('page-title-updated', (_e, title) => this.library.updateTitle(wc.getURL(), title));
    }
    // Popups open as a new tab in the same space.
    wc.setWindowOpenHandler(({ url }) => {
      this.newTab(space, url, tab.openedBy);
      return { action: 'deny' };
    });
    this.layout();
    this.pushState();
    // Loading about:blank would race with (and abort) the agent's first navigation.
    if (url && url !== 'about:blank') wc.loadURL(url).catch(() => {});
    return tab;
  }

  private destroyTab(tab: Tab) {
    const space = tab.space;
    space.tabs = space.tabs.filter((t) => t !== tab);
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (space.activeTabId === tab.id) space.activeTabId = space.tabs.at(-1)?.id ?? null;
  }

  closeTab(tab: Tab) {
    const space = tab.space;
    this.destroyTab(tab);
    if (space.owner === 'user' && space.tabs.length === 0) this.newTab(space, HOME_URL, 'user');
    this.layout();
    this.pushState();
  }

  findTab(space: Space, label: string): Tab {
    const tab = space.tabs.find((t) => t.label === label);
    if (!tab) throw new Error(`Space ${space.id}에 페이지 ${label}이 없습니다. 있는 페이지: ${space.tabs.map((t) => t.label).join(', ') || '없음'}`);
    return tab;
  }

  tabById(id: number): Tab | undefined {
    for (const s of this.spaces) {
      const tab = s.tabs.find((t) => t.id === id);
      if (tab) return tab;
    }
  }

  currentSpace(): Space {
    return this.space(this.currentSpaceId);
  }

  showSpace(space: Space) {
    this.currentSpaceId = space.id;
    this.layout();
    this.pushState();
  }

  showTab(tab: Tab) {
    tab.space.activeTabId = tab.id;
    this.showSpace(tab.space);
  }

  assertAgentControl(space: Space) {
    if (space.owner === 'user') throw new Error('사용자 공간(Space 0)은 에이전트가 조작할 수 없습니다. space_open으로 에이전트 Space를 만드세요.');
    if (space.control === 'user') {
      throw new Error(`사용자가 Space ${space.id}를 제어 중입니다. space_handoff로 사용자가 돌려줄 때까지 기다리거나 작업을 중단하세요.`);
    }
  }

  setControl(space: Space, control: Owner, reason: string | null = null) {
    if (space.owner === 'user') return;
    space.control = control;
    space.handoffReason = control === 'user' ? reason : null;
    if (control === 'agent') this.controlWaiters.get(space.id)?.splice(0).forEach((fn) => fn());
    this.pushState();
  }

  // Resolves true once the user returns control, false on timeout.
  waitForAgentControl(space: Space, timeoutMs: number): Promise<boolean> {
    if (space.control === 'agent') return Promise.resolve(true);
    return new Promise((resolve) => {
      const waiters = this.controlWaiters.get(space.id) ?? [];
      this.controlWaiters.set(space.id, waiters);
      const done = () => {
        clearTimeout(timer);
        resolve(space.control === 'agent' && this.spaces.includes(space));
      };
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(done), 1);
        resolve(false);
      }, timeoutMs);
      waiters.push(done);
    });
  }

  // Shows the tab to the user and asks for approval of a sensitive action.
  async confirm(tab: Tab, action: string, detail: string): Promise<boolean> {
    // Test hook: lets test/e2e.mjs check approval without a person at the dialog.
    if (process.env.AGENT_BROWSER_AUTO_DENY === '1') return false;
    this.showTab(tab);
    if (this.win.isMinimized()) this.win.restore();
    this.win.focus();
    // Deny is index 0: a dialog dismissed any other way (window closed, app quit)
    // resolves with 0, so only an explicit click on 허용 approves.
    const { response } = await dialog.showMessageBox(this.win, {
      type: 'warning',
      buttons: ['거부', '허용'],
      defaultId: 0,
      cancelId: 0,
      message: `에이전트 "${tab.space.name}"가 민감한 동작을 하려 합니다: ${action}`,
      detail: `${detail}\n페이지: ${tab.view.webContents.getURL()}`,
    });
    return response === 1;
  }

  layout() {
    const { width, height } = this.win.getContentBounds();
    const bounds = { x: 0, y: CHROME_HEIGHT, width, height: Math.max(0, height - CHROME_HEIGHT) };
    // Background tabs stay visible underneath the shown one instead of being hidden or
    // moved off-screen: hidden views stop producing frames (screenshots time out) and
    // off-screen views drop input, both of which break agent tabs the user isn't viewing.
    for (const space of this.spaces) for (const tab of space.tabs) tab.view.setBounds(bounds);
    const shown = this.currentSpace().tabs.find((t) => t.id === this.currentSpace().activeTabId);
    if (shown) this.win.contentView.addChildView(shown.view); // re-adding raises it to the top
  }

  tabSummary(tab: Tab) {
    const wc = tab.view.webContents;
    return { label: tab.label, url: wc.getURL(), title: wc.getTitle(), openedBy: tab.openedBy };
  }

  state() {
    return {
      currentSpaceId: this.currentSpaceId,
      spaces: this.spaces.map((s) => ({
        id: s.id,
        name: s.name,
        owner: s.owner,
        control: s.control,
        handoffReason: s.handoffReason,
        lastAction: s.lastAction,
        activeTabId: s.activeTabId,
        tabs: s.tabs.map((t) => ({
          id: t.id,
          ...this.tabSummary(t),
          bookmarked: this.library.isBookmarked(t.view.webContents.getURL()),
          loading: t.view.webContents.isLoading(),
          canGoBack: t.view.webContents.navigationHistory.canGoBack(),
          canGoForward: t.view.webContents.navigationHistory.canGoForward(),
        })),
      })),
    };
  }

  pushState() {
    if (!this.win.isDestroyed()) this.win.webContents.send('state', this.state());
  }
}
