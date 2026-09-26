import { angleDiff } from './geo.ts';

/**
 * 기기 방향 센서.
 * heading: 후면 카메라가 향하는 방위(0=북, 시계방향)
 * pitch  : 카메라의 상하 기울기(0=수평, +는 위를 봄)
 */
export interface Orientation {
  heading: number;
  pitch: number;
  absolute: boolean;
}

type IOSOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type PermissionAPI = { requestPermission?: () => Promise<'granted' | 'denied'> };

const rad = Math.PI / 180;

/** W3C DeviceOrientation 명세의 compass heading 계산 (기기를 세워 들어도 동작) */
function compassHeading(alpha: number, beta: number, gamma: number): number {
  const x = beta * rad;
  const y = gamma * rad;
  const z = alpha * rad;
  const cY = Math.cos(y), cZ = Math.cos(z);
  const sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
  const vx = -cZ * sY - sZ * sX * cY;
  const vy = -sZ * sY + cZ * sX * cY;
  let h = Math.atan(vx / vy);
  if (vy < 0) h += Math.PI;
  else if (vx < 0) h += 2 * Math.PI;
  return h / rad;
}

const screenAngle = () => screen.orientation?.angle ?? (window as any).orientation ?? 0;

export class OrientationSensor {
  value: Orientation = { heading: 0, pitch: 0, absolute: false };
  hasSensor = false;
  private started = false;
  private smoothing = 0.2;

  /**
   * iOS 는 사용자 제스처(클릭) 안에서 권한 요청이 필요하므로
   * 반드시 버튼 클릭 핸들러에서 await 이전에 호출할 것.
   */
  requestPermission(): Promise<boolean> {
    const api = DeviceOrientationEvent as unknown as PermissionAPI;
    if (typeof api.requestPermission === 'function') {
      return api.requestPermission().then((s) => s === 'granted').catch(() => false);
    }
    return Promise.resolve(true);
  }

  start() {
    if (this.started) return;
    this.started = true;
    const hasAbsolute = 'ondeviceorientationabsolute' in window;
    window.addEventListener(
      (hasAbsolute ? 'deviceorientationabsolute' : 'deviceorientation') as 'deviceorientation',
      this.onOrientation,
    );
  }

  /** 센서가 없는 환경(데스크톱)에서 드래그로 방향을 돌려볼 때 사용 */
  rotateBy(deltaHeading: number, deltaPitch = 0) {
    this.value.heading = (this.value.heading + deltaHeading + 360) % 360;
    this.value.pitch = Math.max(-45, Math.min(45, this.value.pitch + deltaPitch));
  }

  private onOrientation = (e: DeviceOrientationEvent) => {
    const ios = (e as IOSOrientationEvent).webkitCompassHeading;
    if (e.alpha == null || e.beta == null || e.gamma == null) return;

    let heading: number;
    let absolute: boolean;
    if (typeof ios === 'number' && !Number.isNaN(ios)) {
      heading = ios;
      absolute = true;
    } else {
      heading = compassHeading(e.alpha, e.beta, e.gamma);
      absolute = e.absolute || e.type === 'deviceorientationabsolute';
    }
    heading = (heading + screenAngle() + 360) % 360;
    const pitch = e.beta - 90;

    if (!this.hasSensor) {
      this.hasSensor = true;
      this.value = { heading, pitch, absolute };
      return;
    }
    // 흔들림을 줄이기 위한 저역통과 필터 (방위각은 0/360 경계를 고려)
    const v = this.value;
    v.heading = (v.heading + angleDiff(heading, v.heading) * this.smoothing + 360) % 360;
    v.pitch += (pitch - v.pitch) * this.smoothing;
    v.absolute = absolute;
  };
}
