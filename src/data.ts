import type { HeritageDetail, HeritageIndex, HeritageSummary } from './types.ts';
import { distance, type LatLng } from './geo.ts';

const dataUrl = (p: string) => `${import.meta.env.BASE_URL}data/${p}`;

let indexPromise: Promise<HeritageIndex> | undefined;
const detailCache = new Map<string, Promise<HeritageDetail>>();

export function loadIndex(): Promise<HeritageIndex> {
  indexPromise ??= fetch(dataUrl('index.json')).then((r) => {
    if (!r.ok) throw new Error(`데이터를 불러오지 못했습니다 (${r.status})`);
    return r.json();
  });
  return indexPromise;
}

export function loadDetail(id: string): Promise<HeritageDetail> {
  let p = detailCache.get(id);
  if (!p) {
    p = fetch(dataUrl(`detail/${id}.json`)).then((r) => {
      if (!r.ok) throw new Error(`상세 정보를 불러오지 못했습니다 (${r.status})`);
      return r.json();
    });
    p.catch(() => detailCache.delete(id));
    detailCache.set(id, p);
  }
  return p;
}

export interface Nearby extends HeritageSummary {
  distance: number;
}

export function findNearby(items: HeritageSummary[], here: LatLng, radius: number): Nearby[] {
  return items
    .map((it) => ({ ...it, distance: distance(here, it) }))
    .filter((it) => it.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}
