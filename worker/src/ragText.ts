/**
 * RAG 색인·검색 공용 규칙 — 색인 만들기(scripts/build-rag.ts)와 Worker 검색이 같은 규칙을 써야 한다.
 */
export const BUCKETS = 256;
/** 조각 본문을 몇 개씩 한 파일에 묶을지 */
export const GROUP = 32;

/** 한글은 2글자 단위(바이그램), 영문·숫자는 단어 단위로 자른다. 한 글자 단어는 그대로 둔다 */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[가-힣]+|[a-z0-9]+/g) ?? []) {
    if (/^[a-z0-9]/.test(w)) {
      if (w.length > 1) out.push(w);
    } else if (w.length === 1) out.push(w);
    else for (let i = 0; i < w.length - 1; i++) out.push(w.slice(i, i + 2));
  }
  return out;
}

/** 단어 → 색인 파일 번호 (FNV-1a) */
export function bucketOf(term: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < term.length; i++) {
    h ^= term.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % BUCKETS;
}

/** 질문에서 뜻이 거의 없는 말 (색인은 그대로, 질문 점수에서만 뺀다) */
const STOP = new Set([
  '니까', '습니', '입니', '니다', '어떤', '어떻', '떻게', '무엇', '엇입', '누가', '어디', '언제', '왜', '했나', '했습', '하셨', '셨습', '셨나',
  '나요', '까요', '인가', '있나', '었나', '대해', '알려', '주세', '세요', '에서', '에게', '으로', '하고', '이유', '유가', '대감', '전하', '선생', '님은',
]);
export const queryTerms = (q: string) => [...new Set(terms(q))].filter((t) => !STOP.has(t));
