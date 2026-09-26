import { app, type NearbyFigure } from '../app.ts';
import { openFigureSheet } from '../figureSheet.ts';
import type { Screen } from '../router.ts';
import { brandTopbar } from '../ui/chrome.ts';
import { esc } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { medal } from '../ui/medal.ts';

const MAX = 8;
let index = 0;
let selectedId: string | undefined;

/** 1. 홈 — 내 주변 인물 */
export const homeScreen: Screen = {
  tab: 'home',
  mount(root) {
    root.innerHTML = `<div class="scr home">
      ${brandTopbar()}
      <div class="home-body">
        <div class="s-label">내 주변 <span>인물</span></div>
        <div class="hero">
          <button class="chev" data-dir="-1" aria-label="이전 인물">${icons.chevL}</button>
          <div class="hero-med"></div>
          <button class="chev" data-dir="1" aria-label="다음 인물">${icons.chevR}</button>
        </div>
        <div class="figmeta"><div class="nm"></div></div>
        <div class="dots"></div>
        <div class="dist"></div>
        <a class="allbtn" href="#/figures">모든 인물 보기 ${icons.arrowR}</a>
      </div>
    </div>`;

    const heroMed = root.querySelector<HTMLElement>('.hero-med')!;
    let list: NearbyFigure[] = [];

    const render = () => {
      list = app.nearbyFigures().slice(0, MAX);
      if (!list.length) {
        heroMed.innerHTML = '<p class="empty">표시할 인물이 없습니다.</p>';
        return;
      }
      // 위치가 바뀌어 순서가 달라져도 보고 있던 인물을 유지
      const keep = list.findIndex((n) => n.figure.id === selectedId);
      index = keep >= 0 ? keep : Math.min(index, list.length - 1);
      const cur = list[index];
      selectedId = cur.figure.id;
      heroMed.innerHTML = medal(cur.figure, { size: 170, seal: true });
      root.querySelector('.nm')!.innerHTML = `${esc(cur.figure.name)} <small>${esc(cur.figure.title)}</small>`;
      root.querySelector('.dots')!.innerHTML = list.map((_, i) => `<i class="${i === index ? 'on' : ''}"></i>`).join('');
      root.querySelector('.dist')!.innerHTML = `${icons.place} ${esc(cur.site.name)} · ${esc(app.distanceLabel(cur.distance))}`;
      root.querySelectorAll<HTMLButtonElement>('.chev').forEach((b) => {
        const d = Number(b.dataset.dir);
        b.disabled = index + d < 0 || index + d >= list.length;
      });
    };

    const move = (d: number) => {
      const next = index + d;
      if (next < 0 || next >= list.length) return;
      index = next;
      selectedId = list[index].figure.id;
      render();
    };

    root.querySelectorAll<HTMLElement>('.chev').forEach((b) => b.addEventListener('click', () => move(Number(b.dataset.dir))));
    heroMed.addEventListener('click', () => selectedId && openFigureSheet(selectedId));

    // 좌우 스와이프
    let startX: number | undefined;
    const hero = root.querySelector<HTMLElement>('.hero')!;
    hero.addEventListener('pointerdown', (e) => (startX = e.clientX));
    hero.addEventListener('pointerup', (e) => {
      if (startX === undefined) return;
      const dx = e.clientX - startX;
      startX = undefined;
      if (Math.abs(dx) > 40) move(dx < 0 ? 1 : -1);
    });

    render();
    return onPosition(render);
  },
};

/** 위치 변경 구독 (화면 이탈 시 해제) */
export const onPosition = (fn: () => void): (() => void) => {
  const off = app.tracker.onChange(fn, false);
  return () => void off();
};
