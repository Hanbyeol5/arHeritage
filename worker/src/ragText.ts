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

/** 해가 정해진 사건 (질문에 나오면 그 해를 기준으로 인물 사후 여부를 본다) */
const EVENTS: [RegExp, number][] = [
  [/임진왜란/, 1592],
  [/정유재란/, 1597],
  [/정묘호란/, 1627],
  [/병자호란/, 1636],
  [/갑신정변/, 1884],
  [/동학\s*농민|갑오개혁|청일\s*전쟁/, 1894],
  [/을사(늑약|조약)/, 1905],
  [/경술국치|한일\s*병합|일제\s*강점|일제\s*시대|일본\s*강점/, 1910],
  [/(3|삼)[·.\s]?1\s*운동/, 1919],
  [/광복|해방\s*후|8[·.]15/, 1945],
  [/한국\s*전쟁|6[·.]25\s*전쟁|6[·.]25/, 1950],
  [/(4|사)[·.]19/, 1960],
  [/서울\s*올림픽/, 1988],
  [/월드컵/, 2002],
];
/** 근대 이후의 문물·제도 (개항 1876 이전에 떠난 인물은 모른다) */
const MODERN = /(대한민국|대통령|국회의원|인터넷|스마트\s*폰|휴대\s*폰|컴퓨터|텔레비전|티비|자동차|비행기|기차|지하철|핵무기|원자\s*폭탄|유튜브|인공\s*지능|AI|코로나|아이돌|케이팝|K-?pop|민주주의|공화국|헌법)/i;

/**
 * 지식 경계 판정 — 질문이 인물 사후의 일을 묻는지 (LLM 에 묻기 전에 막는다).
 * @param later 인물 목록 중 [이름, 태어난 해] — 사후에 태어난 인물을 물으면 사후의 일
 * @return 걸린 근거 (예: "1950년", "한국 전쟁", "정조"), 아니면 undefined
 */
export function afterDeath(question: string, died: number, later: [string, number][] = []): string | undefined {
  const q = question.replace(/\s+/g, ' ');
  for (const m of q.matchAll(/(1\d{3}|20\d{2})\s*년/g)) if (Number(m[1]) > died) return `${m[1]}년`;
  for (const m of q.matchAll(/(\d{1,2})\s*세기/g)) if ((Number(m[1]) - 1) * 100 + 1 > died) return `${m[1]}세기`;
  for (const [re, year] of EVENTS) {
    const hit = q.match(re);
    if (hit && year > died) return hit[0];
  }
  if (died < 1876) {
    const hit = q.match(MODERN);
    if (hit) return hit[0];
  }
  for (const [name, born] of later) if (born > died && name.length >= 2 && q.includes(name)) return name;
  return undefined;
}

/** 지식 경계에 걸린 질문에 대한 정해진 답 (인물 말씨) */
export function afterDeathReply(style: string, died: number): string {
  if (style === 'lady') return `제가 세상을 떠난 ${died}년 뒤의 일이라 저는 알지 못한답니다. 제가 살던 때의 이야기를 물어 주세요.`;
  return `내가 세상을 떠난 ${died}년 뒤의 일이라 나는 알지 못하네. 내가 살던 때의 이야기라면 기꺼이 들려주겠네.`;
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
