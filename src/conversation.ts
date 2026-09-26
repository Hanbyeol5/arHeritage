import { josa } from './ui/josa.ts';
import { app } from './app.ts';
import type { Figure } from './types.ts';

export interface Line {
  mine: boolean;
  text: string;
  /** 인물 발화가 아닌 앱 안내 */
  system?: boolean;
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

/** 인물의 답 — Worker 가 Claude 로 인물 페르소나 응답을 만든다 */
export async function reply(f: Figure, history: Line[]): Promise<Line> {
  if (!API_BASE) return sys('인물 대화 서버가 연결되지 않았습니다. (VITE_API_BASE 설정 필요)');
  try {
    const res = await fetch(`${API_BASE}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figureId: f.id, siteId: app.nearestSiteOf(f).site.id, lines: history.slice(-20) }),
    });
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
    if (!res.ok || !data.text) return sys(data.error ?? `대답을 받지 못했습니다. (${res.status})`);
    return { mine: false, text: data.text };
  } catch {
    return sys('네트워크 연결을 확인해 주세요.');
  }
}
