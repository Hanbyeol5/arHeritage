export const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const asset = (p: string) => (/^https?:/.test(p) ? p : `${import.meta.env.BASE_URL}${p}`);

export function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

export const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector(sel) as T;

let toastTimer: number | undefined;
export function toast(msg: string, ms = 2600) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('<div id="toast" class="toast" role="status"></div>');
    document.getElementById('app')!.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => t!.classList.remove('show'), ms);
}

/** 한글 초성 (가나다 인덱스용) */
const CHO = ['ㄱ', 'ㄲ', 'ㄴ', 'ㄷ', 'ㄸ', 'ㄹ', 'ㅁ', 'ㅂ', 'ㅃ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅉ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const MERGE: Record<string, string> = { ㄲ: 'ㄱ', ㄸ: 'ㄷ', ㅃ: 'ㅂ', ㅆ: 'ㅅ', ㅉ: 'ㅈ' };
export function initial(s: string): string {
  const c = s.charCodeAt(0) - 0xac00;
  if (c < 0 || c > 11171) return s[0] ?? '#';
  const ch = CHO[Math.floor(c / 588)];
  return MERGE[ch] ?? ch;
}

/** 도보 시간(분) - 평균 4.3km/h */
export const walkMinutes = (m: number) => Math.max(1, Math.round(m / 72));
