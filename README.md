# AgentBrowser

AI 에이전트가 함께 쓰는 macOS용 브라우저입니다. 에이전트는 MCP로 연결되고, 사용자 탭과 분리된 **Space**에서만 작업합니다. 로그인 상태는 사용자와 공유하므로, 내가 로그인해 둔 사이트에서 에이전트가 바로 작업할 수 있습니다.

## 주요 기능

- **에이전트 전용 Space**: 에이전트 탭은 사용자 탭과 분리됩니다. 상단 바에서 Space를 오가며 에이전트 작업을 지켜볼 수 있습니다.
- **제어권 넘기기**: 사람이 "제어권 가져오기"를 누르면 에이전트가 멈춥니다. 반대로 에이전트가 로그인·캡차처럼 사람이 필요한 순간에 제어권을 넘길 수도 있습니다.
- **필요한 부분만 읽기**: 키워드에 해당하는 영역만 받거나(`query`), 본문만 마크다운으로 받아 토큰을 아낄 수 있습니다.
- **iframe 지원**: 다른 도메인의 iframe 안에 있는 요소도 보고 조작할 수 있습니다.
- **스크립트 일괄 실행**: 여러 동작을 JavaScript 한 번으로 실행합니다. 스크립트는 샌드박스 안에서 돌아갑니다.
- **파일 업로드·다운로드**
- **에이전트 커서**: 에이전트가 무엇을 누르는지 파란 커서와 라벨로 보여줍니다.
- **민감한 동작 승인**: 결제·전송·삭제, 비밀번호 입력, 외부 파일 업로드 전에 사용자에게 확인합니다.
- **북마크·방문 기록**: 방문 기록에는 사용자가 직접 연 페이지만 남습니다.

## 요구 사항

- macOS
- Node.js 22.12 이상 (Electron 45 설치 조건)

## 설치와 실행

```bash
npm install
npm start          # 빌드 후 브라우저 앱 실행
```

MCP 도구는 **앱이 켜져 있을 때만** 동작합니다. 앱 창을 닫으면 앱도 종료됩니다.

## MCP 연결

MCP 서버(`dist/mcp/server.js`)는 클라이언트가 자동으로 실행하므로 직접 띄울 필요가 없습니다. MCP 서버는 앱이 시작할 때 만드는 `~/Library/Application Support/AgentBrowser/control.json`(포트·토큰)을 읽어 앱에 접속합니다.

아래 예시에서 `/절대경로/html_MCP`는 이 저장소의 실제 경로로 바꾸세요.

**Claude Code**

```bash
claude mcp add agent-browser -- node /절대경로/html_MCP/dist/mcp/server.js
claude mcp list    # ✔ Connected 확인
```

**Claude Desktop**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Antigravity**: `~/.gemini/antigravity/mcp_config.json`

```json
{
  "mcpServers": {
    "agent-browser": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/절대경로/html_MCP/dist/mcp/server.js"]
    }
  }
}
```

Dock에서 실행한 앱은 터미널의 PATH를 받지 못할 수 있습니다. 그래서 `command`에는 node의 전체 경로를 적습니다(`which node`로 확인). 코드를 바꾼 뒤에는 클라이언트에서 MCP 서버를 다시 연결해야 반영됩니다. Claude Code는 `/mcp`, Antigravity는 MCP 화면의 Refresh입니다.

**동작 확인**: 앱을 켠 상태에서 에이전트에게 "agent-browser로 example.com 열고 제목 알려줘"라고 요청해 보세요. "Example Domain"이 나오면 연결된 것입니다.

**도구를 직접 눌러 보기**: `npx @modelcontextprotocol/inspector node dist/mcp/server.js`

## 도구 (17개)

| 도구 | 하는 일 |
| --- | --- |
| `space_open` / `space_list` | 에이전트 Space 열기(같은 이름이면 재사용) / 목록과 상태 |
| `space_handoff` | 사용자에게 제어권을 넘기고 돌려받을 때까지 대기 |
| `page_navigate` / `page_close` | 이동 / 페이지 닫기 |
| `page_snapshot` | 접근성 트리를 텍스트로 받음. 각 요소에 `@N` ref가 붙고 iframe 안도 포함. `query`로 키워드 영역만, `skipNoise`로 메뉴·광고·푸터 제외 |
| `page_extract` | 본문만 마크다운 또는 텍스트로 받음 |
| `page_screenshot` | 화면 PNG (`fullPage` 옵션) |
| `page_click` / `page_fill` / `page_select` / `page_press` / `page_scroll` | 클릭·입력·선택·키 입력·스크롤 |
| `page_upload` / `page_download` | 파일 올리기(입력칸 또는 파일 선택 창) / 받기 |
| `page_handle_dialog` | alert·confirm·prompt 수락 또는 닫기 |
| `browser_run_script` | 여러 동작을 JavaScript 한 번으로 실행 |

프롬프트 `web_task`에는 에이전트용 사용 규칙이 들어 있습니다.

**요소 지정(target)**: 스냅샷의 `@12`, CSS 선택자(`#save`), 보이는 글자(`text=저장`) 중 하나를 씁니다. iframe 안의 요소는 `@N`으로만 지정할 수 있습니다.

**`label`**: 클릭·입력 도구에 넘기면 화면의 에이전트 커서 옆에 표시됩니다(예: `"로그인 버튼 누르기"`).

### `browser_run_script` API

모든 메서드는 async입니다. 스크립트에서 `return`한 값과 `console.log` 출력이 결과로 돌아옵니다.

```js
const p = page();                         // 기본 페이지 p1
await p.goto('example.com');
await p.fill('#q', '검색어');
await p.click('text=검색');
await p.waitFor('#results');
return await p.evaluate('document.title');
```

| API | 설명 |
| --- | --- |
| `page(label = "p1")` | 페이지 핸들. `goto`, `snapshot({query, skipNoise})`, `extract(format)`, `click`, `fill`, `select`, `press`, `scroll`, `evaluate(식)`, `waitFor(target, ms)`, `upload(target, files)`, `download({target \| url})`, `handleDialog(accept)`, `close()` |
| `newPage(url)` | 새 페이지를 열고 핸들을 돌려줌 |
| `sleep(ms)` | 대기 |

스크립트는 숨겨진 샌드박스 창에서 실행됩니다. `require`, `process`, 로컬 파일 접근은 막혀 있습니다. 기본 제한 시간은 60초이고 최대 300초까지 늘릴 수 있습니다. 스크립트 안의 동작에도 승인 창과 제어권 규칙이 똑같이 적용됩니다.

## 안전장치

| 상황 | 동작 |
| --- | --- |
| 사용자 탭(Space 0) 조작 요청 | 거절 |
| 사용자가 제어권을 가져간 Space | 그 Space의 모든 에이전트 요청 거절 |
| 결제·구매·전송·게시·삭제 등의 버튼을 클릭하거나 Enter로 누름 | 승인 창 |
| 비밀번호 입력 | 승인 창 |
| `~/Downloads/AgentBrowser` 밖의 파일 업로드 | 승인 창 |
| 승인 창이 닫히거나 앱이 종료됨 | 거부로 처리 ("허용"을 직접 누른 경우만 실행) |
| 스냅샷·본문 결과 | `<page-content trust="untrusted">`로 감싸, 페이지 안의 글이 지시문이 아니라는 것을 에이전트에게 알림 |

민감한 동작은 버튼 이름에 들어 있는 단어로 판단합니다. 따라서 계정 설정 변경처럼 이름으로 드러나지 않는 동작은 감지하지 못합니다.

## 파일 위치

| 경로 | 내용 |
| --- | --- |
| `~/Library/Application Support/AgentBrowser/` | 쿠키·로그인 세션, `bookmarks.json`, `history.json`, `control.json` |
| `~/Downloads/AgentBrowser/` | 에이전트가 받은 파일 (업로드도 이 폴더에서는 승인 없이 가능) |

## 구조

```
MCP 클라이언트 (Claude Code, Antigravity 등)
      │  MCP (stdio)
      ▼
src/mcp/server.ts            MCP 서버: 요청을 앱으로 전달
      │  HTTP JSON-RPC (127.0.0.1 + 토큰)
      ▼
src/main/control-server.ts   권한 확인 · 승인 창 · 메서드 처리
src/main/browser.ts          Space·탭·다운로드 관리
src/main/automation.ts       CDP로 스냅샷·클릭·입력, iframe 처리
src/main/page-scripts.ts     페이지 안에서 실행되는 함수 (본문 추출, 커서)
src/main/script-runner.ts    browser_run_script 샌드박스
src/main/library.ts          북마크·방문 기록
static/                      상단 바 UI
```

브라우저 엔진은 Electron에 내장된 Chromium입니다. 페이지 조작에는 Chrome DevTools Protocol(CDP)을 직접 씁니다.

## 개발

```bash
npm run build        # TypeScript 컴파일 (dist/)
npm run start:test   # 터미널 1: 테스트 모드 (승인 자동 거부, 다운로드는 임시 폴더)
npm test             # 터미널 2: 단위 테스트 + 실제 앱을 MCP로 조작하는 e2e
```

e2e 테스트(`test/e2e.mjs`)는 `test/pages/`의 페이지를 로컬 서버로 띄워서 검증합니다. 같은 서버를 `127.0.0.1`과 `localhost`로 동시에 열기 때문에, 다른 도메인 iframe 상황까지 재현됩니다.

## 문제 해결

| 증상 | 원인 / 해결 |
| --- | --- |
| "AgentBrowser 앱이 실행 중이 아닙니다" | 앱이 꺼져 있습니다. `npm start`로 켜세요. |
| `npm start` 후 `Cannot read properties of undefined (reading 'setPath')` | 터미널에 `ELECTRON_RUN_AS_NODE`가 설정되어 있습니다(VS Code 터미널 등). `npm start`는 이 변수를 자동으로 지우므로, `electron .`을 직접 실행하지 말고 `npm start`를 쓰세요. |
| 코드를 고쳤는데 도구가 그대로임 | MCP 서버를 다시 연결하세요(Claude Code: `/mcp`). |
| 앱을 두 번 실행함 | 두 번째 실행은 바로 종료되고 기존 창이 앞으로 나옵니다. |

## 한계

- macOS만 지원합니다.
- `skipNoise`는 메뉴·광고 영역을 페이지에 표시된 구조 정보로 찾습니다. 네이버처럼 이런 표시를 쓰지 않는 사이트에서는 효과가 거의 없으니 `query`를 쓰세요.
- 에이전트 커서는 페이지 안에 그립니다. 페이지 구조 변화를 감시하는 사이트는 커서를 알아챌 수 있습니다.
- Chrome에서 쓰던 로그인·북마크를 가져오는 기능은 아직 없습니다.
