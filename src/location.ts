import type { LatLng } from './geo.ts';

export interface Position extends LatLng {
  accuracy: number;
  simulated: boolean;
}

type Listener = (pos: Position) => void;

/** 데모/데스크톱 테스트용 기본 위치: 수원 화성행궁 */
export const DEMO_POSITION: Position = { lat: 37.2818, lng: 127.0137, accuracy: 0, simulated: true };

/**
 * 위치 추적.
 * URL 에 ?lat=..&lng=.. 가 있으면 그 좌표로 고정한다 (실내·데스크톱 테스트용).
 */
export class LocationTracker {
  private listeners = new Set<Listener>();
  private watchId?: number;
  current?: Position;

  onChange(fn: Listener) {
    this.listeners.add(fn);
    if (this.current) fn(this.current);
  }

  private emit(pos: Position) {
    this.current = pos;
    this.listeners.forEach((fn) => fn(pos));
  }

  static fromQuery(): Position | undefined {
    const q = new URLSearchParams(location.search);
    const lat = Number(q.get('lat'));
    const lng = Number(q.get('lng'));
    return lat && lng ? { lat, lng, accuracy: 0, simulated: true } : undefined;
  }

  useFixed(pos: Position) {
    this.stop();
    this.emit(pos);
  }

  /** 첫 위치를 받으면 resolve, 권한 거부·실패 시 reject */
  start(): Promise<Position> {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('이 브라우저는 위치 기능을 지원하지 않습니다.'));
        return;
      }
      let first = true;
      this.watchId = navigator.geolocation.watchPosition(
        (p) => {
          const pos = { lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy, simulated: false };
          this.emit(pos);
          if (first) {
            first = false;
            resolve(pos);
          }
        },
        (err) => {
          if (first) {
            first = false;
            reject(new Error(err.code === err.PERMISSION_DENIED ? '위치 권한이 거부되었습니다.' : '위치를 확인할 수 없습니다.'));
          }
        },
        { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 },
      );
    });
  }

  stop() {
    if (this.watchId !== undefined) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = undefined;
  }
}
