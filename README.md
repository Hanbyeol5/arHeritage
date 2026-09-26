# 역사담 (歷史談) — 웹앱

유적지 현장에서 역사 속 인물을 만나 대화하는 웹앱 (시범 지역: 경기도).
Android 앱 [historydam](https://github.com/Hanbyeol5/historydam) 의 디자인(단청·한지 테마, 8개 화면 목업)을 웹으로 옮겼다.

## 구조

```
scripts/fetch-heritage.ts   국가유산청 오픈API 수집 → public/data (빌드 시점)
public/data/index.json      지도·AR용 유적지 목록 / detail/*.json 상세
public/data/figures.json    역사 인물 ↔ 유적지 연결 (1단계 수작업 시드, 2단계 LLM 보강 예정)
src/
  main.ts            하단 5탭, 해시 라우팅, 시작 화면
  app.ts             위치·유적지·인물 상태, 도착 판정(도감·알림 기록)
  screens/           home · map · camera · ar · chat(Q&A) · voice · figures · profile · notifications
  figureSheet.ts     인물 선택(딤 시트) · 관련 유적지
  heritageSheet.ts   유적지 상세 카드
  arEngine.ts        카메라 + 방위각 AR 라벨 · 타깃 방향 안내
  naverMap.ts        네이버 지도 (인물 핑 · 유적지 핀)
  ui/                아이콘 · 초상 메달 · 상단바
```

## 개발

```bash
npm install
cp .env.example .env.local   # VITE_NAVER_MAP_KEY_ID 입력
npm run dev                  # http://localhost:5173/?lat=37.2818&lng=127.0137
npm run data:fetch           # 국가유산 데이터 재수집 (--refresh 로 캐시 무시)
```

- 카메라·위치·나침반은 HTTPS(또는 localhost)에서만 동작한다. 실제 폰 테스트는 GitHub Pages 배포본으로 한다.
- 데스크톱에서는 AR 화면을 드래그하거나 ←/→ 키로 방향을 바꿔 볼 수 있다.

## 배포 (GitHub Pages)

1. 저장소 Settings > Pages > Source 를 **GitHub Actions** 로 설정
2. Settings > Secrets and variables > Actions > **Variables** 에 `NAVER_MAP_KEY_ID` 등록
3. NCP 콘솔 Maps 애플리케이션의 Web 서비스 URL 에 `https://<아이디>.github.io` 등록
4. `main` 에 push 하면 자동 배포, 데이터는 매월 `Update heritage data` 워크플로가 갱신

출처: 국가유산청 오픈API
