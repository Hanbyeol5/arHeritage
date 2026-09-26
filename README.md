# AR 유적지 탐방

내 위치 주변의 국가유산을 네이버 지도와 AR 카메라로 보여주는 웹앱 (시범 지역: 경기도).

## 구조

```
scripts/fetch-heritage.ts   국가유산청 오픈API 수집 → public/data/*.json (빌드 시점)
public/data/index.json      지도·AR용 경량 목록
public/data/detail/*.json   상세 카드용 데이터 (설명문, 이미지, 요약·인물은 LLM 보강 단계에서 추가 예정)
src/
  main.ts          화면 전환, 위치 → 주변 검색 → 지도/목록/AR 갱신
  map.ts           네이버 지도 (키 없으면 목록 화면으로 대체)
  ar.ts            카메라 + 방위각 기반 AR 라벨
  orientation.ts   나침반·기울기 센서 (iOS/Android 대응)
  location.ts      GPS 추적 (?lat=&lng= 로 위치 고정 가능)
  sheet.ts         상세 카드
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
