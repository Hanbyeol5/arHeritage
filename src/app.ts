import { findNearby, loadIndex, type Nearby } from './data.ts';
import { bearing, distance, formatDistance } from './geo.ts';
import { LocationTracker, type Position } from './location.ts';
import { OrientationSensor } from './orientation.ts';
import { store } from './store.ts';
import type { Figure, HeritageSummary } from './types.ts';
import { toast } from './ui/dom.ts';

export interface NearbyFigure {
  figure: Figure;
  /** 인물 관련 유적지 중 가장 가까운 곳 */
  site: HeritageSummary;
  note: string;
  distance: number;
  bearing: number;
}

/** 유적지 도착 판정 반경(m) */
export const SITE_ARRIVAL_M = 150;
/** 관련 유적지에 이만큼 가까워지면 인물을 '만난' 것으로 기록 */
export const FIGURE_MEET_M = 300;

class App {
  items: HeritageSummary[] = [];
  siteById = new Map<string, HeritageSummary>();
  figures: Figure[] = [];
  figureById = new Map<string, Figure>();
  tracker = new LocationTracker();
  sensor = new OrientationSensor();

  get pos(): Position | undefined {
    return this.tracker.current;
  }

  async load() {
    const [index, figs] = await Promise.all([
      loadIndex(),
      fetch(`${import.meta.env.BASE_URL}data/figures.json`).then((r) => r.json() as Promise<{ figures: Figure[] }>),
    ]);
    this.items = index.items;
    this.items.forEach((s) => this.siteById.set(s.id, s));
    // 좌표 데이터에 없는 유적지는 연결에서 제외
    this.figures = figs.figures
      .map((f) => ({ ...f, sites: f.sites.filter((s) => this.siteById.has(s.id)) }))
      .filter((f) => f.sites.length);
    this.figures.forEach((f) => this.figureById.set(f.id, f));
    this.tracker.onChange((p) => this.checkArrivals(p));
  }

  nearbySites(radius: number, pos = this.pos): Nearby[] {
    return pos ? findNearby(this.items, pos, radius) : [];
  }

  nearestSiteOf(f: Figure, pos = this.pos): NearbyFigure {
    let best: NearbyFigure | undefined;
    for (const s of f.sites) {
      const site = this.siteById.get(s.id)!;
      const d = pos ? distance(pos, site) : Infinity;
      if (!best || d < best.distance) {
        best = { figure: f, site, note: s.note, distance: d, bearing: pos ? bearing(pos, site) : 0 };
      }
    }
    return best!;
  }

  /** 가까운 순 인물 목록 */
  nearbyFigures(pos = this.pos): NearbyFigure[] {
    return this.figures.map((f) => this.nearestSiteOf(f, pos)).sort((a, b) => a.distance - b.distance);
  }

  distanceLabel(m: number) {
    return Number.isFinite(m) ? formatDistance(m) : '—';
  }

  /** 유적지 도착·인물 만남을 도감과 알림에 기록 (앱이 열려 있는 동안만 동작) */
  private checkArrivals(pos: Position) {
    // 데모 위치로는 도감이 채워지지 않도록 (개발 모드에서는 테스트를 위해 허용)
    if (pos.simulated && !import.meta.env.DEV) return;
    for (const s of this.nearbySites(SITE_ARRIVAL_M, pos)) {
      if (store.isDiscovered('site', s.id)) continue;
      store.record({
        type: 'site',
        refId: s.id,
        name: s.name,
        subtitle: [s.designation, s.era, s.city].filter(Boolean).join(' · '),
        description: '',
        imageUrl: s.thumb,
      });
      store.notify({ title: `${s.name}에 도착했습니다`, body: `${s.designation} · ${s.city}`, siteId: s.id });
      toast(`📍 ${s.name}에 도착했습니다`);
    }
    for (const nf of this.nearbyFigures(pos)) {
      if (nf.distance > FIGURE_MEET_M) break;
      const f = nf.figure;
      if (!store.isDiscovered('figure', f.id)) {
        store.record({ type: 'figure', refId: f.id, name: f.name, subtitle: `${f.title} · ${f.years}`, description: f.bio });
        store.notify({
          title: `${nf.figure.name}을(를) 만날 수 있습니다`,
          body: `${nf.site.name} · ${nf.note}`,
          siteId: nf.site.id,
        });
      }
    }
  }
}

export const app = new App();
