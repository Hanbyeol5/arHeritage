import { app } from '../app.ts';
import { openFigureSheet } from '../figureSheet.ts';
import { openHeritage } from '../heritageSheet.ts';
import type { Screen } from '../router.ts';
import { store } from '../store.ts';
import { titleTopbar } from '../ui/chrome.ts';
import { esc } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { imageMedal, lockedMedal, medal, monoMedal } from '../ui/medal.ts';

type HallTab = 'sites' | 'figures' | 'relics';
let tab: HallTab = 'figures';
const MIN_CELLS = 9;

/** 8. 내 프로필 · 역사의 전당 */
export const profileScreen: Screen = {
  tab: 'menu',
  mount(root) {
    const render = () => {
      const figures = store.discovered('figures');
      root.innerHTML = `<div class="scr">
        ${titleTopbar('내 프로필', `<button class="icbtn ghost more" aria-label="닉네임 바꾸기">${icons.more}</button>`)}
        <div class="prof">
          <div class="me-card">
            ${monoMedal(store.nickname, 62)}
            <div class="mi"><b>${esc(store.nickname)}</b><small>역사 탐험가</small>
              <div class="lv">${icons.star} 만난 인물 ${figures.length}명</div></div>
          </div>
          <div class="hall">
            <div class="ht"><span class="em">堂</span><b>역사의 전당</b></div>
            <div class="tabs">
              <button data-tab="sites">유적지</button><button data-tab="figures">인물</button><button data-tab="relics">유물</button>
            </div>
            <div class="gal"></div>
            <p class="hall-hint"></p>
          </div>
        </div>
      </div>`;
      root.querySelectorAll<HTMLElement>('.tabs button').forEach((b) => {
        b.classList.toggle('on', b.dataset.tab === tab);
        b.addEventListener('click', () => {
          tab = b.dataset.tab as HallTab;
          render();
        });
      });
      root.querySelector('.more')!.addEventListener('click', () => {
        const name = prompt('닉네임을 입력하세요', store.nickname);
        if (name) store.setNickname(name);
      });
      renderGallery(root);
    };
    render();
    return store.onChange(render) as () => void;
  },
};

function renderGallery(root: HTMLElement) {
  const gal = root.querySelector<HTMLElement>('.gal')!;
  const hint = root.querySelector<HTMLElement>('.hall-hint')!;
  const cells: string[] = [];

  if (tab === 'figures') {
    for (const id of store.discovered('figures')) {
      const f = app.figureById.get(id);
      if (f) cells.push(`<button class="g" data-fig="${esc(id)}">${medal(f, { size: 64 })}<span>${esc(f.name)}</span></button>`);
    }
    const total = app.figures.length;
    hint.textContent = `인물 ${cells.length} / ${total} · 관련 유적지 가까이 가면 인물을 만날 수 있습니다.`;
    while (cells.length < Math.max(MIN_CELLS, total)) cells.push(locked());
  } else if (tab === 'sites') {
    for (const id of store.discovered('sites')) {
      const s = app.siteById.get(id);
      if (s) cells.push(`<button class="g" data-site="${esc(id)}">${imageMedal(s.thumb, 64, s.name)}<span>${esc(s.name)}</span></button>`);
    }
    hint.textContent = `방문한 유적지 ${cells.length}곳 · 유적지에 도착하면 자동으로 기록됩니다.`;
    while (cells.length < MIN_CELLS) cells.push(locked());
  } else {
    hint.textContent = '카메라로 유물을 인식하면 이곳에 모입니다. (유물 인식 준비 중)';
    while (cells.length < MIN_CELLS) cells.push(locked());
  }

  gal.innerHTML = cells.join('');
  gal.querySelectorAll<HTMLElement>('[data-fig]').forEach((b) => b.addEventListener('click', () => openFigureSheet(b.dataset.fig!)));
  gal.querySelectorAll<HTMLElement>('[data-site]').forEach((b) => b.addEventListener('click', () => openHeritage(b.dataset.site!)));
}

const locked = () => `<div class="g lock">${lockedMedal(64)}<span>???</span></div>`;
