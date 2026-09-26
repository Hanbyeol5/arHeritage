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
  static MAX_LABELS = 12;
  /** 표시 반경(m) — 화면에서 1·3·5·10km 중 고른다 */
  radius = 10000;

  private stream?: MediaStream;
  private running = false;
  private labels = new Map<string, HTMLElement>();
  private items: Nearby[] = [];
  private position?: Position;
  target?: HeritageSummary;
  /** 역사 인물과 연결된 유적 — 겹칠 때 대표로 우선 */
  important = new Set<string>();
  /** 겹쳐서 숨긴 유적: 대표 id → 숨긴 id 목록 */
  private groups = new Map<string, string[]>();
  /** 겹친 유적 묶음을 눌렀을 때 (대표가 맨 앞) */
  onSelectGroup?: (ids: string[]) => void;
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
      .filter((c) => c.d <= this.radius || c.it.id === this.target?.id)
      .map((c) => ({ ...c, delta: angleDiff(bearing(pos, c.it), heading) }));

    const inView = candidates
      .filter((c) => {
        const onScreen = Math.abs(c.delta) <= AREngine.H_FOV / 2 + 5;
        if (!onScreen) c.delta < 0 ? left++ : right++;
        return onScreen;
      })
      .map((c) => {
        const isTarget = c.it.id === this.target?.id;
        // 멀수록 위쪽·작게 배치, 타깃은 멀리 있어도 눈높이 근처
        const t = isTarget ? 0.2 : Math.min(1, Math.log1p(c.d / 100) / Math.log1p(this.radius / 100));
        const scale = isTarget ? 1.15 : 1.05 - t * 0.4;
        const x = w / 2 + c.delta * pxPerDegX;
        const y = horizonY - 40 - t * h * 0.28;
        const bw = Math.min(176, 44 + c.it.name.length * 13) * scale;
        const bh = 58 * scale;
        return { ...c, isTarget, scale, x, y, box: [x - bw / 2, y - bh, x + bw / 2, y] as const, score: this.score(c.it, c.d, isTarget) };
      })
      // 중요한 유적부터 자리를 잡고, 겹치는 라벨은 대표 라벨의 '+N' 으로 묶는다
      .sort((a, b) => b.score - a.score);

    this.groups.clear();
    const placed: typeof inView = [];
    for (const c of inView) {
      const hit = placed.find((p) => c.box[0] < p.box[2] + 4 && c.box[2] > p.box[0] - 4 && c.box[1] < p.box[3] + 4 && c.box[3] > p.box[1] - 4);
      if (hit || placed.length >= AREngine.MAX_LABELS) {
        const owner = hit ?? placed.reduce((m, p) => (Math.abs(p.x - c.x) < Math.abs(m.x - c.x) ? p : m));
        const g = this.groups.get(owner.it.id) ?? [];
        g.push(c.it.id);
        this.groups.set(owner.it.id, g);
        continue;
      }
      placed.push(c);
    }

    for (const c of placed) {
      const el = this.label(c.it);
      visible.add(c.it.id);
      el.classList.toggle('target', c.isTarget);
      el.querySelector('.ar-dist')!.textContent = formatDistance(c.d);
      const more = this.groups.get(c.it.id)?.length ?? 0;
      const badge = el.querySelector<HTMLElement>('.ar-more')!;
      badge.hidden = !more;
      badge.textContent = `+${more}`;
      el.style.transform = `translate(${c.x}px, ${c.y}px) translate(-50%, -100%) scale(${c.scale})`;
      el.style.zIndex = c.isTarget ? '2000' : String(1000 + Math.round(c.score));
      el.hidden = false;
    }

    this.labels.forEach((el, id) => {
      if (!visible.has(id)) el.hidden = true;
    });

    const target = this.target
      ? { distance: distance(pos, this.target), delta: angleDiff(bearing(pos, this.target), heading) }
      : undefined;
    this.onFrame?.(heading, target, { left, right });
  }

  /** 대표로 보일 우선순위: 찾아갈 장소 > 지정 등급 > 인물 연결 > 가까움 */
  private score(it: HeritageSummary, d: number, isTarget: boolean): number {
    if (isTarget) return 1e6;
    const g = it.designation;
    const grade = /국보/.test(g)
      ? 100
      : /보물/.test(g)
        ? 90
        : /사적/.test(g)
          ? 85
          : /명승|천연기념물/.test(g)
            ? 75
            : /국가(민속|무형)/.test(g)
              ? 70
              : it.local
                ? 40
                : it.tour
                  ? 45
                  : /등록|문화유산자료/.test(g)
                    ? 50
                    : 60;
    // 유물·기록유산·무형유산은 찾아가 볼 '장소'가 아니므로 대표에서 뒤로
    const place = /유물|기록유산|무형/.test(it.category) ? -75 : 0;
    return grade + place + (this.important.has(it.id) ? 25 : 0) - Math.log10(Math.max(d, 10)) * 6;
  }

  private label(it: HeritageSummary): HTMLElement {
    let el = this.labels.get(it.id);
    if (!el) {
      el = document.createElement('button');
      el.className = `ar-label${it.local ? ' local' : it.tour ? ' tour' : ''}`;
      el.innerHTML = `<strong></strong><small></small><span class="ar-dist"></span><span class="ar-more" hidden></span>`;
      el.querySelector('strong')!.textContent = it.name;
      el.querySelector('small')!.textContent = it.designation;
      el.addEventListener('click', () => {
        const hidden = this.groups.get(it.id);
        if (hidden?.length && this.onSelectGroup) this.onSelectGroup([it.id, ...hidden]);
        else this.onSelect(it.id);
      });
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
