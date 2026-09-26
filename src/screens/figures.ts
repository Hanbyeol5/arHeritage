import { app, type NearbyFigure } from '../app.ts';
import { openFigureSheet } from '../figureSheet.ts';
import type { Screen } from '../router.ts';
import { store } from '../store.ts';
import { titleTopbar } from '../ui/chrome.ts';
import { esc, initial } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { lockedMedal, medal } from '../ui/medal.ts';

let mode: 'abc' | 'near' = 'abc';

/** 7. 모든 인물 — 가나다순 / 주변 인물 + 검색 */
export const figuresScreen: Screen = {
  tab: 'home',
  mount(root) {
    root.innerHTML = `<div class="scr">
      ${titleTopbar('모든 인물')}
      <div class="list-head">
        <button class="filt">${icons.filter}필터</button>
        <label class="search">${icons.search}<input type="search" placeholder="인물 검색" /></label>
      </div>
      <div class="seg">
        <button data-mode="abc">가나다순</button>
        <button data-mode="near">주변 인물</button>
      </div>
      <div class="list"></div>
    </div>`;

    const input = root.querySelector<HTMLInputElement>('input')!;
    const listEl = root.querySelector<HTMLElement>('.list')!;

    const row = (n: NearbyFigure) => {
      const found = store.isDiscovered('figure', n.figure.id);
      return `<button class="row-item" data-id="${esc(n.figure.id)}">
        ${found ? medal(n.figure, { size: 42 }) : lockedMedal(42)}
        <div class="ri"><b>${esc(n.figure.name)}</b><small>${esc(n.figure.title)} · ${esc(n.site.name)}</small></div>
        <span class="rdist ${found ? '' : 'off'}">${found ? esc(app.distanceLabel(n.distance)) : `미발견 · ${esc(app.distanceLabel(n.distance))}`}</span>
      </button>`;
    };

    const render = () => {
      root.querySelectorAll<HTMLElement>('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === mode));
      const q = input.value.trim();
      let list = app.nearbyFigures().filter((n) => !q || n.figure.name.includes(q) || n.figure.title.includes(q));
      if (!list.length) {
        listEl.innerHTML = '<p class="empty">검색 결과가 없습니다.</p>';
        return;
      }
      if (mode === 'near') {
        listEl.innerHTML = list.map(row).join('');
      } else {
        list = [...list].sort((a, b) => a.figure.name.localeCompare(b.figure.name, 'ko'));
        let last = '';
        listEl.innerHTML = list
          .map((n) => {
            const c = initial(n.figure.name);
            const head = c !== last ? `<div class="idx">${c}</div>` : '';
            last = c;
            return head + row(n);
          })
          .join('');
      }
      listEl.querySelectorAll<HTMLElement>('[data-id]').forEach((b) => b.addEventListener('click', () => openFigureSheet(b.dataset.id!)));
    };

    root.querySelectorAll<HTMLElement>('.seg button').forEach((b) =>
      b.addEventListener('click', () => {
        mode = b.dataset.mode as typeof mode;
        render();
      }),
    );
    root.querySelector('.filt')!.addEventListener('click', () => {
      mode = mode === 'abc' ? 'near' : 'abc';
      render();
    });
    input.addEventListener('input', render);
    render();
    return store.onChange(render);
  },
};
