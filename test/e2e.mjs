// End-to-end check: drives the running AgentBrowser app through the MCP server.
// Usage: npm run start:test (in another terminal; auto-denies approvals), then npm test
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = pathToFileURL(path.join(here, 'fixture.html')).href;

// Serves test/pages. The same server is reached as 127.0.0.1 and as localhost,
// which are different sites, so an iframe from the other one is cross-site.
const server = http.createServer((req, res) => {
  const file = path.join(here, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!file.startsWith(path.join(here, 'pages')) || !fs.existsSync(file)) return res.writeHead(404).end();
  const headers = { 'content-type': file.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8' };
  if (req.url.includes('?download')) headers['content-disposition'] = `attachment; filename="${path.basename(file)}"`;
  res.writeHead(200, headers);
  res.end(fs.readFileSync(file, 'utf8').replaceAll('{{OTHER}}', `http://localhost:${server.address().port}`));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${server.address().port}`;

const client = new Client({ name: 'e2e', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [path.join(here, '../dist/mcp/server.js')] }));

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  const c = r.content[0];
  return c.type === 'text' ? (c.text.startsWith('{') || c.text.startsWith('[') ? JSON.parse(c.text) : c.text) : c;
};
const step = (msg) => console.log(`✓ ${msg}`);

const { tools } = await client.listTools();
assert.ok(tools.length >= 13);
step(`도구 ${tools.length}개 노출`);

const space = await call('space_open', { name: `e2e-${Date.now()}` });
const spaceId = space.spaceId;
step(`Space ${spaceId} 열림`);

const nav = await call('page_navigate', { spaceId, url: fixture });
assert.equal(nav.title, '테스트 폼');
const snap = await call('page_snapshot', { spaceId });
assert.match(snap, /<page-content trust="untrusted">/);
const ref = (role, name) => snap.match(new RegExp(`${role} "${name}"[^\\n]*\\[(@\\d+)\\]`))?.[1];
const nameRef = ref('textbox', '이름');
assert.ok(nameRef, snap);
step(`스냅샷에서 이름 입력칸 ref ${nameRef} 찾음`);

await call('page_fill', { spaceId, target: nameRef, text: '홍길동' });
await call('page_select', { spaceId, target: '#city', value: '부산' });
const afterSave = await call('page_click', { spaceId, target: 'text=저장', snapshot: true });
assert.match(afterSave.snapshot, /저장됨: 홍길동 \/ busan/);
step('입력·선택·클릭 → "저장됨: 홍길동 / busan"');

const afterAsk = await call('page_click', { spaceId, target: '#ask' });
assert.equal(afterAsk.dialog?.type, 'confirm');
await call('page_handle_dialog', { spaceId, accept: true });
assert.match(await call('page_snapshot', { spaceId }), /확인 누름/);
step('confirm 다이얼로그 감지 후 수락');

const popup = await call('page_click', { spaceId, target: 'text=새 창 링크' });
assert.deepEqual(popup.newPages, ['p2']);
await call('page_close', { spaceId, page: 'p2' });
step('target=_blank 링크 → 같은 Space의 p2로 열고 닫음');

await call('page_fill', { spaceId, target: nameRef.replace(/\d+/, '99999'), text: 'x' }).then(
  () => assert.fail('stale ref accepted'),
  (e) => assert.match(e.message, /최신 스냅샷에 없는 ref/),
);
step('없는 ref는 오류로 거절');

const denied = (e) => assert.match(e.message, /거부/);
const bypassed = () => assert.fail('sensitive action ran without approval');
await call('page_click', { spaceId, target: '#del' }).then(bypassed, denied);
await call('page_press', { spaceId, target: '#del', key: 'Enter' }).then(bypassed, denied);
await call('page_press', { spaceId, target: '#ask', key: 'Tab' }); // focus moves to 삭제
await call('page_press', { spaceId, key: 'Enter' }).then(bypassed, denied);
assert.doesNotMatch(await call('page_snapshot', { spaceId }), /삭제 실행됨/);
step('삭제: 클릭·Enter(대상 지정)·Enter(포커스) 모두 승인 요청 → 거부되어 실행 안 됨');

// #10: query filter, noise removal, main-content extraction
await call('page_navigate', { spaceId, url: `${site}/pages/portal.html` });
const full = await call('page_snapshot', { spaceId });
const weather = await call('page_snapshot', { spaceId, query: '날씨' });
assert.match(weather, /18°C/);
assert.match(weather, /맑음/);
assert.doesNotMatch(weather, /경제 뉴스|쇼핑 할인|이용약관|메일/);
const lines = (t) => t.split('\n').length;
step(`query="날씨": ${lines(full)}줄 → ${lines(weather)}줄 (기온·날씨만 남고 뉴스·광고·메뉴 제외)`);

const none = await call('page_snapshot', { spaceId, query: '없는단어xyz' });
assert.match(none, /일치하는 요소가 없어 전체 스냅샷/);
assert.match(none, /경제 뉴스 40번/);
step('일치 없음 → 전체 스냅샷으로 되돌아감');

const clean = await call('page_snapshot', { spaceId, skipNoise: true });
assert.doesNotMatch(clean, /쇼핑 할인|이용약관|"메일"/);
assert.match(clean, /경제 뉴스 1번/);
step(`skipNoise: ${lines(full)}줄 → ${lines(clean)}줄 (메뉴·광고·푸터 제외)`);

const article = await call('page_extract', { spaceId });
assert.match(article, /# 기사 제목/);
assert.match(article, /첫 문단입니다/);
assert.doesNotMatch(article, /경제 뉴스|쇼핑 할인|이용약관/);
step('page_extract: 기사 본문만 마크다운으로 (뉴스 목록·광고·푸터 제외)');

// #11: iframes, same-site (shares the page's process) and cross-site (its own process)
await call('page_navigate', { spaceId, url: `${site}/pages/frames.html` });
const frames = await call('page_snapshot', { spaceId });
const inner = frames.match(/button "안쪽 버튼" \[(@\d+)\]/)?.[1];
const code = frames.match(/textbox "코드" \[(@\d+)\]/)?.[1];
const ok = frames.match(/button "확인" \[(@\d+)\]/)?.[1];
assert.ok(inner && code && ok, frames);
step('스냅샷에 같은 출처·교차 출처 iframe 안의 요소가 모두 나옴');

const sameSite = await call('page_click', { spaceId, target: inner, snapshot: true });
assert.match(sameSite.snapshot, /같은 출처 클릭됨/);
step('같은 출처 iframe 안 버튼 클릭');

await call('page_fill', { spaceId, target: code, text: 'A-123' });
const crossSite = await call('page_click', { spaceId, target: ok, snapshot: true });
assert.match(crossSite.snapshot, /교차 출처 클릭됨: A-123/);
step('교차 출처 iframe 안 입력 + 클릭 (별도 프로세스, 좌표 보정)');

// #14: several actions in one script run, in a sandbox
const script = (code, timeoutSec) => call('browser_run_script', { spaceId, code, ...(timeoutSec && { timeoutSec }) });
const t0 = Date.now();
const run = await script(`
  const p = page();
  await p.goto(${JSON.stringify(fixture)});
  await p.fill('#name', '스크립트');
  await p.select('#city', '서울');
  await p.click('#save');
  console.log('저장 버튼 누름');
  return await p.evaluate("document.getElementById('out').textContent");
`);
assert.equal(run.value, '저장됨: 스크립트 / seoul', JSON.stringify(run));
assert.deepEqual(run.logs, ['저장 버튼 누름']);
step(`스크립트 1회로 이동·입력·선택·클릭·확인 (${Date.now() - t0}ms)`);

const sandbox = await script(`
  return {
    require: typeof require,
    process: typeof process,
    file: await fetch('file:///etc/hosts').then(() => '읽힘', () => '막힘'),
  };
`);
assert.deepEqual(sandbox.value, { require: 'undefined', process: 'undefined', file: '막힘' });
step('샌드박스: require·process 없음, 로컬 파일 읽기 막힘');

assert.match((await script(`await page().click('#del'); return '실행됨';`)).error, /거부/);
assert.doesNotMatch(await call('page_snapshot', { spaceId }), /삭제 실행됨/);
step('스크립트 안의 삭제 클릭도 승인 요청 → 거부되어 실행 안 됨');

assert.match((await script(`await sleep(5000);`, 1)).error, /1초 안에 끝나지 않아 중단/);
assert.match((await script(`await __call('script.run', { code: '' });`)).error, /쓸 수 없는 동작/);
step('시간 초과 중단, 스크립트 안에서 스크립트 재실행 금지');

// #13: downloads land in the agent folder; uploads from there need no approval, others do
await call('page_navigate', { spaceId, url: `${site}/pages/files.html` });
const dl1 = await call('page_download', { spaceId, target: '#dl' });
assert.equal(dl1.state, 'completed');
assert.equal(fs.readFileSync(dl1.path, 'utf8'), fs.readFileSync(path.join(here, 'pages/report.txt'), 'utf8'));
const dl2 = await call('page_download', { spaceId, url: `${site}/pages/report.txt?download` });
assert.equal(path.dirname(dl2.path), path.dirname(dl1.path));
assert.notEqual(dl2.path, dl1.path);
step(`다운로드: 링크 클릭·URL 모두 에이전트 폴더에 저장, 이름 중복 회피 (${dl1.filename}, ${dl2.filename})`);

const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const up1 = await call('page_upload', { spaceId, target: '#direct', files: [dl1.path, dl2.path], snapshot: true });
assert.match(up1.snapshot, new RegExp(`${esc(dl1.filename)}:${dl1.bytes},`));
const up2 = await call('page_upload', { spaceId, target: '#pick', files: [dl1.path], snapshot: true });
assert.match(up2.snapshot, new RegExp(`"${esc(dl1.filename)}"`));
step('업로드: 파일 입력칸에 직접 2개, 버튼으로 연 파일 선택 창에 1개 (에이전트 폴더라 승인 없음)');

await call('page_upload', { spaceId, target: '#direct', files: ['/etc/hosts'] }).then(bypassed, denied);
await call('page_upload', { spaceId, target: '#direct', files: ['/없는/파일.txt'] }).then(bypassed, (e) => assert.match(e.message, /파일이 없습니다/));
step('에이전트 폴더 밖 파일(/etc/hosts) 업로드는 승인 요청 → 거부, 없는 파일은 오류');

// #6: agent cursor and action label
await call('page_navigate', { spaceId, url: fixture });
await call('page_click', { spaceId, target: '#save', label: '저장 버튼 누르기' });
const overlay = await call('browser_run_script', {
  spaceId,
  code: `return await page().evaluate("(() => { const h = document.getElementById('__agent_browser_cursor__'); return h && { label: h.shadowRoot.querySelector('.l').textContent, visible: h.style.opacity, ariaHidden: h.getAttribute('aria-hidden'), pointer: h.style.pointerEvents }; })()");`,
});
assert.deepEqual(overlay.value, { label: '저장 버튼 누르기', visible: '1', ariaHidden: 'true', pointer: 'none' });
assert.doesNotMatch(await call('page_snapshot', { spaceId }), /저장 버튼 누르기/);
assert.doesNotMatch(await call('page_extract', { spaceId, format: 'text' }), /저장 버튼 누르기/);
await call('page_fill', { spaceId, target: '#name', text: '커서' });
const listed = (await call('space_list')).find((s) => s.spaceId === spaceId);
assert.equal(listed.lastAction, '입력 · #name');
step('커서·라벨 표시 (마우스 통과, 스냅샷·본문 추출엔 안 나옴), 상단 바용 마지막 동작 기록');

const shot = await call('page_screenshot', { spaceId });
assert.equal(shot.type, 'image');
assert.ok(shot.data.length > 1000);
step(`스크린샷 PNG ${Math.round(shot.data.length / 1024)}KB`);

await call('page_navigate', { spaceId: 0, url: fixture }).then(
  () => assert.fail('user space accessible'),
  (e) => assert.match(e.message, /사용자 공간/),
);
step('사용자 탭(Space 0) 접근 거절');

const handoff = await call('space_handoff', { spaceId, reason: 'e2e 테스트', timeoutSec: 1 });
assert.equal(handoff.returned, false);
await call('page_snapshot', { spaceId }).then(
  () => assert.fail('agent acted while user in control'),
  (e) => assert.match(e.message, /사용자가 Space .* 제어 중/),
);
step('handoff 중에는 에이전트 동작 거절');

console.log(`\n전부 통과. 앱에서 Space ${spaceId}의 "에이전트에게 돌려주기"를 누르면 제어권이 돌아갑니다.`);
await client.close();
server.close();
