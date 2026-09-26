import { app } from './app.ts';
import { openBottomSheet, openHeritage } from './heritageSheet.ts';
import { go } from './router.ts';
import { store } from './store.ts';
import { el, esc } from './ui/dom.ts';
import { icons } from './ui/icons.ts';
import { medal } from './ui/medal.ts';

/** 인물 선택 (목업 2번): 배경 딤 + 초상 + [관련 유적지 / 대화하기] */
export function openFigureSheet(id: string) {
  const f = app.figureById.get(id);
  if (!f) return;
  const nf = app.nearestSiteOf(f);
  // 인물 시트를 열면(= 인물을 만나면) 역사의 전당에 기록
  store.record({
    type: 'figure',
    refId: f.id,
    name: f.name,
    subtitle: `${f.title} · ${f.years}`,
    description: `${f.bio} — ${nf.site.name}에서 만난 역사 인물입니다.`,
  });
  const root = el(`<div class="s2">
      <div class="dim"></div>
      <div class="s2-focus">
        ${medal(f, { size: 150, seal: true })}
        <div class="nm">${esc(f.name)}<small>${esc(nf.site.name)} · ${esc(app.distanceLabel(nf.distance))}</small></div>
        <p class="s2-bio" hidden>${esc(f.title)} · ${esc(f.years)}<br />${esc(f.bio)}</p>
      </div>
      <div class="s2-actions">
        <button class="pill outline" data-act="sites">${icons.site} 관련 유적지</button>
        <button class="pill solid" data-act="chat">${icons.talk} 대화하기</button>
      </div>
      <button class="s2-up" aria-label="인물 소개">${icons.up}</button>
    </div>`);
  const close = () => root.remove();
  root.querySelector('.dim')!.addEventListener('click', close);
  root.querySelector('.s2-focus')!.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) close();
  });
  root.querySelector('.s2-up')!.addEventListener('click', () => {
    const bio = root.querySelector<HTMLElement>('.s2-bio')!;
    bio.hidden = !bio.hidden;
    root.classList.toggle('bio-open', !bio.hidden);
  });
  root.querySelector('[data-act=chat]')!.addEventListener('click', () => {
    close();
    go(`#/talk/${encodeURIComponent(f.id)}`);
  });
  root.querySelector('[data-act=sites]')!.addEventListener('click', () => {
    close();
    openSites(f.id);
  });
  document.getElementById('overlay')!.appendChild(root);
}

/** 인물의 관련 유적지 목록 */
function openSites(id: string) {
  const f = app.figureById.get(id)!;
  const rows = f.sites
    .map((s) => {
      const site = app.siteById.get(s.id)!;
      const d = app.pos ? app.nearestSiteOf({ ...f, sites: [s] }).distance : Infinity;
      return { s, site, d };
    })
    .sort((a, b) => a.d - b.d);
  const sheet = openBottomSheet(`
    <div class="sites-head">${medal(f, { size: 44 })}<div><b>${esc(f.name)}</b><small>관련 유적지 ${rows.length}곳</small></div></div>
    <ul class="site-rows">${rows
      .map(
        ({ s, site, d }) => `<li>
          <button class="site-row" data-site="${esc(site.id)}">
            <div class="ri"><b>${esc(site.name)}</b><small>${esc(s.note)} · ${esc(site.designation)}</small></div>
            <span class="rdist">${esc(app.distanceLabel(d))}</span>
          </button>
          <button class="pill solid sm" data-ar="${esc(site.id)}">${icons.searchW} 찾기</button>
        </li>`,
      )
      .join('')}</ul>`);
  sheet.querySelectorAll<HTMLElement>('[data-site]').forEach((b) =>
    b.addEventListener('click', () => openHeritage(b.dataset.site!)),
  );
  sheet.querySelectorAll<HTMLElement>('[data-ar]').forEach((b) =>
    b.addEventListener('click', () => {
      sheet.remove();
      go(`#/ar/${encodeURIComponent(f.id)}?site=${encodeURIComponent(b.dataset.ar!)}`);
    }),
  );
}
