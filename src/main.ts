import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { ARView } from './ar.ts';
import { findNearby, loadIndex, type Nearby } from './data.ts';
import { formatDistance } from './geo.ts';
import { DEMO_POSITION, LocationTracker, type Position } from './location.ts';
import { HeritageMap, categoryClass } from './map.ts';
import { OrientationSensor } from './orientation.ts';
import { DetailSheet } from './sheet.ts';
import type { HeritageSummary } from './types.ts';

registerSW({ immediate: true });

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  items: [] as HeritageSummary[],
  nearby: [] as Nearby[],
  radius: Number($<HTMLSelectElement>('radius').value),
  view: 'map' as 'map' | 'ar',
};

const tracker = new LocationTracker();
const sensor = new OrientationSensor();
const sheet = new DetailSheet($('sheet'), $('sheet-body'), () => tracker.current, (d) => {
  switchView('map');
  heritageMap.panTo(d.lat, d.lng);
});
const heritageMap = new HeritageMap($('map'), (id) => sheet.open(id));
const ar = new ARView(
  $<HTMLVideoElement>('camera'),
  $('ar-layer'),
  { heading: $('heading'), left: $('edge-left'), right: $('edge-right') },
  sensor,
  (id) => sheet.open(id),
);

if (import.meta.env.DEV) Object.assign(window, { __app: { ar, sensor, tracker, heritageMap } });

function notice(id: 'map-notice' | 'ar-notice', msg?: string) {
  const el = $(id);
  el.hidden = !msg;
  el.textContent = msg ?? '';
}

function renderList() {
  const list = $('nearby-list');
  $('nearby-count').textContent = `반경 ${formatDistance(state.radius)} 내 유적지 ${state.nearby.length}곳`;
  if (!state.nearby.length) {
    list.innerHTML = '<li class="empty">주변에 등록된 유적지가 없습니다. 반경을 넓혀 보세요.</li>';
    return;
  }
  list.innerHTML = '';
  for (const it of state.nearby) {
    const li = document.createElement('li');
    li.className = categoryClass(it.category);
    li.innerHTML = `<span class="dot"></span><div><strong></strong><small></small></div><span class="dist"></span>`;
    li.querySelector('strong')!.textContent = it.name;
    li.querySelector('small')!.textContent = [it.designation, it.era].filter(Boolean).join(' · ');
    li.querySelector('.dist')!.textContent = formatDistance(it.distance);
    li.addEventListener('click', () => sheet.open(it.id));
    list.appendChild(li);
  }
}

function update(pos: Position) {
  state.nearby = findNearby(state.items, pos, state.radius);
  $('loc-status').textContent = pos.simulated
    ? '데모 위치'
    : `위치 정확도 ±${Math.round(pos.accuracy)}m`;
  heritageMap.setPosition(pos, state.radius);
  heritageMap.setItems(state.nearby);
  // AR 은 반경 설정과 별개로 최대 2km 까지만 표시
  ar.setData(findNearby(state.items, pos, ARView.MAX_DISTANCE), pos);
  renderList();
}

async function switchView(view: 'map' | 'ar') {
  state.view = view;
  document.querySelectorAll<HTMLButtonElement>('.tabbar button').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view),
  );
  $('view-map').hidden = view !== 'map';
  $('view-ar').hidden = view !== 'ar';
  document.body.classList.toggle('ar-mode', view === 'ar');
  if (view === 'ar') {
    notice('ar-notice');
    try {
      await ar.start();
      setTimeout(() => {
        if (state.view === 'ar' && !sensor.hasSensor) {
          notice('ar-notice', '방향 센서를 찾을 수 없습니다. 화면을 좌우로 드래그해서 방향을 바꿔 볼 수 있습니다.');
        } else if (state.view === 'ar' && !sensor.value.absolute) {
          notice('ar-notice', '나침반 방향이 정확하지 않을 수 있습니다. 휴대폰을 8자로 움직여 보정해 주세요.');
        }
      }, 1500);
    } catch (e) {
      notice('ar-notice', (e as Error).message);
    }
  } else {
    ar.stop();
  }
}

document.querySelectorAll<HTMLButtonElement>('.tabbar button').forEach((b) =>
  b.addEventListener('click', () => {
    const view = b.dataset.view as 'map' | 'ar';
    // iOS: 방향 센서 권한은 클릭 제스처 안에서 요청해야 함
    if (view === 'ar') sensor.requestPermission();
    switchView(view);
  }),
);

$<HTMLSelectElement>('radius').addEventListener('change', (e) => {
  state.radius = Number((e.target as HTMLSelectElement).value);
  if (tracker.current) {
    update(tracker.current);
    heritageMap.fitRadius(tracker.current, state.radius);
  }
});

$('drawer-handle').addEventListener('click', () => $('drawer').classList.toggle('open'));

async function boot(useDemo: boolean) {
  $('start').hidden = true;
  tracker.onChange(update);
  const fixed = LocationTracker.fromQuery() ?? (useDemo ? DEMO_POSITION : undefined);
  if (fixed) {
    tracker.useFixed(fixed);
    return;
  }
  try {
    await tracker.start();
  } catch (e) {
    $('loc-status').textContent = (e as Error).message;
    notice('map-notice', `${(e as Error).message} 데모 위치(수원 화성)로 표시합니다.`);
    tracker.useFixed(DEMO_POSITION);
  }
}

async function init() {
  const [index] = await Promise.all([
    loadIndex(),
    heritageMap.init().catch((e: Error) => {
      notice('map-notice', `${e.message} 목록으로 표시합니다.`);
      $('drawer').classList.add('open', 'no-map');
    }),
  ]);
  state.items = index.items;

  $('start-btn').addEventListener('click', () => boot(false));
  $('demo-btn').addEventListener('click', () => boot(true));
  if (LocationTracker.fromQuery()) boot(false);
}

init().catch((e) => {
  $('start').hidden = false;
  $('start').querySelector('p')!.textContent = (e as Error).message;
});
