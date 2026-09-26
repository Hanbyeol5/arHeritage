import { app } from './app.ts';
import { loadDetail } from './data.ts';
import { distance, formatDistance } from './geo.ts';
import { closeOverlays, openBottomSheet, openHeritage } from './heritageSheet.ts';
import { go } from './router.ts';
import { esc } from './ui/dom.ts';
import { josa } from './ui/josa.ts';
import { icons } from './ui/icons.ts';
import { medal } from './ui/medal.ts';

/** 네이버 지도 앱 길찾기 (앱이 없으면 웹 지도) */
export function openNaverRoute(lat: number, lng: number, name: string) {
  const app_ = encodeURIComponent(location.origin + location.pathname);
  const scheme = `nmap://route/walk?dlat=${lat}&dlng=${lng}&dname=${encodeURIComponent(name)}&appname=${app_}`;
  const web = `https://map.naver.com/index.nhn?elng=${lng}&elat=${lat}&etext=${encodeURIComponent(name)}&menu=route&pathType=1`;
  const started = Date.now();
  location.href = scheme;
  // 앱이 열리지 않아 페이지가 그대로면 웹 지도로
  setTimeout(() => {
    if (document.visibilityState === 'visible' && Date.now() - started < 2500) window.open(web, '_blank', 'noopener');
  }, 1500);
}

/**
 * AR 라벨을 눌렀을 때 — 여기로 안내 · 길찾기 · 대화 · 자세히
 */
export function openSiteActions(id: string) {
  const s = app.siteById.get(id);
  if (!s) return;
  const figures = app.figures.filter((f) => f.sites.some((x) => x.id === id));
  const dist = app.pos ? `여기서 ${formatDistance(distance(app.pos, s))}` : '';
  const tag = s.local ? '향토유산' : s.tour ? '역사관광지' : s.designation;

  const sheet = openBottomSheet(
    `<div class="act-head">
      <span class="badge">${esc(tag)}</span>
      <h2>${esc(s.name)}</h2>
      <div class="meta">${[s.city, s.era, dist].filter(Boolean).map(esc).join(' · ')}</div>
      <p class="lead act-summary" hidden></p>
    </div>
    <div class="act-grid">
      <button class="act" data-act="ar"><b>📍</b>여기로 안내</button>
      <button class="act" data-act="route"><b>🧭</b>길찾기</button>
      <button class="act" data-act="info"><b>📜</b>자세히</button>
    </div>
    <div class="act-talk">
      ${figures
        .map(
          (f) =>
            `<button class="act-fig" data-fig="${esc(f.id)}">${medal(f, { size: 40 })}<span><b>${esc(f.name)}</b>${josa(f.name, '과/와').slice(f.name.length)} 대화</span></button>`,
        )
        .join('')}
      <button class="pill solid" data-act="guide">${icons.talk} 해설사와 이야기하기</button>
    </div>`,
    'actions',
  );

  // 요약이 있으면 보여 준다 (LLM 보강 결과)
  loadDetail(id)
    .then((d) => {
      const el = sheet.querySelector<HTMLElement>('.act-summary');
      if (el && d.summary) {
        el.textContent = d.summary;
        el.hidden = false;
      }
    })
    .catch(() => {});

  const on = (sel: string, fn: () => void) => sheet.querySelector(sel)?.addEventListener('click', fn);
  on('[data-act=ar]', () => {
    closeOverlays();
    go(`#/ar?site=${encodeURIComponent(id)}`);
  });
  on('[data-act=route]', () => openNaverRoute(s.lat, s.lng, s.name));
  on('[data-act=info]', () => {
    sheet.remove();
    openHeritage(id);
  });
  on('[data-act=guide]', () => {
    closeOverlays();
    go(`#/talk/guide?site=${encodeURIComponent(id)}`);
  });
  sheet.querySelectorAll<HTMLElement>('[data-fig]').forEach((b) =>
    b.addEventListener('click', () => {
      closeOverlays();
      go(`#/talk/${encodeURIComponent(b.dataset.fig!)}`);
    }),
  );
}
