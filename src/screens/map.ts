import { app } from '../app.ts';
import { openFigureSheet } from '../figureSheet.ts';
import { openHeritage } from '../heritageSheet.ts';
import { heritageMap } from '../naverMap.ts';
import { go, type Screen } from '../router.ts';
import { esc, walkMinutes } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { medal } from '../ui/medal.ts';
import { RADII, radiusLabel, saveRadius, savedRadius } from '../radius.ts';
import { onPosition } from './home.ts';

/** 반경 안의 일반 유적지 핀은 가까운 순으로 이만큼만 (10km 는 수백 곳이라 지도가 느려진다) */
const SITE_PIN_MAX = 150;
let activeId: string | undefined;

/** 4. 지도 — 인물 핑 · AR 길찾기 */
export const mapScreen: Screen = {
  tab: 'map',
  mount(root, _p, query) {
    root.innerHTML = `<div class="scr map-scr">
      <div class="map">
        <div class="route-head" hidden></div>
        <div class="map-radius" role="group" aria-label="표시 반경" hidden>${RADII.map(
          (r) => `<button data-r="${r}">${radiusLabel(r)}</button>`,
        ).join('')}</div>
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

    // 표시 반경 (AR 화면과 같은 값)
    let radius = savedRadius();
    const radiusBox = root.querySelector<HTMLElement>('.map-radius')!;
    const markRadius = () =>
      radiusBox.querySelectorAll<HTMLElement>('button').forEach((b) => b.classList.toggle('on', Number(b.dataset.r) === radius));
    markRadius();

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
        app.nearbySites(radius).filter((s) => !figureSites.has(s.id)).slice(0, SITE_PIN_MAX),
        openHeritage,
      );
      if (app.pos) {
        heritageMap.setMe(app.pos);
        heritageMap.setRadius(app.pos, radius);
      }
      radiusBox.hidden = !app.pos;
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

    // 반경을 바꾸면 원이 화면에 꽉 차게 맞춘다 (AR 화면의 반경도 같이 바뀐다)
    radiusBox.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-r]');
      if (!b) return;
      radius = Number(b.dataset.r);
      saveRadius(radius);
      markRadius();
      renderPins();
      if (app.pos) heritageMap.fitRadius(app.pos, radius);
    });

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
