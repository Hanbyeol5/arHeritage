import { app } from './app.ts';
import type { Figure } from './types.ts';

export interface Line {
  mine: boolean;
  text: string;
  /** 인물 발화가 아닌 앱 안내 */
  system?: boolean;
}

/** 텍스트·음성 대화가 같은 세션을 공유 (전환해도 맥락 유지) */
const sessions = new Map<string, Line[]>();

export function session(f: Figure): Line[] {
  let s = sessions.get(f.id);
  if (!s) {
    const site = app.nearestSiteOf(f).site.name;
    const greet = f.style === 'lady' ? `어서 오세요. ${site}에서 뵙게 되어 반갑습니다.` : `어서 오시게. ${site}에는 들러보셨는가?`;
    s = [{ mine: false, text: greet }];
    sessions.set(f.id, s);
  }
  return s;
}

/**
 * 인물 응답 생성. 4단계에서 Cloudflare Worker(Claude API) 로 교체한다.
 */
export async function reply(_f: Figure, _history: Line[]): Promise<Line> {
  await new Promise((r) => setTimeout(r, 500));
  return { mine: false, system: true, text: '인물 대화 기능은 준비 중입니다. 곧 사료에 근거해 답해 드립니다.' };
}
