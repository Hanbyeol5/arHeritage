import { app } from '../app.ts';
import { AREngine, toCompass, type TargetInfo } from '../arEngine.ts';
import { findNearby } from '../data.ts';
import { formatDistance } from '../geo.ts';
import { openHeritage } from '../heritageSheet.ts';
import type { Screen } from '../router.ts';
import { esc } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { immersive } from '../ui/immersive.ts';
import { medal } from '../ui/medal.ts';
import { onPosition } from './home.ts';

/** AR 탐색 — 지도 '찾기' 또는 인물의 관련 유적지에서 진입. figureId 가 없으면 주변 유적지 전체를 표시 */
export const arScreen: Screen = {
  fullscreen: true,
  mount(root, [figureId], query) {
    const f = figureId ? app.figureById.get(figureId) : undefined;
    const siteId = query.get('site');
    const target = f ? (siteId && app.siteById.get(siteId)) || app.nearestSiteOf(f).site : undefined;

    root.innerHTML = `<div class="scr cam ar">
      <video playsinline muted autoplay></video>
      <div class="ar-layer"></div>
      <div class="ar-top">
        <a class="icbtn" href="#/home" aria-label="홈">${icons.home.replace('currentColor', '#fff')}</a>
        ${
          f && target
            ? `<div class="target-chip">${medal(f, { size: 30 })}<div><b>${esc(f.name)}</b><small>${esc(target.name)}</small></div><span class="tdist"></span></div>`
            : '<div class="target-chip plain"><b>주변 유적지 탐색</b></div>'
        }
        <a class="icbtn" href="#/map${f ? `?fig=${encodeURIComponent(f.id)}` : ''}" aria-label="지도">${icons.map.replace('currentColor', '#fff')}</a>
      </div>
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

    const engine = new AREngine($('video'), $('.ar-layer'), app.sensor, openHeritage);
    engine.target = target;
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
      const items = findNearby(app.items, app.pos, AREngine.MAX_DISTANCE);
      // 멀리 있는 타깃도 방향 안내가 되도록 목록에 포함
      if (target && !items.some((i) => i.id === target.id)) items.push({ ...target, distance: 0 });
      engine.setData(items, app.pos);
    };
    update();

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
