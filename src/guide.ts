import { app } from './app.ts';
import type { Figure } from './types.ts';

/**
 * 역사 인물이 연결되지 않은 유적지의 해설사.
 * 역사 인물이 아니므로 전신 실루엣으로 서서 유적지를 가리키며, 그 유적지의 국가유산청 설명을 근거로 안내한다.
 */
export function guideFor(siteId: string | null): Figure | undefined {
  const site = siteId ? app.siteById.get(siteId) : undefined;
  if (!site) return undefined;
  return {
    id: `guide:${site.id}`,
    name: '해설사',
    hanja: '解說',
    title: site.name,
    years: '',
    seal: '解',
    style: 'scholar',
    role: 'guide',
    fullBody: 'guide',
    bio: `${site.name}을(를) 안내하는 문화유산 해설사`,
    sites: [{ id: site.id, note: '안내하는 유적지' }],
  };
}
