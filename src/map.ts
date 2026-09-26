import type { Nearby } from './data.ts';
import type { Position } from './location.ts';

declare global {
  interface Window {
    naver?: any;
    navermap_authFailure?: () => void;
  }
}

const KEY_ID = import.meta.env.VITE_NAVER_MAP_KEY_ID as string | undefined;

/** 경기도를 넉넉히 감싸는 범위 (지도 이동 제한) */
const GYEONGGI_BOUNDS = { south: 36.85, west: 126.3, north: 38.35, east: 127.9 };

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

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function categoryClass(category: string): string {
  if (category.includes('유적건조물')) return 'cat-site';
  if (category.includes('자연')) return 'cat-nature';
  if (category.includes('유물')) return 'cat-relic';
  return 'cat-etc';
}

export class HeritageMap {
  private map: any;
  private naver: any;
  private meMarker: any;
  private accuracyCircle: any;
  private markers: any[] = [];
  private centeredOnce = false;

  constructor(
    private el: HTMLElement,
    private onSelect: (id: string) => void,
  ) {}

  async init(): Promise<void> {
    this.naver = await loadNaverMaps();
    const { maps } = this.naver;
    this.map = new maps.Map(this.el, {
      center: new maps.LatLng(37.2818, 127.0137),
      zoom: 15,
      minZoom: 8,
      maxBounds: new maps.LatLngBounds(
        new maps.LatLng(GYEONGGI_BOUNDS.south, GYEONGGI_BOUNDS.west),
        new maps.LatLng(GYEONGGI_BOUNDS.north, GYEONGGI_BOUNDS.east),
      ),
      zoomControl: true,
      zoomControlOptions: { position: maps.Position.TOP_RIGHT, style: maps.ZoomControlStyle.SMALL },
      scaleControl: true,
      mapDataControl: false,
    });
  }

  get ready() {
    return !!this.map;
  }

  setPosition(pos: Position, radius: number) {
    if (!this.map) return;
    const { maps } = this.naver;
    const latlng = new maps.LatLng(pos.lat, pos.lng);
    if (!this.meMarker) {
      this.meMarker = new maps.Marker({
        position: latlng,
        map: this.map,
        zIndex: 1000,
        icon: { content: '<div class="me-dot"></div>', anchor: new maps.Point(10, 10) },
      });
      this.accuracyCircle = new maps.Circle({
        map: this.map,
        center: latlng,
        radius,
        strokeColor: '#7a2e1d',
        strokeOpacity: 0.5,
        strokeWeight: 1,
        fillColor: '#7a2e1d',
        fillOpacity: 0.05,
      });
    } else {
      this.meMarker.setPosition(latlng);
      this.accuracyCircle.setCenter(latlng);
    }
    this.accuracyCircle.setRadius(radius);
    if (!this.centeredOnce) {
      this.centeredOnce = true;
      this.fitRadius(pos, radius);
    }
  }

  fitRadius(pos: Position, radius: number) {
    if (!this.map) return;
    const { maps } = this.naver;
    const dLat = radius / 111320;
    const dLng = radius / (111320 * Math.cos((pos.lat * Math.PI) / 180));
    this.map.fitBounds(
      new maps.LatLngBounds(new maps.LatLng(pos.lat - dLat, pos.lng - dLng), new maps.LatLng(pos.lat + dLat, pos.lng + dLng)),
    );
  }

  setItems(items: Nearby[]) {
    if (!this.map) return;
    const { maps } = this.naver;
    this.markers.forEach((m) => m.setMap(null));
    this.markers = items.map((it) => {
      const m = new maps.Marker({
        position: new maps.LatLng(it.lat, it.lng),
        map: this.map,
        title: it.name,
        icon: {
          content: `<div class="pin ${categoryClass(it.category)}"><span>${escapeHtml(it.name)}</span></div>`,
          anchor: new maps.Point(12, 30),
        },
      });
      maps.Event.addListener(m, 'click', () => this.onSelect(it.id));
      return m;
    });
  }

  panTo(lat: number, lng: number) {
    if (!this.map) return;
    this.map.panTo(new this.naver.maps.LatLng(lat, lng));
  }
}
