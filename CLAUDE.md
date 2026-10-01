# CLAUDE.md — 역사담(arHeritage) 작업 안내

유적지에서 카메라를 비추면 주변 유적이 AR 로 뜨고, 역사 인물과 음성으로 대화하는 **웹앱**(경기도 시범).
GitHub Pages 로 배포하고 사용자는 폰으로 접속한다. 사용자와는 **한국어**로 대화한다.

- 배포: https://samcho93.github.io/arHeritage/ · 편집기: `/editor/` · API: https://yeoksadam-api.samdori93.workers.dev
- 구조·절차 전체: `README.md` (20개 절) · 앱 사용법: `USAGE.md` · 새 PC 준비: `docs/SETUP.md`
- 디자인·기능 원본: https://github.com/Hanbyeol5/historydam (Android, 단청·한지 테마 목업)

## 구조 요약

- `src/` — Vite 8 + TypeScript, 프레임워크 없음
  - 해시 라우터 `router.ts`, 화면 `screens/*`, 상태 `app.ts`
  - 반경 공용 `radius.ts`, 대화 방식(기본/RAG/외부 RAG) `conversation.ts`, 기기 저장 `store.ts` (localStorage `yeoksadam:v2`)
- `src/editor/` + `editor/index.html` — RAG 자료 편집기. 웹앱과 분리된 두 번째 진입점이며 웹앱에 링크하지 않는다.
- `worker/` — Cloudflare Worker
  - `/chat`, `/rag`(BM25 + citations), `/vision`, `/tts`(Azure)
  - Claude 모델 `claude-opus-5`
  - `ragText.ts` 는 `scripts/build-rag.ts` 와 공용
- `scripts/` — 데이터 수집과 RAG 색인 (`data:fetch` → `data:hyangto` → `data:tour` → `data:rag`), 개발 환경 `setup.ps1`/`setup.sh`
- `public/data/`
  - `index.json` (유적 1,486곳), `detail/<id>.json`
  - `figures.json` (인물 16명, 수작업 — `died` 지식 경계, `speech`·`greet`·`extId`)
  - `rag/` (생성물), `rag-edits.json` (편집기가 커밋)
- `tools/` — 사용법 화면 캡처(`capture-usage.mjs`), 초상 배경 제거(`make-cutout.mjs`). 별도 package.json.
- `.github/workflows/`
  - `deploy.yml`: `data:rag` 후 빌드 → Pages
  - `deploy-worker.yml`: `worker/**` 변경 시
  - `update-data.yml`: 매월

## 작업 규칙

- **커밋 메시지는 한국어**, 끝에 `Co-Authored-By` 줄을 붙인다. 사용자가 요청할 때 commit·push 한다. 이 저장소는 main 에 바로 push 해 왔다.
- **비밀값을 코드·커밋·대화에 쓰지 않는다.**
  - Claude·Azure·Cloudflare 키는 GitHub Secrets 와 Worker secrets 에만 둔다.
  - `.env.local`, `worker/.dev.vars` 는 git 제외. 지도 Client ID 와 API 주소는 공개 값이다.
- **Windows Git Bash 주의**
  - `BASE_PATH=/arHeritage/` 같은 값은 경로로 바뀌므로 `MSYS_NO_PATHCONV=1` 을 붙인다.
  - heredoc·`node -e` 안의 정규식 역슬래시가 자주 깨진다. 정규식이 든 코드는 셸로 쓰지 말고 Edit/Write 도구로 고친다.
- 한국어 조사는 `ui/josa.ts` 의 `josa()` 를 쓴다. 「을(를)」 같은 괄호 표기는 음성이 그대로 읽으므로 금지.
- 수정 뒤 확인 순서: `npx tsc --noEmit` → `npm run build`. Worker 를 고쳤으면 `cd worker && npx tsc --noEmit`.
  - 화면 확인은 `npm run dev` 후 `?lat=37.2818&lng=127.0137` (수원 화성행궁 고정).
  - 폰 크기 캡처는 `tools/capture-usage.mjs` 방식(puppeteer-core)이 안정적이다.
- 기능을 바꾸면 `README.md` 해당 절과, 화면이 바뀌면 `USAGE.md`·`docs/images/` 도 함께 고친다.
- LLM 으로 유적 데이터를 보강하지 않는다. 사용자 결정이며 `figures.json` 은 수작업으로 관리한다.
- 역사관광지는 생가만 반영한다.

## 남은 작업·결정 대기

- **초상 생성: 효종·인조·세조·황희·장영실.** 지금은 인장과 전신 실루엣(`fullBody`)으로 표시한다.
  - 이미지를 만든 뒤 `tools/make-cutout.mjs <id> <이미지>` 로 처리한다.
  - 프롬프트는 `docs/SETUP.md` 6절에 있다.
  - Hugging Face 무료 GPU 한도 때문에 보류 중이다.
- **포크(Hanbyeol5/arHeritage) 지원.** Worker `ALLOWED_ORIGINS` 에 `https://hanbyeol5.github.io` 는 추가됨 (2026-09-28).
  - 포크 쪽에서 남은 일: Actions 켜기, Pages Source 를 GitHub Actions 로, Variables(`NAVER_MAP_KEY_ID`, `API_BASE`) 등록.
  - 네이버 지도 Web 서비스 URL 에 포크 주소 추가 (`docs/SETUP.md` 7절).
