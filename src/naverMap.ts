import type { Position } from './location.ts';
import type { Figure, HeritageSummary } from './types.ts';
import { esc } from './ui/dom.ts';
import { medal } from './ui/medal.ts';

declare global {
  interface Window {
    naver?: any;
    navermap_authFailure?: () => void;
  }
}

const KEY_ID = import.meta.env.VITE_NAVER_MAP_KEY_ID as string | undefined;

/** 경기도를 넉넉히 감싸는 범위 (지도 이동 제한) */
const BOUNDS = { south: 36.85, west: 126.3, north: 38.35, east: 127.9 };

let loader: Promise<any> | undefined;

function loadNaverMaps(): Promise<any> {
  loader ??= new Promise((resolve, reject) => {
    if (!KEY_ID) {
      reject(new Error('네이버 지도 키(VITE_NAVER_MAP_KEY_ID)가 설정되지 않았습니다.'));
      return;
    }
    window.navermap_authFailure = () =>
      reject(new Error('네이버 지도 인증 실패: NCP 콘솔의 Web 서비스 URL 등록을 확인하세요.'));
    const s = document.createElement('script');
    s.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${encodeURIComponent(KEY_ID)}`;
    s.onload = () => (window.naver?.maps ? resolve(window.naver) : reject(new Error('네이버 지도 로드 실패')));
    s.onerror = () => reject(new Error('네이버 지도 스크립트를 불러오지 못했습니다.'));
    document.head.appendChild(s);
  });
  return loader;
}

export interface FigurePin {
  figure: Figure;
  site: HeritageSummary;
}

/**
 * 네이버 지도 래퍼. 지도는 한 번만 만들고, 지도 화면에 들어올 때마다 같은 요소를 다시 붙인다.
 */
class HeritageMap {
  readonly el = Object.assign(document.createElement('div'), { className: 'map-canvas' });
  private map: any;
  private maps: any;
  private me?: any;
  private figureMarkers = new Map<string, any>();
  private siteMarkers: any[] = [];
  private circle?: any;
  private initPromise?: Promise<void>;

  init(): Promise<void> {
    this.initPromise ??= loadNaverMaps().then((naver) => {
      this.maps = naver.maps;
      const { maps } = this;
      this.map = new maps.Map(this.el, {
        center: new maps.LatLng(37.2818, 127.0137),
        zoom: 15,
        minZoom: 8,
        maxBounds: new maps.LatLngBounds(
          new maps.LatLng(BOUNDS.south, BOUNDS.west),
          new maps.LatLng(BOUNDS.north, BOUNDS.east),
        ),
        scaleControl: false,
        mapDataControl: false,
        logoControlOptions: { position: maps.Position.BOTTOM_LEFT },
      });
      // 넓게 볼 때(반경 5·10km)는 일반 유적 이름표를 숨겨 겹침을 줄인다 — 확대하면 다시 보인다
      const zoomClass = () => this.el.classList.toggle('far', this.map.getZoom() < 13);
      maps.Event.addListener(this.map, 'zoom_changed', zoomClass);
      zoomClass();
    });
    return this.initPromise;
  }

  /** 화면에 다시 붙은 뒤 크기 재계산 */
  refresh() {
    this.map?.autoResize?.();
  }

  setMe(pos: Position) {
    if (!this.map) return;
    const latlng = new this.maps.LatLng(pos.lat, pos.lng);
    if (!this.me) {
      this.me = new this.maps.Marker({
        position: latlng,
        map: this.map,
        zIndex: 50,
        icon: { content: '<div class="map-me"></div>', anchor: new this.maps.Point(12, 12) },
      });
    } else this.me.setPosition(latlng);
  }

  setFigures(pins: FigurePin[], activeId: string | undefined, onClick: (id: string) => void) {
    if (!this.map) return;
    const { maps } = this;
    this.figureMarkers.forEach((m) => m.setMap(null));
    this.figureMarkers.clear();
    // 같은 유적지의 인물 핀은 겹치지 않게 좌우로 벌린다
    const bySite = new Map<string, FigurePin[]>();
    pins.forEach((p) => bySite.set(p.site.id, [...(bySite.get(p.site.id) ?? []), p]));
    for (const { figure, site } of pins) {
      const group = bySite.get(site.id)!;
      const offset = (group.findIndex((p) => p.figure.id === figure.id) - (group.length - 1) / 2) * 34;
      const act = figure.id === activeId;
      const m = new maps.Marker({
        position: new maps.LatLng(site.lat, site.lng),
        map: this.map,
        title: figure.name,
        zIndex: act ? 40 : 30,
        icon: {
          content: `<div class="ping ${act ? 'act' : ''}"><div class="pin">${medal(figure, { size: 28 })}</div></div>`,
          anchor: new maps.Point(19 - offset, 44),
        },
      });
      maps.Event.addListener(m, 'click', () => onClick(figure.id));
      this.figureMarkers.set(figure.id, m);
    }
  }

  setSites(sites: HeritageSummary[], onClick: (id: string) => void) {
    if (!this.map) return;
    const { maps } = this;
    this.siteMarkers.forEach((m) => m.setMap(null));
    this.siteMarkers = sites.map((s) => {
      const m = new maps.Marker({
        position: new maps.LatLng(s.lat, s.lng),
        map: this.map,
        title: s.name,
        zIndex: 10,
        icon: {
          content: `<div class="ping site"><div class="pin no"><span class="pdot"></span></div><span class="ping-label">${esc(s.name)}</span></div>`,
          anchor: new maps.Point(13, 30),
        },
      });
      maps.Event.addListener(m, 'click', () => onClick(s.id));
      return m;
    });
  }

  /** 내 위치를 중심으로 한 표시 반경 — 반투명 영역 */
  setRadius(pos: Position, meters: number) {
    if (!this.map) return;
    const { maps } = this;
    const center = new maps.LatLng(pos.lat, pos.lng);
    if (!this.circle) {
      this.circle = new maps.Circle({
        map: this.map,
        center,
        radius: meters,
        fillColor: '#b23a32',
        fillOpacity: 0.08,
        strokeColor: '#b23a32',
        strokeOpacity: 0.55,
        strokeWeight: 1.5,
        strokeStyle: 'shortdash',
        clickable: false,
        zIndex: 1,
      });
    } else {
      this.circle.setCenter(center);
      this.circle.setRadius(meters);
    }
  }

  /** 반경 원이 화면에 꽉 차게 */
  fitRadius(pos: Position, meters: number) {
    const dLat = meters / 111_320;
    const dLng = meters / (111_320 * Math.cos((pos.lat * Math.PI) / 180));
    this.fitPoints(
      [
        { lat: pos.lat - dLat, lng: pos.lng - dLng },
        { lat: pos.lat + dLat, lng: pos.lng + dLng },
      ],
      0,
    );
  }

  panTo(lat: number, lng: number) {
    this.map?.panTo(new this.maps.LatLng(lat, lng));
  }

  /** 두 지점이 모두 보이도록 (카드·상단 안내 영역 여백 포함) */
  fitPoints(points: { lat: number; lng: number }[], pad = 0.0015) {
    if (!this.map || !points.length) return;
    const { maps } = this;
    const lats = points.map((p) => p.lat);
    const lngs = points.map((p) => p.lng);
    this.map.fitBounds(
      new maps.LatLngBounds(
        new maps.LatLng(Math.min(...lats) - pad, Math.min(...lngs) - pad),
        new maps.LatLng(Math.max(...lats) + pad, Math.max(...lngs) + pad),
      ),
      { top: 120, right: 20, bottom: 110, left: 20 },
    );
  }
}

export const heritageMap = new HeritageMap();
