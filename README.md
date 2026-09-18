# BYPP_Hackaton

**공지사항 감지 웹앱** — 학교 공지사항 페이지를 매일 직접 들어가서 확인하는 게 귀찮고, 확인을 깜빡할까 불안했던 경험에서 시작한 첫 해커톤 프로젝트입니다.

## 무엇을 만들었나

북마크하듯 URL과 키워드(예: "장학금")를 등록해두면, 서버가 매일 정해진 시각에 자동으로 해당 페이지를 확인해서 키워드가 포함된 새 글이 올라왔는지 감지하고, 화면을 빨간색으로 바꿔서 알려주는 웹앱입니다.

데모를 위해 사이트 두 개로 구성했습니다.

- **감지 웹앱** (`index.html`) — URL/키워드를 등록하고 결과를 확인하는 메인 화면
- **목업 공지 게시판** (`board/`) — 실제 대학 공지사항 게시판처럼 만든 데모용 가짜 게시판. 여기 글을 올리면 감지 웹앱이 실제로 잡아냅니다.

## 주요 기능

- **사이트 등록**: 별칭 + URL + 감지할 키워드(쉼표로 구분, 비우면 모든 새 글 감지)를 입력하면 북마크 카드로 등록됨
- **키워드 수정**: 등록된 사이트 카드에서 바로 키워드를 수정/저장 가능
- **자동 확인 시각 설정**: 매일 몇 시에 자동으로 확인할지 지정. **서버가 브라우저와 무관하게 백그라운드에서 검사**하므로, 브라우저를 꺼둬도 서버만 켜져 있으면 정해진 시각에 자동으로 확인됨
- **수동 확인**: "지금 확인" / "지금 모두 확인" 버튼으로 즉시 확인 가능
- **키워드 매칭 알림**: 새로 올라온 글 중 지정한 키워드가 포함된 글이 있을 때만 반응 (카드 배경 + 전체 화면이 빨간색으로 변하고 상단에 알림 배너 표시)
- **URL 유효성 검사**: 사이트 등록 시 서버가 즉시 해당 URL을 확인해서, 형식이 잘못됐거나 접속이 안 되거나 게시판 구조를 인식하지 못하면 각 상황에 맞는 오류 메시지를 보여줌

## AI Agent용 API (WebMCP)

`index.html`을 `navigator.modelContext`를 지원하는 브라우저(Chrome이 2026년에 실험적으로 추가한 WebMCP 기능, Chrome 149 전후로 오리진 트라이얼 진행 중 — 실험 단계라 버전/활성화 조건이 계속 바뀜)에서 열면, 페이지가 로드될 때 AI Agent가 직접 호출할 수 있는 도구(tool) 9개를 `navigator.modelContext.registerTool()`로 등록합니다. 미지원 브라우저에서는 아무 영향 없이 조용히 무시됩니다(`watcher.js`의 `registerAgentTools()`).

| 도구 | 설명 |
|---|---|
| `list_watched_sites` | 등록된 사이트 목록과 상태 조회 |
| `register_watch_site` | 새 사이트 등록 (별칭, URL, 키워드) |
| `update_site_keywords` | 키워드 수정 |
| `check_site_now` | 특정 사이트 즉시 확인 |
| `check_all_sites_now` | 전체 사이트 즉시 확인 |
| `clear_site_alert` | 알림 상태 해제 |
| `delete_watch_site` | 사이트 삭제 |
| `get_daily_check_schedule` | 자동 확인 시각 조회 |
| `set_daily_check_schedule` | 자동 확인 시각 변경 |

내부적으로는 화면의 버튼들이 호출하는 것과 동일한 서버 API(`/api/sites`, `/api/settings` 등)를 그대로 사용하므로, Agent가 실행한 작업은 화면에도 즉시 반영됩니다.

### 사용 방법

**① 브라우저에 내장된 AI(예: Chrome의 Gemini)가 자동으로 쓰는 경우**

지원 브라우저에서 `index.html`을 열어두면, 그 브라우저에 내장된 AI Agent가 페이지의 `navigator.modelContext`를 스스로 찾아서 도구 목록을 읽고 필요할 때 호출합니다 — 별도로 무언가를 켜거나 호출할 필요 없이, 그냥 페이지를 열어둔 채로 Agent에게 "장학금 키워드로 정보대학 공지 등록해줘" 같은 요청을 하면 됩니다. WebMCP는 아직 실험 단계 기능이라 지원 여부와 활성화 방법(플래그/오리진 트라이얼)이 Chrome 버전마다 계속 바뀌고 있으니, 정확한 활성화 방법은 그때그때 `chrome://flags`에서 "WebMCP"로 검색해 확인하는 게 가장 정확합니다.

**② 개발자가 직접 테스트해보는 경우 (지금 바로 가능, 브라우저 지원 여부와 무관)**

`index.html`을 열고 개발자도구(F12) → Console 탭에서 다음처럼 도구를 직접 흉내 내서 호출해볼 수 있습니다. 이렇게 하면 WebMCP가 실제로 켜져 있지 않아도 도구 뒤에 있는 로직이 서버와 잘 연동되는지 바로 확인할 수 있습니다.

```js
// navigator.modelContext를 흉내 내서 registerAgentTools()가 등록하는 도구들을 잡아낸다
window.__mockTools = {};
navigator.modelContext = { registerTool: (def) => { window.__mockTools[def.name] = def; } };
registerAgentTools();

// 등록된 사이트 목록 조회
const r = await window.__mockTools.list_watched_sites.execute({});
console.log(r.content[0].text);

// 새 사이트 등록
await window.__mockTools.register_watch_site.execute({
  alias: "테스트", url: "board/index.html", keywords: ["장학금"]
});
```

브라우저가 실제로 `navigator.modelContext`를 지원하면 이 monkey-patch 없이 `registerAgentTools()`가 이미 페이지 로드 시 자동으로 실행되어 있으므로, 콘솔에서 `navigator.modelContext`가 정의되어 있는지만 확인하면 됩니다.

## 왜 서버가 크롤링을 하는가

브라우저 자바스크립트만으로 다른 출처(도메인)의 페이지를 읽으려 하면 CORS/`X-Frame-Options` 정책에 막혀서 동작하지 않습니다. 그래서 이 프로젝트는 **크롤링을 전부 서버(`server.py`)로 옮겨서** 처리합니다. 등록된 사이트 목록, 목업 게시판 글, 자동 확인 시각 설정도 브라우저가 아니라 서버가 관리합니다 — 그래야 브라우저가 꺼져 있어도 "매일 자동 확인"이 실제로 동작합니다.

## 실행 방법

```
python server.py
```

실행 후 브라우저에서 아래 주소로 접속합니다.

- 감지 웹앱: http://localhost:8420/index.html
- 목업 공지 게시판: http://localhost:8420/board/index.html
- 목업 게시판 글쓰기: http://localhost:8420/board/write.html

## 프로젝트 구성

```
index.html      감지 웹앱 화면
style.css       공통 스타일
watcher.js      감지 웹앱 로직 (서버 API 호출)
server.py       정적 파일 서빙 + 크롤링 + 자동 확인 스케줄러 + 데이터 저장(API)
board/
  write.html    목업 게시판 글쓰기 화면
data/           서버가 관리하는 상태 저장소 (사이트 목록/게시판 글/설정, git에는 포함하지 않음)
IDEA.md         아이디어 정의 및 검증 기록
```
