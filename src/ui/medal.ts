import type { Figure } from '../types.ts';
import { asset, esc } from './dom.ts';

/** 목업 인물 일러스트(배경 없는 컷아웃)와 메달용 비단 배경 */
export const ILLUST: Record<Figure['style'], { id: string; silk: string }> = {
  king: { id: 'figKing', silk: 'silkRed' },
  scholar: { id: 'figScholar', silk: 'silkCream' },
  lady: { id: 'figLady', silk: 'silkBlush' },
  general: { id: 'figGeneral', silk: 'silkCel' },
};

interface MedalOpts {
  size: number;
  seal?: boolean;
  cls?: string;
}

/** 단청 금테 원형 초상 메달 (목업 `.med`) */
export function medal(f: Figure, { size, seal = false, cls = '' }: MedalOpts): string {
  const inner = f.portrait
    ? `<img src="${esc(asset(f.portrait))}" alt="${esc(f.name)} 초상" draggable="false" />`
    : // 초상이 아직 없으면 비단 바탕에 한자 이름을 새긴 인장형 메달
      `<div class="med-name"><svg viewBox="0 0 200 200" aria-hidden="true"><rect width="200" height="200" fill="url(#${ILLUST[f.style].silk})"/></svg><span>${esc(f.hanja)}</span></div>`;
  const mark = seal ? `<div class="seal-mark">${esc(f.seal)}</div>` : '';
  return `<div class="med ${cls}" style="--s:${size}px" role="img" aria-label="${esc(f.name)}">${inner}${mark}</div>`;
}

/** 미발견 메달 (목업 `.med.pend`) */
export const lockedMedal = (size: number, cls = '') =>
  `<div class="med pend ${cls}" style="--s:${size}px" aria-label="미발견"></div>`;

/** 이미지(유적지 사진)를 담은 메달 */
export const imageMedal = (url: string | undefined, size: number, alt: string) =>
  url
    ? `<div class="med" style="--s:${size}px"><img src="${esc(url)}" alt="${esc(alt)}" loading="lazy" referrerpolicy="no-referrer" /></div>`
    : `<div class="med mono" style="--s:${size}px">${esc(alt.slice(0, 1))}</div>`;

/** 단색(청자) 메달 (목업 `.med.mono`) */
export const monoMedal = (text: string, size: number) =>
  `<div class="med mono" style="--s:${size}px">${esc(text.slice(0, 1))}</div>`;
