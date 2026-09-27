/**
 * 표시 반경 (1·3·5·10km) — AR 화면과 지도 화면이 같은 값을 쓴다.
 * 한쪽에서 바꾸면 다른 쪽에도 그대로 이어진다.
 */
export const RADII = [1000, 3000, 5000, 10000];
const KEY = 'yeoksadam:ar-radius';

export function savedRadius(): number {
  try {
    const r = Number(localStorage.getItem(KEY));
    return RADII.includes(r) ? r : 10000;
  } catch {
    return 10000;
  }
}

export function saveRadius(r: number) {
  try {
    localStorage.setItem(KEY, String(r));
  } catch {
    /* 저장 불가 환경 */
  }
}

export const radiusLabel = (r: number) => `${r / 1000}km`;
