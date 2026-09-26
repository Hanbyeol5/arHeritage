import type { Nearby } from './data.ts';
import { angleDiff, bearing, distance, formatDistance } from './geo.ts';
import type { Position } from './location.ts';
import type { OrientationSensor } from './orientation.ts';
import type { HeritageSummary } from './types.ts';

export interface TargetInfo {
  distance: number;
  /** 카메라 방향 기준 타깃까지의 각도 (-180~180, +는 오른쪽) */
  delta: number;
}

/**
 * 위치 기반 AR.
 * 카메라 영상 위에 HTML 라벨을 겹쳐, 각 유적지의 방위각이 카메라 시야 안에 들어오면 표시한다.
 * GPS(±5~20m)·나침반(±10~20°) 오차가 있으므로 "방향 안내" 수준의 정확도를 목표로 한다.
 */
export class AREngine {
  /** 세로 모드 기준 대략적인 후면 카메라 시야각 */
  static H_FOV = 55;
  static V_FOV = 70;
  static MAX_DISTANCE = 2000;
  static MAX_LABELS = 10;

  private stream?: MediaStream;
  private running = false;
  private labels = new Map<string, HTMLElement>();
  private items: Nearby[] = [];
  private position?: Position;
  target?: HeritageSummary;
  onFrame?: (heading: number, target?: TargetInfo, off?: { left: number; right: number }) => void;

  constructor(
    private video: HTMLVideoElement,
    private layer: HTMLElement,
    private sensor: OrientationSensor,
    private onSelect: (id: string) => void,
  ) {
    this.enableDragFallback();
  }

  setData(items: Nearby[], position: Position) {
    this.items = items;
    this.position = position;
  }

  async start(): Promise<void> {
    this.sensor.start();
    // 카메라가 실패해도 라벨은 계속 그린다 (데스크톱 테스트·권한 거부 시)
    if (!this.running) {
      this.running = true;
      requestAnimationFrame(this.frame);
    }
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('이 브라우저는 카메라를 지원하지 않습니다. (HTTPS 접속인지 확인하세요)');
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      throw new Error(
        (e as DOMException).name === 'NotAllowedError'
          ? '카메라 권한이 거부되었습니다. 브라우저 설정에서 카메라를 허용해 주세요.'
          : '카메라를 시작할 수 없습니다.',
      );
    }
    if (!this.running) return this.stop(); // 시작 도중 화면을 떠난 경우
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
  }

  stop() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.video.srcObject = null;
  }

  private frame = () => {
    if (!this.running) return;
    this.render();
    requestAnimationFrame(this.frame);
  };

  render() {
    const { heading, pitch } = this.sensor.value;
    if (!this.position) return this.onFrame?.(heading);
    const pos = this.position;

    const w = this.layer.clientWidth;
    const h = this.layer.clientHeight;
    const pxPerDegX = w / AREngine.H_FOV;
    const pxPerDegY = h / AREngine.V_FOV;
    const horizonY = h / 2 + pitch * pxPerDegY;

    let left = 0;
    let right = 0;
    const visible = new Set<string>();
    const candidates = this.items
      .map((it) => ({ it, d: distance(pos, it) }))
      .filter((c) => c.d <= AREngine.MAX_DISTANCE || c.it.id === this.target?.id)
      .map((c) => ({ ...c, delta: angleDiff(bearing(pos, c.it), heading) }));

    const inView = candidates
      .filter((c) => {
        const onScreen = Math.abs(c.delta) <= AREngine.H_FOV / 2 + 5;
        if (!onScreen) c.delta < 0 ? left++ : right++;
        return onScreen;
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, AREngine.MAX_LABELS);

    inView.forEach((c, rank) => {
      const isTarget = c.it.id === this.target?.id;
      const el = this.label(c.it);
      visible.add(c.it.id);
      el.classList.toggle('target', isTarget);
      el.querySelector('.ar-dist')!.textContent = formatDistance(c.d);
      // 멀수록 위쪽·작게 배치해 겹침을 줄인다
      // 타깃은 멀리 있어도 눈높이 근처에 둔다
      const t = isTarget ? 0.2 : Math.min(1, c.d / AREngine.MAX_DISTANCE);
      const x = w / 2 + c.delta * pxPerDegX;
      const y = horizonY - 40 - t * h * 0.28 - (rank % 3) * 14;
      const scale = isTarget ? 1.15 : 1.05 - t * 0.4;
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -100%) scale(${scale})`;
      el.style.zIndex = isTarget ? '2000' : String(1000 - Math.round(c.d / 10));
      el.hidden = false;
    });

    this.labels.forEach((el, id) => {
      if (!visible.has(id)) el.hidden = true;
    });

    const target = this.target
      ? { distance: distance(pos, this.target), delta: angleDiff(bearing(pos, this.target), heading) }
      : undefined;
    this.onFrame?.(heading, target, { left, right });
  }

  private label(it: HeritageSummary): HTMLElement {
    let el = this.labels.get(it.id);
    if (!el) {
      el = document.createElement('button');
      el.className = `ar-label${it.local ? ' local' : it.tour ? ' tour' : ''}`;
      el.innerHTML = `<strong></strong><small></small><span class="ar-dist"></span>`;
      el.querySelector('strong')!.textContent = it.name;
      el.querySelector('small')!.textContent = it.designation;
      el.addEventListener('click', () => this.onSelect(it.id));
      this.layer.appendChild(el);
      this.labels.set(it.id, el);
    }
    return el;
  }

  /** 방향 센서가 없는 데스크톱에서는 드래그·화살표 키로 시점을 돌려 테스트 */
  private enableDragFallback() {
    let lastX: number | undefined;
    let lastY = 0;
    this.layer.addEventListener('pointerdown', (e) => {
      if (this.sensor.hasSensor) return;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    this.layer.addEventListener('pointermove', (e) => {
      if (lastX === undefined) return;
      this.sensor.rotateBy(-(e.clientX - lastX) / 6, (e.clientY - lastY) / 8);
      lastX = e.clientX;
      lastY = e.clientY;
    });
    this.layer.addEventListener('pointerup', () => (lastX = undefined));
    this.layer.addEventListener('pointerleave', () => (lastX = undefined));
  }

  handleKey = (e: KeyboardEvent) => {
    if (this.sensor.hasSensor || !this.running) return;
    if (e.key === 'ArrowLeft') this.sensor.rotateBy(-5);
    if (e.key === 'ArrowRight') this.sensor.rotateBy(5);
  };
}

export function toCompass(h: number): string {
  return ['북', '북동', '동', '남동', '남', '남서', '서', '북서'][Math.round(h / 45) % 8];
}
