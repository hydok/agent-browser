import type { WebContents } from 'electron';
import { deepActiveElement, extractMain, showAgentCursor } from './page-scripts';

// CDP automation for one tab: accessibility snapshot with refs, and input actions.

type AXValue = { value?: unknown };
type AXNode = {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: { name: string; value: AXValue }[];
  childIds?: string[];
  parentId?: string;
  backendDOMNodeId?: number;
};

export type DialogInfo = { type: string; message: string };
export type ElementInfo = { tag: string; type: string; label: string };
export type SnapshotOptions = { query?: string; skipNoise?: boolean };

// A document the agent can address: the page itself, or an iframe. Cross-site
// iframes run in their own process and get their own CDP session; same-site
// ones share the parent's session and are picked by frameId.
type Frame = { session?: string; frameId?: string; owner?: { parent: Frame; backendNodeId: number } };
type Ref = { frame: Frame; backendNodeId: number; info: string };

// Snapshot tree. A node with line === null is an invisible group (e.g. an unnamed
// div): it isn't printed, but keeps its children together for the query filter.
type Out = { line: string | null; text: string; children: Out[]; parent?: Out; size: number };

const SKIP_ROLES = new Set(['generic', 'none', 'GenericContainer', 'LineBreak']);
const SHOWN_PROPS = ['focused', 'checked', 'selected', 'expanded', 'disabled', 'required'];
const NOISE_ROLES = new Set(['banner', 'navigation', 'complementary', 'contentinfo']);
const NOISE_NAME = /^(광고|ad|ads|advertisement|sponsored|스폰서)$/i;
const MAX_LINES = 800;
// The query filter grows each match to the largest enclosing group up to this many lines.
const REGION_LINES = 80;
const MAX_FRAMES = 20;
const MAX_FRAME_DEPTH = 3;

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ' },
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

const DESCRIBE_FN = `function () {
  const label = this.getAttribute('aria-label') || this.innerText || this.value || this.title || '';
  return { tag: this.tagName.toLowerCase(), type: (this.type || '').toLowerCase(), label: String(label).trim().slice(0, 120) };
}`;

const ROOT: Frame = {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: string, n = 100) => (s.length > n ? s.slice(0, n) + '…' : s).replace(/"/g, '\\"').replace(/\s+/g, ' ');

export class TabAutomation {
  private refs = new Map<string, Ref>();
  // iframe targetId (== its frameId) -> CDP session of that out-of-process iframe
  private frameSessions = new Map<string, string>();
  dialog: DialogInfo | null = null;
  private dialogSession: string | undefined;
  private dialogListeners: (() => void)[] = [];
  private chooserListeners: ((c: { backendNodeId: number; session?: string }) => void)[] = [];
  // Called with each action's label, e.g. to show it in the browser's top bar.
  onAction?: (label: string) => void;

  constructor(private wc: WebContents) {
    wc.debugger.attach('1.3');
    wc.debugger.on('message', (_e, method, params, sessionId) => {
      if (method === 'Page.javascriptDialogOpening') {
        this.dialog = { type: params.type, message: params.message };
        this.dialogSession = sessionId || undefined;
        this.dialogListeners.splice(0).forEach((fn) => fn());
      }
      if (method === 'Page.javascriptDialogClosed') this.dialog = null;
      if (method === 'Page.fileChooserOpened') {
        this.chooserListeners.splice(0).forEach((fn) => fn({ backendNodeId: params.backendNodeId, session: sessionId || undefined }));
      }
      if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
        this.frameSessions.set(params.targetInfo.targetId, params.sessionId);
        void this.initSession(params.sessionId);
      }
      if (method === 'Target.detachedFromTarget') {
        for (const [id, s] of this.frameSessions) if (s === params.sessionId) this.frameSessions.delete(id);
      }
    });
    void this.initSession();
  }

  private async initSession(session?: string) {
    await this.send('Page.enable', {}, session).catch(() => {});
    await this.send('DOM.enable', {}, session).catch(() => {});
    await this.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, session).catch(() => {});
  }

  send(method: string, params: object = {}, session?: string): Promise<any> {
    return this.wc.debugger.sendCommand(method, params, session);
  }

  private assertNoDialog() {
    if (this.dialog) {
      throw new Error(`페이지에 ${this.dialog.type} 다이얼로그가 열려 있습니다("${this.dialog.message}"). page_handle_dialog로 먼저 처리하세요.`);
    }
  }

  private dialogOpened(): Promise<void> {
    return new Promise((resolve) => this.dialogListeners.push(resolve));
  }

  // Waits briefly for navigation or rendering caused by an action.
  async settle() {
    await sleep(200);
    if (!this.wc.isLoading()) return;
    await Promise.race([new Promise<void>((r) => this.wc.once('did-stop-loading', () => r())), sleep(10_000)]);
  }

  // ---- snapshot ----

  async snapshot(opts: SnapshotOptions = {}): Promise<string> {
    this.assertNoDialog();
    this.refs.clear();
    const counter = { refs: 0, frames: 0, noise: 0 };
    const root = await this.buildFrame(ROOT, 0, counter, !!opts.skipNoise);
    if (!root) return '(빈 페이지)';
    const notes: string[] = [];
    if (counter.noise) notes.push(`[잡음 영역(메뉴·사이드바·푸터·광고)의 요소 ${counter.noise}개 제외]`);

    const tokens = (opts.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return [...notes, ...print([root])].join('\n');

    const regions = pickRegions(root, tokens);
    if (!regions.length) {
      return [`[질의 "${opts.query}"와 일치하는 요소가 없어 전체 스냅샷을 반환합니다]`, ...notes, ...print([root])].join('\n');
    }
    const body = regions.map((r) => print([r]).join('\n'));
    const shown = regions.reduce((n, r) => n + r.size, 0);
    return [`[질의 "${opts.query}": 영역 ${regions.length}개, 전체 ${root.size}줄 중 ${shown}줄]`, ...notes, body.join('\n…\n')].join('\n');
  }

  private async buildFrame(frame: Frame, depth: number, counter: { refs: number; frames: number; noise: number }, skipNoise: boolean): Promise<Out | null> {
    const { nodes } = (await this.send('Accessibility.getFullAXTree', frame.frameId ? { frameId: frame.frameId } : {}, frame.session)) as { nodes: AXNode[] };
    if (!nodes.length) return null;
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    const walk = async (node: AXNode): Promise<Out | null> => {
      const role = String(node.role?.value ?? '');
      const name = String(node.name?.value ?? '').trim();
      const kids = (node.childIds ?? []).map((id) => byId.get(id)).filter((c): c is AXNode => !!c);
      if (role === 'InlineTextBox' || (role === 'StaticText' && !name)) return null;
      if (skipNoise && !node.ignored && (NOISE_ROLES.has(role) || NOISE_NAME.test(name))) {
        counter.noise += countLines(node, byId);
        return null;
      }
      if (role === 'StaticText') return leaf(`- text "${clip(name, 200)}"`, name);
      const group = node.ignored || (SKIP_ROLES.has(role) && !name);

      let line: string | null = null;
      if (!group) {
        line = `- ${role}${name ? ` "${clip(name)}"` : ''}`;
        if (node.backendDOMNodeId && role !== 'RootWebArea') {
          const ref = `@${++counter.refs}`;
          this.refs.set(ref, { frame, backendNodeId: node.backendDOMNodeId, info: `${role} "${clip(name)}"` });
          line += ` [${ref}]`;
        }
        const value = node.value?.value;
        if (value !== undefined && value !== '') line += ` value="${clip(String(value))}"`;
        for (const p of node.properties ?? []) {
          if (SHOWN_PROPS.includes(p.name) && p.value.value) line += ` [${p.name}${p.value.value === true ? '' : `=${p.value.value}`}]`;
        }
      }
      const out: Out = { line, text: `${name} ${node.value?.value ?? ''}`.toLowerCase(), children: [], size: 0 };
      for (const c of kids) {
        // The text child that just repeats this node's name adds nothing.
        if (c.role?.value === 'StaticText' && String(c.name?.value ?? '').trim() === name) continue;
        const child = await walk(c);
        if (child) out.children.push(child);
      }
      // An iframe's document isn't part of its parent's tree; fetch it separately.
      if (role === 'Iframe' && node.backendDOMNodeId && !kids.length && depth < MAX_FRAME_DEPTH && counter.frames < MAX_FRAMES) {
        counter.frames++;
        const child = await this.childFrame(frame, node.backendDOMNodeId);
        const sub = child && (await this.buildFrame(child, depth + 1, counter, skipNoise).catch(() => null));
        if (sub) out.children.push(sub);
      }
      return finish(out);
    };

    const root = nodes.find((n) => !n.parentId) ?? nodes[0];
    return walk(root);
  }

  private async childFrame(parent: Frame, backendNodeId: number): Promise<Frame | null> {
    const { node } = await this.send('DOM.describeNode', { backendNodeId }, parent.session).catch(() => ({ node: null }));
    const frameId: string | undefined = node?.frameId;
    if (!frameId) return null;
    const owner = { parent, backendNodeId };
    const session = this.frameSessions.get(frameId);
    return session ? { session, owner } : { session: parent.session, frameId, owner };
  }

  // ---- element lookup ----

  private async resolve(target: string): Promise<Ref> {
    this.assertNoDialog();
    if (/^@\d+$/.test(target)) {
      const ref = this.refs.get(target);
      if (!ref) throw new Error(`${target}: 최신 스냅샷에 없는 ref입니다. page_snapshot을 다시 호출하세요.`);
      return ref;
    }
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', {
      expression: `(() => { const m = ${matchExpr(target)}; return m.length === 1 ? m[0] : m.length; })()`,
    });
    if (exceptionDetails) throw new Error(`잘못된 선택자입니다: ${target}`);
    if (result.type === 'number') {
      throw new Error(`${target}: 일치하는 요소가 ${result.value}개입니다. 정확히 1개여야 합니다. (iframe 안의 요소는 스냅샷 ref로 지정하세요)`);
    }
    return this.refFromObject(ROOT, result.objectId, target);
  }

  private async refFromObject(frame: Frame, objectId: string, info: string): Promise<Ref> {
    const { node } = await this.send('DOM.describeNode', { objectId }, frame.session);
    await this.send('Runtime.releaseObject', { objectId }, frame.session);
    return { frame, backendNodeId: node.backendNodeId, info };
  }

  private async callOn(ref: Ref, fn: string, args: unknown[] = []): Promise<any> {
    const s = ref.frame.session;
    const { object } = await this.send('DOM.resolveNode', { backendNodeId: ref.backendNodeId }, s);
    const { result, exceptionDetails } = await this.send(
      'Runtime.callFunctionOn',
      { objectId: object.objectId, functionDeclaration: fn, arguments: args.map((value) => ({ value })), returnByValue: true },
      s,
    );
    await this.send('Runtime.releaseObject', { objectId: object.objectId }, s);
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? '페이지 스크립트 오류');
    return result.value;
  }

  // Scrolls the element into view, scrolling the iframes that contain it first.
  private async scrollIntoView(ref: Ref) {
    const owner = ref.frame.owner;
    if (owner) await this.scrollIntoView({ frame: owner.parent, backendNodeId: owner.backendNodeId, info: '' });
    await this.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: ref.backendNodeId }, ref.frame.session).catch(() => {});
  }

  // Quads of an element in an out-of-process iframe are relative to that iframe;
  // input events go to the top page, so add where each such iframe sits.
  private async frameOffset(frame: Frame): Promise<[number, number]> {
    const owner = frame.owner;
    if (!owner) return [0, 0];
    const [px, py] = await this.frameOffset(owner.parent);
    if (frame.session === owner.parent.session) return [px, py];
    const { model } = await this.send('DOM.getBoxModel', { backendNodeId: owner.backendNodeId }, owner.parent.session);
    return [px + model.content[0], py + model.content[1]];
  }

  // Element centre in top-page coordinates, where input events are sent.
  private async center(ref: Ref, target: string): Promise<[number, number]> {
    const { quads } = await this.send('DOM.getContentQuads', { backendNodeId: ref.backendNodeId }, ref.frame.session);
    if (!quads?.length) throw new Error(`${target}: 요소가 화면에 보이지 않아 클릭할 수 없습니다.`);
    const q: number[] = quads[0];
    const [ox, oy] = await this.frameOffset(ref.frame);
    return [ox + (q[0] + q[2] + q[4] + q[6]) / 4, oy + (q[1] + q[3] + q[5] + q[7]) / 4];
  }

  // Shows the agent cursor and action label on the page (best effort: never fails the action).
  private async cursor(at: [number, number] | null, label: string, click = false) {
    this.onAction?.(label);
    const [x, y] = at ?? [null, null];
    await this.send('Runtime.evaluate', {
      expression: `(${showAgentCursor})(${x}, ${y}, ${JSON.stringify(label)}, ${click})`,
    }).catch(() => {});
  }

  // Tag, input type and visible label of the target; used for the sensitive-action check.
  async describe(target: string): Promise<ElementInfo & { desc: string }> {
    const ref = await this.resolve(target);
    const info: ElementInfo = await this.callOn(ref, DESCRIBE_FN);
    return { ...info, desc: ref.info };
  }

  // Same as describe(), for whatever element has focus (a key press acts on it).
  async describeFocused(): Promise<(ElementInfo & { desc: string }) | null> {
    this.assertNoDialog();
    const candidates: Frame[] = [ROOT, ...[...this.frameSessions.values()].map((session) => ({ session }))];
    for (const frame of candidates) {
      const { result } = await this.send('Runtime.evaluate', { expression: `(${deepActiveElement})()` }, frame.session).catch(() => ({ result: {} }));
      if (!result.objectId) continue;
      const ref = await this.refFromObject(frame, result.objectId, '포커스된 요소');
      const info: ElementInfo = await this.callOn(ref, DESCRIBE_FN);
      // Focus sitting on a cross-site iframe or the bare body means it is somewhere else.
      if (info.tag === 'iframe' || info.tag === 'body') continue;
      return { ...info, desc: ref.info };
    }
    return null;
  }

  // ---- actions ----

  async click(target: string, label?: string) {
    const ref = await this.resolve(target);
    await this.scrollIntoView(ref);
    const [x, y] = await this.center(ref, target);
    await this.cursor([x, y], label || `클릭 · ${ref.info}`, true);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    // A click that opens alert/confirm does not ack until the dialog closes.
    await Promise.race([
      this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }),
      this.dialogOpened(),
    ]);
    if (!this.dialog) await this.settle();
  }

  async fill(target: string, text: string, label?: string) {
    const ref = await this.resolve(target);
    await this.scrollIntoView(ref);
    await this.cursor(await this.center(ref, target).catch(() => null), label || `입력 · ${ref.info}`);
    await this.send('DOM.focus', { backendNodeId: ref.backendNodeId }, ref.frame.session);
    await this.callOn(
      ref,
      `function () {
        if (this.select) { this.select(); return; }
        if (this.isContentEditable) {
          const r = document.createRange(); r.selectNodeContents(this);
          const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        }
      }`,
    );
    if (text) await this.send('Input.insertText', { text });
    else await this.key('Backspace', 0);
  }

  async select(target: string, value: string, label?: string): Promise<string> {
    const ref = await this.resolve(target);
    await this.cursor(await this.center(ref, target).catch(() => null), label || `선택 · ${value}`);
    return this.callOn(
      ref,
      `function (v) {
        if (this.tagName !== 'SELECT') throw new Error('select 요소가 아닙니다');
        const o = Array.from(this.options).find((o) => o.value === v || o.label.trim() === v || o.text.trim() === v);
        if (!o) throw new Error('일치하는 옵션이 없습니다: ' + v);
        this.value = o.value;
        this.dispatchEvent(new Event('input', { bubbles: true }));
        this.dispatchEvent(new Event('change', { bubbles: true }));
        return o.label;
      }`,
      [value],
    );
  }

  async press(combo: string, target?: string, label?: string) {
    if (target) {
      const ref = await this.resolve(target);
      await this.send('DOM.focus', { backendNodeId: ref.backendNodeId }, ref.frame.session);
    } else {
      this.assertNoDialog();
    }
    await this.cursor(null, label || `키 · ${combo}`);
    const parts = combo.split('+');
    const key = parts.pop()!;
    let modifiers = 0;
    for (const m of parts) {
      if (!(m in MODIFIERS)) throw new Error(`알 수 없는 보조키: ${m} (Alt, Control, Meta, Shift)`);
      modifiers |= MODIFIERS[m];
    }
    await Promise.race([this.key(key, modifiers), this.dialogOpened()]);
    if (!this.dialog) await this.settle();
  }

  private async key(key: string, modifiers: number) {
    const def = KEYS[key] ?? (key.length === 1 ? { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key } : null);
    if (!def) throw new Error(`알 수 없는 키: ${key}`);
    const text = modifiers & (MODIFIERS.Control | MODIFIERS.Meta) ? undefined : def.text;
    const base = { key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers };
    await this.send('Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text });
    await this.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }

  // Puts files into a file input, or into the chooser that clicking the target opens.
  async upload(target: string, files: string[], label?: string) {
    const ref = await this.resolve(target);
    const info: ElementInfo = await this.callOn(ref, DESCRIBE_FN);
    if (info.tag === 'input' && info.type === 'file') {
      await this.cursor(await this.center(ref, target).catch(() => null), label || `업로드 · 파일 ${files.length}개`);
      await this.send('DOM.setFileInputFiles', { files, backendNodeId: ref.backendNodeId }, ref.frame.session);
      return;
    }
    const s = ref.frame.session;
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true }, s);
    try {
      let timer: NodeJS.Timeout | undefined;
      const opened = new Promise<{ backendNodeId: number; session?: string }>((resolve, reject) => {
        this.chooserListeners.push(resolve);
        timer = setTimeout(() => reject(new Error(`${target}을(를) 눌러도 파일 선택 창이 열리지 않았습니다. 파일 입력칸을 직접 지정하세요.`)), 5000);
      });
      await this.click(target, label || `업로드 · 파일 ${files.length}개`);
      const chooser = await opened.finally(() => clearTimeout(timer));
      await this.send('DOM.setFileInputFiles', { files, backendNodeId: chooser.backendNodeId }, chooser.session);
    } finally {
      this.chooserListeners.length = 0;
      await this.send('Page.setInterceptFileChooserDialog', { enabled: false }, s).catch(() => {});
    }
  }

  async scroll(deltaY: number) {
    this.assertNoDialog();
    const { cssVisualViewport: v } = await this.send('Page.getLayoutMetrics');
    const x = v.clientWidth / 2;
    const y = v.clientHeight / 2;
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY });
    await sleep(300);
  }

  async extract(format: 'markdown' | 'text'): Promise<string> {
    return this.evaluate(`(${extractMain})(${JSON.stringify(format)})`);
  }

  // Polls until the target (ref, CSS selector or text=...) is present.
  async waitFor(target: string, timeoutMs: number) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      this.assertNoDialog();
      if (/^@\d+$/.test(target)) return;
      const { result } = await this.send('Runtime.evaluate', { expression: `${matchExpr(target)}.length` }).catch(() => ({ result: {} }));
      if (result.value > 0) return;
      if (Date.now() > end) throw new Error(`${timeoutMs}ms 안에 ${target}이(가) 나타나지 않았습니다.`);
      await sleep(200);
    }
  }

  // Runs an expression in the top document and returns its (JSON-serializable) value.
  async evaluate(expression: string): Promise<any> {
    this.assertNoDialog();
    const { result, exceptionDetails } = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split('\n')[0] ?? exceptionDetails.text);
    return result.value;
  }

  async screenshot(fullPage: boolean): Promise<string> {
    this.assertNoDialog();
    // CDP capture also works while the tab's view is hidden (capturePage does not).
    const params: Record<string, unknown> = { format: 'png' };
    if (fullPage) {
      const { cssContentSize: s } = await this.send('Page.getLayoutMetrics');
      params.captureBeyondViewport = true;
      params.clip = { x: 0, y: 0, width: s.width, height: Math.min(s.height, 16_000), scale: 1 };
    }
    const { data } = await Promise.race([
      this.send('Page.captureScreenshot', params),
      sleep(15_000).then(() => {
        throw new Error('스크린샷이 시간 초과되었습니다.');
      }),
    ]);
    return data;
  }

  async handleDialog(accept: boolean, promptText?: string) {
    if (!this.dialog) throw new Error('열려 있는 다이얼로그가 없습니다.');
    await this.send('Page.handleJavaScriptDialog', { accept, promptText }, this.dialogSession);
    this.dialog = null;
    await this.settle();
  }
}

// Page expression for the elements a CSS selector or text=... target matches.
// Selectors search the top document only; elements inside iframes need a ref.
function matchExpr(target: string): string {
  if (!target.startsWith('text=')) return `Array.from(document.querySelectorAll(${JSON.stringify(target)}))`;
  return `(() => { const q = ${JSON.stringify(target.slice(5).toLowerCase())};
    const all = Array.from(document.querySelectorAll('body *')).filter((e) => (e.innerText || '').toLowerCase().includes(q));
    return all.filter((e) => !all.some((o) => o !== e && e.contains(o))); })()`;
}

// ---- snapshot tree helpers ----

function leaf(line: string, text: string): Out {
  return { line, text: text.toLowerCase(), children: [], size: 1 };
}

function finish(out: Out): Out | null {
  // Drop empty groups and collapse a group with a single child into that child.
  if (out.line === null && out.children.length === 0) return null;
  if (out.line === null && out.children.length === 1) return out.children[0];
  out.size = (out.line ? 1 : 0) + out.children.reduce((n, c) => n + c.size, 0);
  for (const c of out.children) c.parent = out;
  return out;
}

function countLines(node: AXNode, byId: Map<string, AXNode>): number {
  return 1 + (node.childIds ?? []).reduce((n, id) => n + (byId.has(id) ? countLines(byId.get(id)!, byId) : 0), 0);
}

function print(nodes: Out[], depth = 0, lines: string[] = []): string[] {
  for (const n of nodes) {
    if (lines.length >= MAX_LINES) {
      if (lines.at(-1) !== TRUNCATED) lines.push(TRUNCATED);
      break;
    }
    if (n.line) lines.push('  '.repeat(depth) + n.line);
    print(n.children, n.line ? depth + 1 : depth, lines);
  }
  return lines;
}
const TRUNCATED = `[스냅샷이 ${MAX_LINES}줄에서 잘렸습니다. query나 skipNoise로 줄이세요]`;

// For each node whose text contains a query token, the largest enclosing group
// of at most REGION_LINES lines — so a match like the heading "날씨" brings along
// the temperatures next to it. Nested picks are merged into their outermost one.
// A match on a node already bigger than that (the page root titled "서울 날씨",
// a large section) is skipped; matches inside it decide instead.
function pickRegions(root: Out, tokens: string[]): Out[] {
  const picked = new Set<Out>();
  const visit = (n: Out) => {
    if (n.line && n.size <= REGION_LINES && tokens.some((t) => n.text.includes(t))) {
      let r = n;
      while (r.parent && r.parent.size <= REGION_LINES) r = r.parent;
      picked.add(r);
    }
    n.children.forEach(visit);
  };
  visit(root);
  const inPicked = (n: Out): boolean => !!n.parent && (picked.has(n.parent) || inPicked(n.parent));
  return [...picked].filter((r) => !inPicked(r));
}
