/**
 * 한국어 조사 고르기 — 앞말의 마지막 글자 받침에 따라 '을/를', '이/가' 등을 정한다.
 * "영릉을(를)"처럼 괄호 표기를 쓰면 음성이 괄호까지 읽으므로 반드시 이 함수를 쓴다.
 */
type Pair = '을/를' | '이/가' | '은/는' | '과/와' | '으로/로' | '아/야';

/** 마지막 한글 글자의 받침 (없으면 0). 한글이 아니면 숫자·영문 끝소리를 대략 판단 */
function jong(word: string): number {
  const w = word.replace(/[\s)\]'"』」》〉.,!?…]+$/, '');
  const c = w.charCodeAt(w.length - 1);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28;
  // 숫자: 0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔 은 받침 있음
  if (/[013678]$/.test(w)) return /[18]$/.test(w) ? 8 : 1;
  if (/[lmnr]$/i.test(w)) return /l$/i.test(w) ? 8 : 1;
  return 0;
}

export function josa(word: string, pair: Pair): string {
  const [withJong, withoutJong] = pair.split('/');
  const j = jong(word);
  // '으로/로'는 ㄹ 받침이면 '로'
  if (pair === '으로/로') return word + (j === 0 || j === 8 ? withoutJong : withJong);
  return word + (j ? withJong : withoutJong);
}

/** 혹시 남은 "을(를)" 같은 괄호 조사를 음성으로 읽기 전에 바로잡는다 */
export function fixJosa(text: string): string {
  return text.replace(/([가-힣A-Za-z0-9])(을|이|은|과|으로|아)\((를|가|는|와|로|야)\)/g, (_, last: string, a: string, b: string) =>
    josa(last, `${a}/${b}` as Pair),
  );
}
