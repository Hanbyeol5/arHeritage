# 서버 저장 계획 — 3D 인물 모델 · RAG 자료

> 상태: **1차 구현 완료** (2026-11-17). 아래 「구현 현황」이 계획과 다른 점을 우선한다.
> 대상: 웹앱(arHeritage) · Android 앱(historydam) · Cloudflare Worker(`yeoksadam-api`)

## 0. 구현 현황 (계획과 다른 점)

| 항목 | 계획 | 구현 |
|---|---|---|
| 저장소 | R2 | **Workers KV** (`STORE`, 카드 등록 없이 사용). 파일당 25MB 한도. R2 를 켜면 `worker/src/store.ts` 의 KV 호출만 바꾼다 |
| 목록 | `models.json` 파일 | KV 키 `idx:models` · `idx:docs` (무료 플랜 list 한도 회피). API 경로는 계획과 같음 |
| RAG 반영 | 업로드 → GitHub Actions 가 색인 재생성 | **Worker 가 업로드 문서를 1분마다 읽어 기존 색인과 함께 BM25 로 검색**(겹쳐 쓰기). Actions·GitHub 토큰 불필요, 1분 안에 반영 |
| 편집기 | GitHub 커밋 → R2 | `/editor/` 「서버에 저장」 → Worker `/doc`. `rag-edits.json`·GitHub 토큰 제거 |
| 외부 RAG 편집 | (계획에 없음) | 편집기 「외부 RAG 인물 설정」 탭 → `/store/personas.json`. Android 백엔드 RAG 가 인물 말투·지식 경계·검색어로 사용 |
| 백엔드 RAG 자료 | (계획에 없음) | 인물(과 그 유적)에 연결된 업로드 문서 조각을 `/store/context/<인물 id>` 로 받아 공공기관 자료 앞에 넣음 |
| 업로드 키 | `UPLOAD_KEY` secret | **없앰** (2026-11-23). 쓰기도 읽기와 같이 허용 출처·앱 키 기준. 편집기·앱에 키 입력칸 없음 |
| `GH_DISPATCH_TOKEN` | 필요 | 불필요 (Actions 재생성을 쓰지 않음) |

**Android (historydam)**
- 3D 모델
  - `ServerStoreRepository` 가 서버 목록에서 인물 id 로 모델을 찾아 `filesDir/models/` 에 받는다(sha256 비교).
  - `rememberFigure3dModel()` 이 받은 파일을 먼저 쓰고, 없으면 assets 의 모델(파일이 있을 때만)을 쓴다.
- 관리자 업로드
  - 3D·RAG 폴더를 따로 지정한다.
  - 파일별 상태(새 파일·바뀜·서버와 같음, 목록에 없는 이름 경고)를 보고 「서버에 저장」을 누른다.

## 1. 목적

- 3D 인물 모델(`.glb`)과 사람이 만든 RAG 자료(`.md`)를 **앱 밖의 서버**에 두고, 모든 폰이 서버에서 불러온다.
- 자료는 **만들어질 때마다 하나씩** 폰(또는 편집기)에서 서버로 올린다. 앱을 다시 빌드·배포할 필요가 없다.

## 2. 결정 사항

| 항목 | 결정 |
|---|---|
| 서버 | **Cloudflare R2 + 기존 Worker** (Google Drive · GitHub 대비 업로드 API·비공개 보관·CDN 이 가장 간단) |
| 사용 범위 | 교내 발표·시연용. 앱은 일반 배포하지 않는다 |
| 3D 파일 이름 | **인물 한글 이름** — `이순신.glb`, `세종대왕.glb` |
| RAG 파일 형식 | **Markdown** (`.md`, 머리말 + 본문) — 파일 이름은 인물 또는 유적 이름 |
| 업로드 단위 | 한꺼번에가 아니라 **생성될 때마다 파일 하나씩** |
| 업로드 방식 | 폰 앱의 폴더 업로드와 편집기(`/editor/`)를 **같은 Worker 업로드 API 로 통합**. `rag-edits.json` · GitHub 토큰 방식은 없앤다 |
| 원본 보관 | 수집 자료(`public/data/detail/`)는 GitHub 유지 · 사람이 올린 자료는 R2 가 정본 |

## 3. 전체 구성

```
┌──────────── 폰 (관리자 모드) ────────────┐      ┌──── 편집기 /editor/ ────┐
│ 폴더 지정: Download/역사담3D, 역사담RAG   │      │ 자료 고치기·제외·추가   │
│ 파일별 상태 → [서버에 저장]               │      │ → .md 로 저장           │
└──────────────┬───────────────────────────┘      └───────────┬────────────┘
               │ PUT (X-Upload-Key)                            │ PUT (X-Upload-Key)
               ▼                                               ▼
        ┌──────────────── Cloudflare Worker (yeoksadam-api) ────────────────┐
        │ /store/models.json · /model/:name  · /store/docs.json · /doc/:name │
        │ /chat · /rag · /vision · /tts (기존)                               │
        └───────┬───────────────────────────────────────────┬───────────────┘
                │ R2 바인딩                                  │ repository_dispatch
                ▼                                           ▼
   ┌──── R2 버킷 yeoksadam-store ────┐          ┌──── GitHub Actions ────┐
   │ models/<이름>.glb               │◀─ 색인 ──│ rag-index.yml           │
   │ models.json                     │   업로드  │ detail(GitHub)         │
   │ rag/docs/<이름>.md              │          │ + docs(R2) → BM25 색인 │
   │ rag/docs.json                   │          └────────────────────────┘
   │ rag/meta.json · rag/b/ · rag/c/ │
   └─────────────────────────────────┘
               ▲ GET (X-App-Key)
   모든 폰 · 웹앱: 목록 확인 → 새것·바뀐 것만 내려받아 폰에 저장
```

## 4. R2 버킷 구조

```
yeoksadam-store/
  models.json                 # 3D 모델 목록
  models/이순신.glb
  models/정약용.glb
  rag/docs.json               # 업로드 문서 목록
  rag/docs/이순신.md
  rag/docs/수원 화성.md
  rag/meta.json               # BM25 색인 (지금 public/data/rag/ 와 같은 형식)
  rag/b/0..255.json
  rag/c/<n>.json
```

`models.json` 항목:

```json
{ "name": "이순신", "key": "이순신", "id": "yi-sunsin", "file": "models/이순신.glb",
  "size": 8421376, "sha256": "…", "etag": "…", "heightM": 1.7, "uploadedAt": "2026-11-20T10:12:00Z" }
```

`rag/docs.json` 항목:

```json
{ "name": "수원 화성", "key": "수원화성", "kind": "site", "target": "11-…-31",
  "file": "rag/docs/수원 화성.md", "size": 5120, "sha256": "…", "uploadedAt": "…" }
```

- 업로드할 때마다 **해당 항목 하나만** 추가·갱신한다. 다른 항목은 건드리지 않는다.

## 5. 이름 규칙 (3D · RAG 공통)

1. 파일 이름은 앱 인물 목록(`figures.json` 의 `name`) 또는 유적 이름과 **정확히 같게** 한다.
   - 현재 인물: 정조, 채제공, 정약용, 세종대왕, 효종, 이이, 신사임당, 인조, 정몽주, 권율, 조광조, 허준, 세조, 태조 이성계, 황희, 장영실
   - `세종.glb` ✗ → `세종대왕.glb` ✓
   - 이순신 등 목록에 없는 인물은 `figures.json` 에 먼저 추가한다.
2. 비교 열쇠(`key`)는 **NFC 정규화 + 공백 제거**로 만든다.
   - 맥·일부 기기는 한글을 자모 분리(NFD)로 저장하므로 반드시 정규화한다.
   - `태조 이성계` = `태조이성계`
3. 목록에 없는 이름은 업로드 화면에서 「인물·유적 목록에 없는 이름입니다」 경고를 띄운다. 오타로 쓰이지 않는 파일을 막는다.
4. 같은 이름으로 다시 올리면 **덮어쓴다**. 앱은 `etag` 변화를 보고 다시 받는다.
5. 서버 안에서는 `name` 과 인물 `id` 를 함께 기록한다. 이름 표기가 바뀌어도 연결이 유지된다.

## 6. RAG 문서 형식 (`.md`)

```markdown
출처: 난중일기
연도: 1592-1598
---
본문 …
```

기존 유적 설명을 고치거나 뺄 때(편집기 기능 통합):

```markdown
출처: 국가유산청 (수정)
연도: 1794-1796
대상: 수원 화성
제외: 아니오
---
본문 …
```

| 머리말 | 뜻 |
|---|---|
| `출처` | 답변의 출처 표시에 쓰인다 |
| `연도` | 지식 경계 필터에 쓰인다(인물이 죽은 뒤 자료 제외). `1592` 또는 `1592-1598` |
| `대상` | 있으면 그 유적의 수집 설명을 이 문서로 **대체**한다 |
| `제외` | `예` 면 대상 유적 설명을 검색에서 뺀다(본문 생략 가능) |

- 머리말이 없으면 `출처: 직접 작성`, 연도 미상으로 처리한다.
- 파일 이름이 인물이면 그 인물 대화에, 유적이면 그 유적 근거로 우선 쓰인다.

## 7. 3D 모델 흐름

**업로드 (관리자 폰)**

```
이순신.glb    8.4MB   ● 새 파일          [서버에 저장]
정약용.glb    6.1MB   ✓ 서버와 같음
세종대왕.glb  7.9MB   ● 바뀜              [서버에 저장]
홍길동.glb    5.0MB   ⚠ 인물 목록에 없는 이름
```

1. 설정 → 관리자 모드 → 「3D 모델 폴더 지정」
   - Android 저장소 접근 프레임워크 `ACTION_OPEN_DOCUMENT_TREE` 를 쓴다.
   - 권한을 영구 보관하므로 저장소 권한이 따로 필요 없다.
2. 폴더의 `.glb` 를 `models.json` 과 비교한다(크기 + SHA-256). 파일마다 상태를 표시한다.
3. 새 파일·바뀐 파일만 「서버에 저장」 버튼을 보인다. 「바뀐 것 모두 저장」도 둔다.
4. 업로드 화면에서 키(`heightM`, 기본 1.65)를 입력할 수 있다.

**불러오기 (모든 폰)**

1. 앱 시작 시 또는 AR 화면 진입 시 `/store/models.json` 을 받는다(가벼움).
2. 유적지에서 인물을 발견하면 인물 이름의 `key` 로 목록을 찾는다.
3. 목록에 있으면 처리한다.
   - 폰에 저장된 같은 `etag` 가 있으면 그것을 쓴다.
   - 없으면 `/model/<이름>.glb` 를 받아 `filesDir/models/` 에 저장한다.
4. 받는 동안은 2D 컷아웃을 보이고, 완료되면 3D(SceneView)로 바꾼다. 목록에 없으면 계속 2D 로 둔다.
5. 한 번 받은 모델은 오프라인에서도 표시된다. 시연 전 AR 화면을 한 번 열어 미리 받아 둔다.

## 8. RAG 자료 흐름

**업로드 (관리자 폰 또는 편집기)**

1. 폰은 「RAG 자료 폴더 지정」 후 3D 와 같은 화면에서 파일별로 「서버에 저장」한다. 편집기는 화면에서 고친 내용을 `.md` 로 저장한다.
2. Worker 처리
   - 머리말을 검사한다(연도 형식, 대상 이름).
   - `rag/docs/` 에 저장하고 `rag/docs.json` 을 갱신한다.
   - GitHub `repository_dispatch(rag-index)` 를 호출한다.
3. GitHub Actions `rag-index.yml`
   - `public/data/detail/` 과 R2 `rag/docs/*.md` 를 합쳐 BM25 색인을 다시 만든다.
   - 결과를 R2 `rag/` 에 올린다.
   - `concurrency` 로 연달아 올라온 요청을 묶어 마지막 것만 실행한다.
4. Worker `/rag` 는 R2 의 `rag/meta.json` 버전(`v`)이 바뀌면 새 색인을 읽는다. 다음 질문부터 반영된다.
5. 업로드 화면에 「색인 반영 중 → 반영됨」을 표시한다(`/store/status`).

**색인을 Worker 가 아닌 Actions 에서 만드는 이유**

- BM25 는 문서 수·평균 길이·단어 빈도 같은 **전체 통계**로 만들어진다. 그래서 문서 하나만 바뀌어도 색인 전체를 다시 만들어야 한다.
- Worker 무료 플랜은 요청당 CPU 10ms 라서, 2,000여 조각의 색인을 다시 만들 수 없다.

## 9. Worker API (추가분)

| 메서드 · 경로 | 인증 | 설명 |
|---|---|---|
| `GET /store/models.json` | 앱 키 | 3D 모델 목록 |
| `GET /model/:name.glb` | 앱 키 | 모델 내려받기. ETag·Range·`Cache-Control: max-age=604800` |
| `PUT /model/:name.glb` | **업로드 키** | 모델 저장. 이름 정규화·목록 확인, `glTF` 매직 바이트 검사, 100MB 이하 |
| `DELETE /model/:name.glb` | 업로드 키 | 모델 삭제 |
| `GET /store/docs.json` | 앱 키 | RAG 문서 목록 |
| `GET /doc/:name.md` | 앱 키 | 문서 내용(편집기에서 불러오기) |
| `PUT /doc/:name.md` | 업로드 키 | 문서 저장 → 색인 재생성 요청 |
| `DELETE /doc/:name.md` | 업로드 키 | 문서 삭제 → 색인 재생성 요청 |
| `GET /store/status` | 앱 키 | 색인 버전, 재생성 진행 여부 |

- 기존 `/rag` 는 `SITE_BASE` 의 `data/rag/` 대신 R2 바인딩에서 색인을 읽는다.
- 전환 기간에는 R2 에 색인이 없으면 기존 경로로 대체한다.

## 10. 키 · 비밀값

| 이름 | 위치 | 용도 |
|---|---|---|
| `APP_KEYS` | `wrangler.toml` (공개 값) | 앱·웹앱의 읽기 요청 |
| `UPLOAD_KEY` | Worker secret | 업로드·삭제. 앱은 관리자 모드 화면에서 **직접 입력**(앱에 넣지 않음) |
| `GH_DISPATCH_TOKEN` | Worker secret | 색인 재생성 요청. fine-grained, samcho93/arHeritage `contents: write` 만 |
| R2 API 토큰 | GitHub Secrets | Actions 가 색인을 R2 에 올릴 때 |

- 비밀값은 코드·커밋·대화에 쓰지 않는다(`CLAUDE.md`).
- 3D 모델은 권리 확인 전(Tripo AI 생성물)이므로 GitHub·Pages 에 올리지 않는다. 서버에 있어도 시연용으로만 쓴다.

## 11. 바뀌는 것 · 없어지는 것

| 대상 | 변경 |
|---|---|
| `worker/` | R2 바인딩, 위 API, `/rag` 색인 읽기 경로 |
| `scripts/build-rag.ts` | R2 문서(`.md`) 읽기·머리말 처리 추가, 결과를 R2 로 업로드하는 옵션 |
| `.github/workflows/` | `rag-index.yml` 추가 (`repository_dispatch` + 수동 실행). `deploy.yml` 은 색인 생성 단계 제거 |
| `src/editor/` | GitHub 커밋 → Worker 업로드 API. 토큰 설정 화면 제거, 업로드 키 입력으로 |
| `public/data/rag-edits.json` | **삭제**. 현재 내용이 비어 있어 옮길 자료 없음 |
| `public/data/rag/` | R2 로 옮긴 뒤 저장소에서 제거(전환 확인 후) |
| Android `core:ui` | `Figure3dModels` 고정 목록 → 서버 목록 + 내려받기 캐시. `assets/models/` 제거 |
| Android 설정 | 관리자 모드: 폴더 지정(3D · RAG), 파일별 업로드, 업로드 키 입력 |
| 문서 | `README.md`(RAG·서버 절), `USAGE.md`(편집기·관리자 모드), `docs/SETUP.md`(R2·비밀값) |

## 12. 작업 순서

1. **사전 준비 (사용자)**
   - Cloudflare 대시보드 → R2 → 구독 활성화(카드 등록, 무료 10GB 안에서는 요금 없음).
   - 업로드 키 등록: `npx wrangler secret put UPLOAD_KEY`
   - 색인 요청용 토큰 등록: `npx wrangler secret put GH_DISPATCH_TOKEN`
2. R2 버킷 `yeoksadam-store` 를 만들고 `wrangler.toml` 에 바인딩한다.
3. Worker 에 목록·내려받기·업로드·삭제 API 를 추가한다(`cd worker && npx tsc --noEmit`).
4. `build-rag.ts` 의 `.md` 처리 → `rag-index.yml` → `/rag` 의 R2 읽기 전환. 결과가 기존 색인과 같은지 비교한다.
5. 편집기를 업로드 API 로 바꾸고 `rag-edits.json` 을 제거한다.
6. Android: 서버 모델 불러오기(캐시·2D 대체) → 관리자 모드 폴더 업로드(3D·RAG).
7. 점검
   - 에뮬레이터: 업로드 → 다른 기기에서 불러오기, 오프라인 표시, 이름 불일치 경고.
   - RAG: `.md` 업로드 후 대화 출처 표시, 연도 머리말로 지식 경계 적용.
8. README · USAGE · SETUP 갱신, 커밋(한국어 메시지).

## 13. 남은 결정

- 3D 모델 압축을 누가 하나: 업로드 전 PC 에서 `gltf-transform`(Draco/Meshopt, KTX2)으로 줄이는 것을 권장한다. 폰 업로드 화면에 「20MB 초과 — 압축 권장」 안내를 표시한다.
- 업로드 키를 받을 팀원 범위.
- 인물 외 대상(유적 3D 모델 등)으로 넓힐지. 넓힌다면 같은 이름 규칙을 유적 이름에 적용한다.
