import { app } from './app.ts';
import { loadDetail } from './data.ts';
import { distance, formatDistance } from './geo.ts';
import { go } from './router.ts';
import type { HeritageDetail } from './types.ts';
import { el, esc } from './ui/dom.ts';
import { icons } from './ui/icons.ts';
import { medal } from './ui/medal.ts';

const PREVIEW_CHARS = 200;
const overlay = () => document.getElementById('overlay')!;

export function closeOverlays() {
  overlay().replaceChildren();
}

/** 바닥에서 올라오는 한지 시트 */
export function openBottomSheet(inner: string, cls = ''): HTMLElement {
  const sheet = el(`<div class="sheet ${cls}"><div class="sheet-body">
      <button class="sheet-close icbtn ghost" aria-label="닫기">${icons.close}</button>${inner}</div></div>`);
  const close = () => sheet.remove();
  sheet.addEventListener('click', (e) => {
    if (e.target === sheet) close();
  });
  sheet.querySelector('.sheet-close')!.addEventListener('click', close);
  overlay().appendChild(sheet);
  return sheet;
}

/** 유적지 상세 카드 */
export async function openHeritage(id: string) {
  const sheet = openBottomSheet('<div class="sheet-loading">불러오는 중…</div>');
  const body = sheet.querySelector('.sheet-body')!;
  try {
    const d = await loadDetail(id);
    body.insertAdjacentHTML('beforeend', render(d));
    body.querySelector('.sheet-loading')?.remove();
    bind(sheet, d);
  } catch (e) {
    body.querySelector('.sheet-loading')!.textContent = (e as Error).message;
  }
}

function render(d: HeritageDetail): string {
  const pos = app.pos;
  const dist = pos ? `여기서 ${formatDistance(distance(pos, d))}` : '';
  const text = d.summary ?? d.description;
  const long = !d.summary && text.length > PREVIEW_CHARS;
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => `<p>${esc(p.trim())}</p>`)
    .join('');
  const figures = app.figures.filter((f) => f.sites.some((s) => s.id === d.id));

  return `
    <div class="hs-head">
      <span class="badge">${esc(d.designation)}</span>
      <h2>${esc(d.name)}</h2>
      <div class="hanja">${esc(d.nameHanja)}</div>
      <div class="meta">${[d.era, d.subCategory, dist].filter(Boolean).map(esc).join(' · ')}</div>
    </div>
    ${
      d.images.length
        ? `<div class="gallery">${d.images
            .map(
              (im) =>
                `<figure><img src="${esc(im.url)}" alt="${esc(im.desc || d.name)}" loading="lazy" referrerpolicy="no-referrer" /><figcaption>${esc(im.desc)}</figcaption></figure>`,
            )
            .join('')}</div>`
        : ''
    }
    ${
      figures.length
        ? `<h3>이곳의 인물</h3><div class="hs-figs">${figures
            .map(
              (f) =>
                `<button class="hs-fig" data-fig="${esc(f.id)}">${medal(f, { size: 52 })}<span>${esc(f.name)}</span><em>대화하기</em><small>${esc(
                  f.sites.find((s) => s.id === d.id)?.note ?? '',
                )}</small></button>`,
            )
            .join('')}</div>`
        : ''
    }
    <h3>${d.summary ? '요약' : '설명'}</h3>
    <div class="desc ${long ? 'collapsed' : ''}">${paras}</div>
    ${long ? '<button class="link more">더보기</button>' : ''}
    <div class="addr">${icons.place} ${esc(d.address)}</div>
    ${d.tel ? `<a class="tel" href="tel:${esc(d.tel.replace(/[^0-9+]/g, ''))}">☎ ${esc(d.tel)}</a>` : ''}
    <button class="pill solid talk-guide">${icons.talk} 해설사와 이야기하기</button>
    <div class="sheet-actions">
      <button class="pill outline show-map">${icons.map} 지도에서 보기</button>
      <a class="pill outline" href="${esc(d.sourceUrl)}" target="_blank" rel="noopener">${d.local ? '공공데이터포털' : d.tour ? '경기데이터드림' : '국가유산포털'}</a>
    </div>
    <div class="credit">출처: ${d.local ? `공공데이터포털 전국향토유산표준데이터 (${esc(d.city)})` : d.tour ? '경기데이터드림 경기도 역사관광지 현황' : '국가유산청'}</div>`;
}

function bind(sheet: HTMLElement, d: HeritageDetail) {
  sheet.querySelector('.more')?.addEventListener('click', (e) => {
    sheet.querySelector('.desc')!.classList.remove('collapsed');
    (e.currentTarget as HTMLElement).remove();
  });
  sheet.querySelector('.talk-guide')!.addEventListener('click', () => {
    closeOverlays();
    go(`#/talk/guide?site=${encodeURIComponent(d.id)}`);
  });
  sheet.querySelector('.show-map')!.addEventListener('click', () => {
    closeOverlays();
    go(`#/map?site=${encodeURIComponent(d.id)}`);
  });
  // 이곳의 인물을 누르면 바로 그 인물과 대화
  sheet.querySelectorAll<HTMLElement>('[data-fig]').forEach((b) =>
    b.addEventListener('click', () => {
      closeOverlays();
      go(`#/talk/${encodeURIComponent(b.dataset.fig!)}`);
    }),
  );
}
