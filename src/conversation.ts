import { app } from './app.ts';
import { store } from './store.ts';
import type { Figure } from './types.ts';
import { josa } from './ui/josa.ts';

/** RAG 답변이 근거로 삼은 자료 */
export interface Source {
  /** 유적 id (fig:<인물 id> 는 인물 소개), 외부 서버 자료는 없음 */
  id?: string;
  name: string;
  quote?: string;
}

export interface Line {
  mine: boolean;
  text: string;
  /** 인물 발화가 아닌 앱 안내 */
  system?: boolean;
  /** RAG 모드에서 근거로 쓴 자료 */
  sources?: Source[];
}

/** Cloudflare Worker 주소 (worker/ 참고). 비어 있으면 대화 기능 안내만 표시 */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '');

/**
 * 대화 기록 보존 (historydam 「대화 내역 보존」과 같은 기능) — 인물별 대화를 이 기기에 저장해
 * 앱을 닫았다 열어도 이어진다. 안내 문구(system)는 저장하지 않는다.
 */
const CHAT_KEY = 'yeoksadam:chats:v1';
/** 인물당 저장할 최근 줄 수 */
const MAX_LINES = 60;
/** 저장할 인물(대화방) 수 — 넘으면 오래된 대화부터 지운다 */
const MAX_ROOMS = 40;

interface Room {
  at: number;
  lines: Line[];
}

function loadRooms(): Record<string, Room> {
  try {
    return JSON.parse(localStorage.getItem(CHAT_KEY) ?? '{}') as Record<string, Room>;
  } catch {
    return {};
  }
}
const rooms = loadRooms();
const sessions = new Map<string, Line[]>();

/** 대화 기록을 기기에 저장 (줄을 추가한 뒤 부른다) */
export function saveSession(f: Figure) {
  const lines = sessions.get(f.id);
  if (!lines) return;
  rooms[f.id] = { at: Date.now(), lines: lines.filter((l) => !l.system).slice(-MAX_LINES) };
  const ids = Object.keys(rooms).sort((a, b) => rooms[b].at - rooms[a].at);
  ids.slice(MAX_ROOMS).forEach((id) => delete rooms[id]);
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(rooms));
  } catch {
    /* 저장 불가 환경: 이번 실행 동안만 기억 */
  }
}

/** 저장된 대화가 있는 인물 수 */
export const savedRooms = () => Object.keys(rooms).length;

/** 대화 기록 지우기 — 인물을 주면 그 인물만, 없으면 전부 */
export function clearSessions(f?: Figure) {
  for (const id of f ? [f.id] : Object.keys(rooms)) delete rooms[id];
  if (f) sessions.delete(f.id);
  else sessions.clear();
  try {
    localStorage.setItem(CHAT_KEY, JSON.stringify(rooms));
  } catch {
    /* 저장 불가 환경 */
  }
}

function greeting(f: Figure): string {
  if (f.greet) return f.greet;
  const site = app.nearestSiteOf(f).site.name;
  return f.role === 'guide'
    ? `어서 오세요. 저는 ${josa(site, '을/를')} 안내하는 해설사입니다. 궁금한 것을 편하게 물어보세요.`
    : f.style === 'lady'
      ? `어서 오세요. ${site}에서 뵙게 되어 반갑습니다.`
      : f.style === 'king'
        ? `그대가 ${josa(site, '을/를')} 찾아왔구나. 무엇이 궁금한고?`
        : `어서 오시게. ${site}에는 들러보셨는가?`;
}

/** 인물과의 대화 — 저장된 기록이 있으면 이어서, 없으면 첫인사로 시작 */
export function session(f: Figure): Line[] {
  let s = sessions.get(f.id);
  if (!s) {
    const saved = rooms[f.id]?.lines;
    s = saved?.length ? [...saved] : [{ mine: false, text: greeting(f) }];
    sessions.set(f.id, s);
  }
  return s;
}

/** 이 인물과 새로 시작 — 저장된 기록을 지우고 같은 배열을 첫인사만 남긴 상태로 되돌린다 */
export function resetSession(f: Figure): Line[] {
  const s = session(f);
  s.splice(0, s.length, { mine: false, text: greeting(f) });
  saveSession(f);
  return s;
}

/** 마지막으로 이야기한 때 (저장된 기록이 없으면 undefined) */
export const lastTalked = (f: Figure): number | undefined => rooms[f.id]?.at;

const sys = (text: string): Line => ({ mine: false, system: true, text });

/** 답을 60초까지 기다린다 (historydam 앱의 읽기 시간 제한과 같음) */
async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/** 외부 RAG 서버 호출 — historydam 새 주소 /v1/chat 을 먼저, 없으면(404·405) 예전 /chat */
async function postExternal(base: string, body: unknown) {
  const first = await post(`${base}/v1/chat`, body);
  return first.status === 404 || first.status === 405 ? post(`${base}/chat`, body) : first;
}

/**
 * 인물의 답 — 메뉴의 '대화 방식'에 따라
 *  - basic : Worker /chat  (인물에 연결된 유적 설명을 통째로 근거로)
 *  - rag   : Worker /rag   (질문마다 1,486곳 설명에서 관련 조각을 검색해 근거로, 출처 표시)
 *  - custom: 외부 RAG 서버 /v1/chat (예전 /chat) — historydam backend 호환: {figureId, question} → {answer, referenced_data}
 * 지식 경계(store.boundary)를 켜면 인물은 세상을 떠난 뒤의 일을 모른다고 답한다.
 */
export async function reply(f: Figure, history: Line[]): Promise<Line> {
  const mode = store.chatMode;
  try {
    if (mode === 'custom') {
      const base = store.ragUrl;
      if (!base) return sys('메뉴에서 외부 RAG 서버 주소를 입력해 주세요.');
      if (location.protocol === 'https:' && base.startsWith('http:')) {
        return sys('HTTPS 웹앱에서는 http 서버를 부를 수 없어요. https 주소의 RAG 서버를 입력해 주세요.');
      }
      const question = [...history].reverse().find((l) => l.mine)?.text ?? '';
      const { ok, status, data } = await postExternal(base, { question, figureId: f.extId ?? f.id, figureName: f.name });
      const answer = typeof data.answer === 'string' ? data.answer : undefined;
      if (!ok || !answer) return sys(`외부 RAG 서버가 답하지 않았어요. (${status || '연결 실패'})`);
      const refs = Array.isArray(data.referenced_data) ? (data.referenced_data as unknown[]).map(String) : [];
      return { mine: false, text: answer, sources: refs.map((r) => ({ name: '참고 자료', quote: r.slice(0, 90) })) };
    }

    if (!API_BASE) return sys('인물 대화 서버가 연결되지 않았습니다. (VITE_API_BASE 설정 필요)');
    const { ok, status, data } = await post(`${API_BASE}/${mode === 'rag' ? 'rag' : 'chat'}`, {
      figureId: f.id,
      siteId: app.nearestSiteOf(f).site.id,
      lines: history.slice(-20).map(({ mine, text, system }) => ({ mine, text, system })),
      boundary: store.boundary,
    });
    if (!ok || typeof data.text !== 'string') return sys((data.error as string) ?? `대답을 받지 못했습니다. (${status})`);
    return { mine: false, text: data.text, sources: (data.sources as Source[] | undefined) ?? undefined };
  } catch (e) {
    if ((e as Error).name === 'TimeoutError') return sys('답이 너무 늦어요. 잠시 뒤 다시 물어봐 주세요.');
    return sys('네트워크 연결을 확인해 주세요.');
  }
}
