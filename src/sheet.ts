import { loadDetail } from './data.ts';
import { distance, formatDistance } from './geo.ts';
import type { Position } from './location.ts';
import type { HeritageDetail } from './types.ts';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const PREVIEW_CHARS = 220;

/** 상세 카드(바텀시트). 지도·AR 양쪽에서 공용으로 사용 */
export class DetailSheet {
  private currentId?: string;

  constructor(
    private root: HTMLElement,
    private body: HTMLElement,
    private getPosition: () => Position | undefined,
    private onShowOnMap: (d: HeritageDetail) => void,
  ) {
    root.addEventListener('click', (e) => {
      if (e.target === root) this.close();
    });
  }

  async open(id: string) {
    this.currentId = id;
    this.root.hidden = false;
    this.root.classList.toggle('over-camera', !document.getElementById('view-ar')!.hidden);
    this.body.innerHTML = '<div class="sheet-loading">불러오는 중…</div>';
    try {
      const d = await loadDetail(id);
      if (this.currentId === id) this.render(d);
    } catch (e) {
      this.body.innerHTML = `<div class="sheet-loading">${esc((e as Error).message)}</div>`;
    }
  }

  close() {
    this.currentId = undefined;
    this.root.hidden = true;
  }

  private render(d: HeritageDetail) {
    const pos = this.getPosition();
    const dist = pos ? formatDistance(distance(pos, d)) : '';
    const text = d.summary ?? d.description;
    const long = !d.summary && text.length > PREVIEW_CHARS;
    const paragraphs = (s: string) =>
      s
        .split(/\n\s*\n/)
        .map((p) => `<p>${esc(p.trim())}</p>`)
        .join('');

    const images = d.images.length
      ? `<div class="gallery">${d.images
          .map((im) => `<figure><img src="${esc(im.url)}" alt="${esc(im.desc || d.name)}" loading="lazy" referrerpolicy="no-referrer" /><figcaption>${esc(im.desc)}</figcaption></figure>`)
          .join('')}</div>`
      : '';

    const persons = d.persons?.length
      ? `<h3>관련 인물</h3><ul class="persons">${d.persons
          .map(
            (p) => `<li>
              ${p.portrait ? `<img src="${esc(p.portrait.url)}" alt="${esc(p.name)} 초상" title="${esc(p.portrait.credit)}" />` : '<div class="no-portrait"></div>'}
              <div><strong>${esc(p.name)}</strong>${p.hanja ? ` <span>${esc(p.hanja)}</span>` : ''}${p.years ? ` <em>${esc(p.years)}</em>` : ''}<p>${esc(p.role)}</p></div>
            </li>`,
          )
          .join('')}</ul>`
      : '';

    this.body.innerHTML = `
      <button class="sheet-close" aria-label="닫기">✕</button>
      <div class="sheet-head">
        <span class="badge">${esc(d.designation)}</span>
        <h2>${esc(d.name)}</h2>
        <div class="hanja">${esc(d.nameHanja)}</div>
        <div class="meta">${[d.era, d.subCategory, dist && `여기서 ${dist}`].filter(Boolean).map(esc).join(' · ')}</div>
      </div>
      ${images}
      <h3>${d.summary ? '요약' : '설명'}</h3>
      <div class="desc ${long ? 'collapsed' : ''}">${paragraphs(text)}</div>
      ${long ? '<button class="link more">더보기</button>' : ''}
      ${persons}
      <div class="addr">${esc(d.address)}</div>
      <div class="sheet-actions">
        <button class="secondary show-map">지도에서 보기</button>
        <a class="secondary" href="${esc(d.sourceUrl)}" target="_blank" rel="noopener">국가유산포털</a>
      </div>
      <div class="credit">출처: 국가유산청</div>
    `;
    this.body.querySelector('.sheet-close')!.addEventListener('click', () => this.close());
    this.body.querySelector('.more')?.addEventListener('click', (e) => {
      this.body.querySelector('.desc')!.classList.remove('collapsed');
      (e.target as HTMLElement).remove();
    });
    this.body.querySelector('.show-map')!.addEventListener('click', () => {
      this.close();
      this.onShowOnMap(d);
    });
    this.body.scrollTop = 0;
  }
}
