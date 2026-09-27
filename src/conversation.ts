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

/** 대화는 인물별로 기억 (화면을 나갔다 와도 이어짐) */
const sessions = new Map<string, Line[]>();

export function session(f: Figure): Line[] {
  let s = sessions.get(f.id);
  if (!s) {
    const site = app.nearestSiteOf(f).site.name;
    const greet =
      f.role === 'guide'
        ? `어서 오세요. 저는 ${josa(site, '을/를')} 안내하는 해설사입니다. 궁금한 것을 편하게 물어보세요.`
        : f.style === 'lady'
          ? `어서 오세요. ${site}에서 뵙게 되어 반갑습니다.`
          : f.style === 'king'
            ? `그대가 ${josa(site, '을/를')} 찾아왔구나. 무엇이 궁금한고?`
            : `어서 오시게. ${site}에는 들러보셨는가?`;
    s = [{ mine: false, text: greet }];
    sessions.set(f.id, s);
  }
  return s;
}

const sys = (text: string): Line => ({ mine: false, system: true, text });

async function post(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: res.ok, status: res.status, data: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

/**
 * 인물의 답 — 메뉴의 '대화 방식'에 따라
 *  - basic : Worker /chat  (인물에 연결된 유적 설명을 통째로 근거로)
 *  - rag   : Worker /rag   (질문마다 1,486곳 설명에서 관련 조각을 검색해 근거로, 출처 표시)
 *  - custom: 외부 RAG 서버 /chat (historydam backend 호환: {question} → {answer, referenced_data})
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
      const { ok, status, data } = await post(`${base}/chat`, { question, figureId: f.id, figureName: f.name });
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
    });
    if (!ok || typeof data.text !== 'string') return sys((data.error as string) ?? `대답을 받지 못했습니다. (${status})`);
    return { mine: false, text: data.text, sources: (data.sources as Source[] | undefined) ?? undefined };
  } catch {
    return sys('네트워크 연결을 확인해 주세요.');
  }
}
