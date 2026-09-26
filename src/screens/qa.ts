import { app } from '../app.ts';
import type { Screen } from '../router.ts';
import { titleTopbar } from '../ui/chrome.ts';
import { esc } from '../ui/dom.ts';
import { medal } from '../ui/medal.ts';

/** Q&A 탭 — 대화할 인물 목록 */
export const qaScreen: Screen = {
  tab: 'qa',
  mount(root) {
    const list = app.nearbyFigures();
    root.innerHTML = `<div class="scr">
      ${titleTopbar('역사 인물 Q&A')}
      <p class="qa-lead">대화할 인물을 고르세요. 가까운 인물부터 보여 드립니다.</p>
      <div class="list">${list
        .map(
          (n) => `<a class="row-item" href="#/talk/${encodeURIComponent(n.figure.id)}">
            ${medal(n.figure, { size: 42 })}
            <div class="ri"><b>${esc(n.figure.name)}</b><small>${esc(n.figure.title)} · ${esc(n.site.name)}</small></div>
            <span class="rdist">${esc(app.distanceLabel(n.distance))}</span></a>`,
        )
        .join('')}</div>
    </div>`;
  },
};
