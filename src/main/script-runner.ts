import { BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';

// Runs an agent's script in a hidden, sandboxed window (no Node, no file access).
// The script drives pages only through `page(label)`, whose calls go through the
// same RPC methods as the MCP tools, so approvals and control checks still apply.

type Dispatch = (method: string, params: Record<string, any>) => Promise<unknown>;

const ALLOWED = new Set([
  'page.navigate', 'page.snapshot', 'page.extract', 'page.click', 'page.fill', 'page.select', 'page.press',
  'page.scroll', 'page.handleDialog', 'page.close', 'page.new', 'page.evaluate', 'page.waitFor', 'page.upload', 'page.download',
]);
const MAX_LOGS = 200;

const PRELUDE = `
const __call = async (method, params) => {
  const r = await window.__host.call(method, params);
  if (r.error) throw new Error(r.error);
  return r.result;
};
const __fmt = (a) => (typeof a === 'string' ? a : JSON.stringify(a));
console.log = console.info = console.warn = console.error = (...a) => window.__host.log(a.map(__fmt).join(' '));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (label = 'p1') => ({
  label,
  goto: (url) => __call('page.navigate', { page: label, url }),
  snapshot: (opts = {}) => __call('page.snapshot', { page: label, ...opts }),
  extract: (format = 'markdown') => __call('page.extract', { page: label, format }),
  click: (target) => __call('page.click', { page: label, target }),
  fill: (target, text) => __call('page.fill', { page: label, target, text }),
  select: (target, value) => __call('page.select', { page: label, target, value }),
  press: (key, target) => __call('page.press', { page: label, key, target }),
  scroll: (deltaY = 600) => __call('page.scroll', { page: label, deltaY }),
  evaluate: (expression) => __call('page.evaluate', { page: label, expression }),
  waitFor: (target, timeoutMs = 10000) => __call('page.waitFor', { page: label, target, timeoutMs }),
  upload: (target, files) => __call('page.upload', { page: label, target, files }),
  download: (opts) => __call('page.download', { page: label, ...opts }),
  handleDialog: (accept, promptText) => __call('page.handleDialog', { page: label, accept, promptText }),
  close: () => __call('page.close', { page: label }),
});
const newPage = async (url) => page((await __call('page.new', { url })).label);
`;

const runs = new Map<number, { spaceId: number; logs: string[] }>();

export function initScriptRunner(dispatch: Dispatch) {
  ipcMain.handle('script-call', async (e, method: string, params: Record<string, any>) => {
    const run = runs.get(e.sender.id);
    if (!run) return { error: '실행 중인 스크립트가 아닙니다.' };
    if (!ALLOWED.has(method)) return { error: `스크립트에서 쓸 수 없는 동작입니다: ${method}` };
    try {
      // A script can only touch the space it was started for.
      return { result: await dispatch(method, { ...params, spaceId: run.spaceId }) };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.on('script-log', (e, text: string) => {
    const logs = runs.get(e.sender.id)?.logs;
    if (logs && logs.length < MAX_LOGS) logs.push(String(text).slice(0, 2000));
  });
}

export async function runScript(spaceId: number, code: string, timeoutMs: number, preloadDir: string) {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: path.join(preloadDir, 'script-preload.js'), sandbox: true, contextIsolation: true },
  });
  const run = { spaceId, logs: [] as string[] };
  runs.set(win.webContents.id, run);
  let timer: NodeJS.Timeout | undefined;
  try {
    await win.loadURL('about:blank');
    const wrapped = `${PRELUDE}
(async () => {
${code}
})().then(
  (v) => { try { return { value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }; } catch { return { value: String(v) }; } },
  (e) => ({ error: String((e && e.message) || e) }),
)`;
    const timeout = new Promise<{ error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ error: `${timeoutMs / 1000}초 안에 끝나지 않아 중단했습니다.` }), timeoutMs);
    });
    const result = await Promise.race([win.webContents.executeJavaScript(wrapped, true), timeout]);
    return { ...result, logs: run.logs };
  } finally {
    clearTimeout(timer);
    runs.delete(win.webContents.id);
    win.destroy();
  }
}
