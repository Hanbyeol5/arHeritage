# 다른 PC 에서 작업하기 (개발 환경 준비)

이 저장소를 새 PC 에 받아 이어서 개발·배포·데이터 갱신을 하기 위한 안내입니다.
앱 사용법은 [USAGE.md](../USAGE.md), 전체 구조는 [README.md](../README.md) 에 있습니다.

## 1. 필요한 것

| 항목 | 버전·비고 | 필수 |
|---|---|---|
| **Git** | Windows 는 Git for Windows (Git Bash 포함) | ✅ |
| **Node.js** | **24 이상** (GitHub Actions 와 같은 버전) | ✅ |
| GitHub 계정 권한 | `samcho93/arHeritage` 에 push 할 수 있는 계정 | ✅ |
| Chrome 또는 Edge | 개발 확인, 사용법 화면 캡처(`tools/`) | 권장 |
| ffmpeg | 사용법 캡처 때 가짜 카메라 화면 만들기 | 선택 |
| Claude Code | 이어서 Claude 와 작업할 때 — 루트의 `CLAUDE.md` 를 자동으로 읽음 | 선택 |

## 2. 빠른 시작

```bash
git clone https://github.com/samcho93/arHeritage.git
cd arHeritage
```

Windows PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -All
```

macOS · Linux · Git Bash:

```bash
bash scripts/setup.sh --all
```

스크립트가 하는 일:
1. Node 24 이상인지 확인합니다.
2. `npm ci` 를 실행합니다.
3. `.env.example` 을 `.env.local` 로 복사합니다. 지도 키와 API 주소 기본값이 들어 있습니다.
4. 빌드를 확인합니다.

`-All`(`--all`)을 붙이면 다음도 함께 합니다.
- Worker 의존성 설치와 `worker/.dev.vars` 생성
- 보조 도구 `tools/` 의존성 설치

그다음 개발 서버를 켭니다:

```bash
npm run dev
```

- 열 주소: `http://localhost:5173/?lat=37.2818&lng=127.0137#/home`. 수원 화성행궁 위치로 고정되어 실내에서도 확인할 수 있습니다.
- RAG 자료 편집기: `http://localhost:5173/editor/`
- 카메라·위치·나침반이 필요한 기능은 **HTTPS 배포본**을 폰으로 열어 확인합니다.

## 3. 환경 변수와 비밀값

| 파일 / 위치 | 내용 | git |
|---|---|---|
| `.env.local` | `VITE_NAVER_MAP_KEY_ID`, `VITE_API_BASE` (공개 값, 기본값 채워져 있음) | 제외 |
| `worker/.dev.vars` | `ANTHROPIC_API_KEY`, `SITE_BASE`, `AZURE_SPEECH_*` — **로컬 Worker 를 띄울 때만** | 제외 |
| GitHub Variables | `NAVER_MAP_KEY_ID`, `API_BASE` | 저장소 설정 |
| GitHub Secrets | `ANTHROPIC_API_KEY`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` | 저장소 설정 |

- 비밀값은 **이 PC 에서 복사해 오지 않아도 됩니다.** 배포는 GitHub Actions 가 Secrets 로 하므로, 새 PC 에서는 코드를 push 하기만 하면 됩니다.
- 로컬 Worker 로 대화를 시험하려면 다음 순서로 합니다.
  1. `worker/.dev.vars` 에 Claude 키를 넣습니다.
  2. `cd worker && npm run dev` 로 `http://localhost:8787` 을 띄웁니다.
  3. `.env.local` 의 `VITE_API_BASE` 를 그 주소로 바꿉니다.
- 네이버 지도는 NCP 콘솔의 **Web 서비스 URL** 에 등록된 주소에서만 뜹니다. 현재 등록된 주소는 `http://localhost:5173` 과 `https://samcho93.github.io` 입니다. 다른 포트·주소를 쓰려면 등록을 추가해야 합니다.

## 4. 자주 쓰는 명령

| 명령 | 하는 일 |
|---|---|
| `npm run dev` | 개발 서버 (`--host` 포함, 같은 와이파이의 폰에서 `http://<PC IP>:5173` 로도 접속 가능 — 단 카메라·위치는 HTTPS 가 아니라 제한) |
| `npm run build` | 타입 검사 + 빌드 (`dist/`) |
| `npm run data:fetch -- --refresh` | 국가유산청 데이터 다시 받기 |
| `npm run data:hyangto` · `data:tour` | 향토유산 · 역사관광지 반영 |
| `npm run data:rag` | RAG 색인 다시 만들기 (`rag-edits.json` 반영) |
| `cd worker && npm run dev` / `npm run typecheck` | 로컬 Worker / 타입 검사 |
| `cd tools && node capture-usage.mjs [화면…]` | USAGE.md 화면 다시 캡처 (배포본 기준) |
| `cd tools && node make-cutout.mjs <id> <이미지>` | 인물 초상 → 메달 JPG + AR 컷아웃 WebP, figures.json 갱신 |

Windows Git Bash 에서 하위 경로 빌드를 확인할 때는 경로 변환을 꺼야 합니다:

```bash
MSYS_NO_PATHCONV=1 BASE_PATH=/arHeritage/ npm run build
```

## 5. 배포 흐름 (새 PC 에서도 같음)

| 바꾼 것 | push 하면 |
|---|---|
| 웹앱·데이터 (`src/`, `public/`, `editor/` …) | **Deploy to GitHub Pages**: RAG 색인을 재생성한 뒤 빌드·배포 (2~3분) |
| Worker (`worker/**`) | **Deploy API worker**: Cloudflare 에 배포 |
| Variables·Secrets 만 바꿈 | Actions 에서 해당 워크플로를 **직접 Run workflow** |

배포 상태: `https://github.com/samcho93/arHeritage/actions`

## 6. 인물 초상 만들기 (남은 작업: 효종·인조·세조·황희·장영실)

초상이 없는 인물은 인장·전신 실루엣으로 표시됩니다.

1. 이미지 생성 도구로 정사각 초상을 만듭니다. 기존 초상은 Hugging Face 의 Z-Image Turbo, 1024×1024 로 만들었습니다.
   - 기본 프롬프트 (왕):
     > Traditional Joseon dynasty Korean royal portrait painting (eojin style), ink and mineral pigments on silk, bust portrait of a Korean king in his forties, wearing a red royal robe (gonryongpo) with a round golden dragon emblem on the chest, black ikseongwan crown hat with two small upright wings at the back, mustache and black beard, dignified calm expression, realistic face, facing the viewer, head and shoulders, centered, plain uniform pale beige background, fine delicate brushwork, museum quality, no text, no seal
   - 인물별 인상만 바꿉니다.
     - 효종: 30대 후반, 마르고 결연한 얼굴
     - 인조: 40대, 근심 어린 얼굴
     - 세조: 40대, 각진 턱과 위엄 있는 눈매
   - **배경을 단색(옅은 베이지)** 으로 해야 배경 제거가 깔끔합니다.
2. 컷아웃을 만듭니다:
   ```bash
   cd tools && npm install
   node make-cutout.mjs hyojong ../hyojong.png
   ```
   - `public/figures/hyojong.jpg` 와 `hyojong-cutout.webp` 가 생깁니다.
   - `figures.json` 의 `portrait`·`cutout` 이 채워지고 `fullBody` 는 지워집니다.
3. `npm run dev` 로 홈·대화 화면을 확인한 뒤 commit·push 합니다.

## 7. 다른 계정으로 포크해서 쓸 때

포크는 Actions·Variables·Secrets 가 복사되지 않아 그대로는 화면이 비어 보입니다. `/src/main.ts` 를 그대로 내보내기 때문입니다.

1. 포크 저장소 **Actions** 탭에서 워크플로를 켭니다.
2. **Settings → Pages → Source** 를 **GitHub Actions** 로 바꿉니다.
3. **Variables** 에 `NAVER_MAP_KEY_ID`, `API_BASE` 를 등록합니다.
4. **Deploy to GitHub Pages** 를 Run workflow 합니다.
5. 네이버 지도 Web 서비스 URL 에 `https://<계정>.github.io` 를 추가합니다.
6. 대화 서버를 쓰려면 둘 중 하나를 합니다.
   - Worker `ALLOWED_ORIGINS`(`worker/wrangler.toml`) 에 포크 주소를 추가합니다.
   - 포크에 Secrets 를 넣고 **Deploy API worker** 로 따로 배포합니다.

## 8. Claude Code 로 이어서 작업하기

- 저장소 루트의 **`CLAUDE.md`** 에 다음이 정리되어 있습니다. Claude Code 가 세션을 시작할 때 자동으로 읽습니다.
  - 프로젝트 구조
  - 작업 규칙 (커밋 형식, 셸 주의점, 비밀값 처리)
  - 남은 작업
- `.claude/launch.json` 에 개발 서버 설정(`dev`, 포트 5173)이 있어, 데스크톱 앱 미리보기에서 바로 띄울 수 있습니다.
- 이전 PC 의 대화 기록·메모리는 옮겨지지 않습니다. 필요한 맥락은 `CLAUDE.md` 와 README 에 있습니다.
