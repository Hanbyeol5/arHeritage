/**
 * RAG 색인·검색 공용 규칙 — 색인 만들기(scripts/build-rag.ts)와 Worker 검색이 같은 규칙을 써야 한다.
 */
export const BUCKETS = 256;
/** 조각 본문을 몇 개씩 한 파일에 묶을지 */
export const GROUP = 32;

/**
 * 사용자 수정 자료 (public/data/rag-edits.json) — RAG 자료 편집기(/editor/)가 저장하고 색인 만들기가 반영한다.
 * 원본 데이터(국가유산청·향토유산·인물)는 그대로 두고, 이 파일만으로 RAG 에 들어갈 글을 바꾼다.
 */
export interface RagEdits {
  updatedAt?: string;
  /** 출처 id(유적 id 또는 "fig:<인물 id>") → 원문 대신 쓸 글 (인물은 소개 글) */
  overrides: Record<string, string>;
  /** RAG 에서 뺄 출처 id */
  hidden: string[];
  /** 새로 추가한 자료. link 가 있으면 그 유적·인물의 자료로 취급(가중치·근거 연결) */
  extra: { id: string; title: string; link?: string; text: string }[];
}
export const emptyEdits = (): RagEdits => ({ overrides: {}, hidden: [], extra: [] });

/** 조각 하나의 최대 길이 */
export const MAX_CHUNK = 500;

/** 설명문 → 500자 이하 조각 (HTML 태그 제거, 문단 단위, 길면 문장 경계에서 자름) */
export function splitChunks(text: string): string[] {
  const out: string[] = [];
  const clean = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  for (const para of clean.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    if (para.length <= MAX_CHUNK) {
      out.push(para);
      continue;
    }
    let cur = '';
    for (const s of para.split(/(?<=[.!?다])\s+/)) {
      if (cur && cur.length + s.length + 1 > MAX_CHUNK) {
        out.push(cur);
        cur = s;
      } else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/**
 * 글에 나오는 연도들 — 「1796년」, 「(1796)」, 「1363∼1452」 처럼 연도로 쓰인 4자리 수만 (높이·개수 같은 수는 제외).
 * 지식 경계 필터에 쓴다: 가장 이른 연도가 인물이 세상을 떠난 뒤라면 그 조각은 인물이 알 수 없는 후세의 기록이다.
 */
export function yearsIn(text: string): number[] {
  const out: number[] = [];
  const re = /(?<![\d,.])(1\d{3}|20[0-2]\d)(?=\s*년|\)|\s*[~∼–-]\s*\d)|(?<=[~∼–-]\s?)(1\d{3}|20[0-2]\d)(?!\d)/g;
  for (const m of text.matchAll(re)) out.push(Number(m[1] ?? m[2]));
  return out;
}

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
