import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { app } from './app.ts';
import { closeOverlays } from './heritageSheet.ts';
import { DEMO_POSITION, LocationTracker } from './location.ts';
import { Router, type Screen, type Tab } from './router.ts';
import { arScreen } from './screens/ar.ts';
import { cameraScreen } from './screens/camera.ts';
import { qaScreen } from './screens/qa.ts';
import { figuresScreen } from './screens/figures.ts';
import { homeScreen } from './screens/home.ts';
import { mapScreen } from './screens/map.ts';
import { notificationsScreen } from './screens/notifications.ts';
import { profileScreen } from './screens/profile.ts';
import { talkScreen } from './screens/talk.ts';
import { unlockAudio } from './speech.ts';
import { el, toast } from './ui/dom.ts';
import { icons } from './ui/icons.ts';

registerSW({ immediate: true });

const view = document.getElementById('view')!;
const nav = document.getElementById('nav')!;

/** 하단 5탭 (목업 `.nav`): 카메라 · 지도 · 홈(돌출) · Q&A · 메뉴 */
const TABS: [Tab, string, string, string][] = [
  ['camera', '#/camera', icons.camera, '카메라'],
  ['map', '#/map', icons.map, '지도'],
  ['home', '#/home', icons.homeFill, '홈'],
  ['qa', '#/qa', icons.qa, 'Q&A'],
  ['menu', '#/profile', icons.menu, '메뉴'],
];
nav.innerHTML = TABS.map(([tab, href, icon, label]) =>
  tab === 'home'
    ? `<a href="${href}" data-tab="${tab}" class="home-tab" aria-label="${label}"><div class="home">${icon}</div></a>`
    : `<a href="${href}" data-tab="${tab}">${icon}<span class="lbl">${label}</span></a>`,
).join('');

const onScreen = (s: Screen) => {
  closeOverlays();
  document.body.classList.toggle('fullscreen', !!s.fullscreen);
  nav.querySelectorAll<HTMLElement>('a').forEach((a) => a.classList.toggle('on', a.dataset.tab === s.tab));
};

const router = new Router(view, onScreen)
  .add(/^\/home$/, homeScreen)
  .add(/^\/map$/, mapScreen)
  .add(/^\/camera$/, cameraScreen)
  .add(/^\/ar(?:\/([^/]+))?$/, arScreen)
  .add(/^\/qa$/, qaScreen)
  .add(/^\/(?:talk|chat|voice)\/([^/]+)$/, talkScreen)
  .add(/^\/figures$/, figuresScreen)
  .add(/^\/profile$/, profileScreen)
  .add(/^\/notifications$/, notificationsScreen);

// iOS: 방향 센서 권한은 사용자 탭(클릭) 안에서 요청해야 하므로 AR 진입 링크/버튼 클릭 시 먼저 요청
document.addEventListener(
  'click',
  (e) => {
    const t = (e.target as HTMLElement).closest('a[href^="#/ar"], .find button, .ar-badge, [data-ar]');
    if (t) app.sensor.requestPermission();
  },
  true,
);

// 인물 목소리(서버 음성)를 코드로 재생할 수 있도록 첫 탭에서 오디오를 풀어 둔다 (iOS)
document.addEventListener('pointerdown', unlockAudio, { once: true, capture: true });

if (import.meta.env.DEV) Object.assign(window, { __app: app });

/** 시작 화면 — 위치 권한 요청 (사용자 제스처 필요) */
function showStart(message?: string) {
  const start = el(`<div class="start">
    <div class="start-card">
      <div class="seal big">談</div>
      <h1>역사담 <b>歷史談</b></h1>
      <p>${message ?? '유적지 현장에서 역사 속 인물을 만나 대화해 보세요.<br />내 주변 인물을 찾기 위해 위치 권한이 필요합니다.'}</p>
      <button class="pill solid" data-go="gps">시작하기</button>
      <button class="link" data-go="demo">데모 위치(수원 화성)로 둘러보기</button>
    </div>
  </div>`);
  document.getElementById('app')!.appendChild(start);
  start.querySelector('[data-go=gps]')!.addEventListener('click', () => begin(false, start));
  start.querySelector('[data-go=demo]')!.addEventListener('click', () => begin(true, start));
}

async function begin(demo: boolean, start?: HTMLElement) {
  start?.remove();
  const fixed = LocationTracker.fromQuery() ?? (demo ? DEMO_POSITION : undefined);
  if (fixed) {
    app.tracker.useFixed(fixed);
  } else {
    try {
      await app.tracker.start();
    } catch (e) {
      toast(`${(e as Error).message} 데모 위치로 표시합니다.`, 4000);
      app.tracker.useFixed(DEMO_POSITION);
    }
  }
  router.render();
}

app
  .load()
  .then(() => {
    if (LocationTracker.fromQuery()) begin(false);
    else showStart();
  })
  .catch((e: Error) => showStart(`데이터를 불러오지 못했습니다. ${e.message}`));
