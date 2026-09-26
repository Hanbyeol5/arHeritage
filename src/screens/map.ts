import { app } from '../app.ts';
import { openFigureSheet } from '../figureSheet.ts';
import { openHeritage } from '../heritageSheet.ts';
import { heritageMap } from '../naverMap.ts';
import { go, type Screen } from '../router.ts';
import { esc, walkMinutes } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { medal } from '../ui/medal.ts';
import { onPosition } from './home.ts';

/** 지도에 함께 표시할 일반 유적지 반경 */
const SITE_RADIUS = 3000;
let activeId: string | undefined;

/** 4. 지도 — 인물 핑 · AR 길찾기 */
export const mapScreen: Screen = {
  tab: 'map',
  mount(root, _p, query) {
    root.innerHTML = `<div class="scr map-scr">
      <div class="map">
        <div class="route-head" hidden></div>
        <div class="map-notice" hidden></div>
        <div class="card" hidden></div>
      </div>
    </div>`;
    const mapEl = root.querySelector<HTMLElement>('.map')!;
    mapEl.prepend(heritageMap.el);

    const qFig = query.get('fig');
    const qSite = query.get('site');
    if (qFig && app.figureById.has(qFig)) activeId = qFig;
    activeId ??= app.nearbyFigures()[0]?.figure.id;

    const renderCard = () => {
      const f = activeId ? app.figureById.get(activeId) : undefined;
      const head = root.querySelector<HTMLElement>('.route-head')!;
      const card = root.querySelector<HTMLElement>('.card')!;
      if (!f) {
        head.hidden = card.hidden = true;
        return;
      }
      const nf = app.nearestSiteOf(f);
      const near = nf.distance <= 3000;
      head.hidden = !app.pos;
      head.innerHTML = `<div class="wk">${icons.walk}</div>
        <div><b>${esc(nf.site.name)}까지 ${near ? '걷기' : '이동'}</b>
        <small>${near ? `도보 ${walkMinutes(nf.distance)}분 · ` : ''}${esc(app.distanceLabel(nf.distance))} 이동</small></div>
        <button class="ar-badge">AR</button>`;
      card.hidden = false;
      card.innerHTML = `${medal(f, { size: 50, seal: true })}
        <div class="ci"><b>${esc(f.name)}</b><small>${esc(nf.site.name)} · 약 ${esc(app.distanceLabel(nf.distance))} 거리</small></div>
        <div class="find"><button class="pill solid">${icons.searchW}찾기</button></div>`;
      const toAr = () => go(`#/ar/${encodeURIComponent(f.id)}?site=${encodeURIComponent(nf.site.id)}`);
      head.querySelector('.ar-badge')!.addEventListener('click', toAr);
      card.querySelector('.find button')!.addEventListener('click', toAr);
      card.querySelector('.med')!.addEventListener('click', () => openFigureSheet(f.id));
    };

    const select = (id: string) => {
      activeId = id;
      renderPins();
      renderCard();
      const nf = app.nearestSiteOf(app.figureById.get(id)!);
      if (app.pos) heritageMap.fitPoints([app.pos, nf.site]);
      else heritageMap.panTo(nf.site.lat, nf.site.lng);
    };

    const renderPins = () => {
      heritageMap.setFigures(
        app.nearbyFigures().map((n) => ({ figure: n.figure, site: n.site })),
        activeId,
        select,
      );
      const figureSites = new Set(app.figures.flatMap((f) => f.sites.map((s) => s.id)));
      heritageMap.setSites(
        app.nearbySites(SITE_RADIUS).filter((s) => !figureSites.has(s.id)),
        openHeritage,
      );
      if (app.pos) heritageMap.setMe(app.pos);
    };

    let first = true;
    const update = () => {
      renderPins();
      renderCard();
      if (first && app.pos) {
        first = false;
        if (qSite && app.siteById.has(qSite)) {
          const s = app.siteById.get(qSite)!;
          heritageMap.fitPoints([app.pos, s]);
        } else if (activeId) {
          heritageMap.fitPoints([app.pos, app.nearestSiteOf(app.figureById.get(activeId)!).site]);
        }
      }
    };

    heritageMap
      .init()
      .then(() => {
        heritageMap.refresh();
        update();
      })
      .catch((e: Error) => {
        const n = root.querySelector<HTMLElement>('.map-notice')!;
        n.hidden = false;
        n.textContent = e.message;
        renderCard();
      });

    return onPosition(update);
  },
};
