import { app } from '../app.ts';
import { AREngine, toCompass, type TargetInfo } from '../arEngine.ts';
import { findNearby } from '../data.ts';
import { formatDistance } from '../geo.ts';
import type { Screen } from '../router.ts';
import { openSiteActions, openSiteGroup } from '../siteActions.ts';
import { esc } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { immersive } from '../ui/immersive.ts';
import { medal } from '../ui/medal.ts';
import { RADII, saveRadius, savedRadius } from '../radius.ts';
import { onPosition } from './home.ts';

/**
 * AR 탐색 — 카메라로 비추면 반경 안의 유적지를 표시하고, 누르면 안내·길찾기·대화.
 * #/ar/<인물>?site=<유적> 은 인물이 있는 유적으로, #/ar?site=<유적> 은 그 유적으로 방향 안내.
 */
export const arScreen: Screen = {
  fullscreen: true,
  mount(root, [figureId], query) {
    const f = figureId ? app.figureById.get(figureId) : undefined;
    const siteId = query.get('site');
    const target = f ? (siteId && app.siteById.get(siteId)) || app.nearestSiteOf(f).site : siteId ? app.siteById.get(siteId) : undefined;
    let radius = savedRadius();

    root.innerHTML = `<div class="scr cam ar">
      <video playsinline muted autoplay></video>
      <div class="ar-layer"></div>
      <div class="ar-top">
        <a class="icbtn" href="#/home" aria-label="홈">${icons.home.replace('currentColor', '#fff')}</a>
        ${
          f && target
            ? `<div class="target-chip">${medal(f, { size: 30 })}<div><b>${esc(f.name)}</b><small>${esc(target.name)}</small></div><span class="tdist"></span></div>`
            : target
              ? `<div class="target-chip"><div><b>${esc(target.name)}</b><small>여기로 안내하는 중</small></div><span class="tdist"></span><a class="chip-x" href="#/ar" aria-label="안내 끝내기">✕</a></div>`
              : '<div class="target-chip plain"><b>주변 유적지 탐색</b></div>'
        }
        <a class="icbtn" href="#/map${f ? `?fig=${encodeURIComponent(f.id)}` : ''}" aria-label="지도">${icons.map.replace('currentColor', '#fff')}</a>
      </div>
      <div class="ar-radius" role="group" aria-label="표시 반경">${RADII.map(
        (r) => `<button data-r="${r}" class="${r === radius ? 'on' : ''}">${r / 1000}km</button>`,
      ).join('')}</div>
      <div class="ar-guide" ${target ? '' : 'hidden'}>
        <div class="arrow">${icons.arrowUp}</div>
        <div class="guide-text"></div>
      </div>
      <div class="ar-hud">
        <span class="edge left"></span><span class="heading">--°</span><span class="edge right"></span>
      </div>
      <div class="ar-notice" hidden></div>
    </div>`;

    const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const notice = (msg?: string) => {
      $('.ar-notice').hidden = !msg;
      $('.ar-notice').textContent = msg ?? '';
    };

    const engine = new AREngine($('video'), $('.ar-layer'), app.sensor, openSiteActions);
    engine.target = target;
    engine.radius = radius;
    engine.onSelectGroup = openSiteGroup;
    engine.important = new Set(app.figures.flatMap((x) => x.sites.map((s) => s.id)));
    engine.onFrame = (heading, t, off) => {
      $('.heading').textContent = `${Math.round(heading)}° ${toCompass(heading)}`;
      $('.edge.left').textContent = off?.left ? `◀ ${off.left}` : '';
      $('.edge.right').textContent = off?.right ? `${off.right} ▶` : '';
      if (t) guide(t);
    };

    const guide = (t: TargetInfo) => {
      $('.tdist').textContent = formatDistance(t.distance);
      $('.arrow').style.transform = `rotate(${t.delta}deg)`;
      const turn = Math.abs(t.delta);
      $('.guide-text').textContent =
        turn <= 20
          ? `정면으로 ${formatDistance(t.distance)}`
          : `${t.delta > 0 ? '오른쪽' : '왼쪽'}으로 ${Math.round(turn)}° 돌아보세요`;
      $('.ar-guide').classList.toggle('aligned', turn <= 20);
    };

    const update = () => {
      if (!app.pos) return;
      const items = findNearby(app.items, app.pos, radius);
      // 멀리 있는 타깃도 방향 안내가 되도록 목록에 포함
      if (target && !items.some((i) => i.id === target.id)) items.push({ ...target, distance: 0 });
      engine.setData(items, app.pos);
    };
    update();

    root.querySelectorAll<HTMLElement>('.ar-radius button').forEach((b) =>
      b.addEventListener('click', () => {
        radius = Number(b.dataset.r);
        engine.radius = radius;
        saveRadius(radius);
        root.querySelectorAll('.ar-radius button').forEach((x) => x.classList.toggle('on', x === b));
        update();
      }),
    );

    engine.start().catch((e: Error) => notice(e.message));
    setTimeout(() => {
      if (!app.sensor.hasSensor) notice('방향 센서를 찾을 수 없습니다. 화면을 좌우로 드래그해 방향을 바꿔 볼 수 있습니다.');
      else if (!app.sensor.value.absolute) notice('나침반이 정확하지 않을 수 있습니다. 휴대폰을 8자로 움직여 보정해 주세요.');
    }, 1500);

    if (import.meta.env.DEV) Object.assign(window, { __ar: engine });
    window.addEventListener('keydown', engine.handleKey);
    const off = onPosition(update);
    const offImmersive = immersive(root.querySelector<HTMLElement>('.scr')!);
    return () => {
      offImmersive();
      off();
      engine.stop();
      window.removeEventListener('keydown', engine.handleKey);
    };
  },
};
