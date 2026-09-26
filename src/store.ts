/**
 * 기기 내 저장소 (역사의 전당 도감, 위치 알림).
 * localStorage 는 사생활 보호 모드 등에서 실패할 수 있으므로 모든 접근을 try/catch 로 감싼다.
 */
export type DiscoveryType = 'site' | 'figure' | 'relic';

/** 도감 항목 — 카메라로 인식한 유물·유적, 만난 인물 (historydam Discovery 와 동일 구조) */
export interface Discovery {
  type: DiscoveryType;
  /** 국가유산 id / 인물 id / AI 판별 결과는 "vision:<이름>" */
  refId: string;
  name: string;
  subtitle: string;
  description: string;
  imageUrl?: string;
  at: number;
}

export interface NotificationItem {
  id: string;
  at: number;
  title: string;
  body: string;
  siteId: string;
  read?: boolean;
}

interface StoreData {
  discoveries: Discovery[];
  notifications: NotificationItem[];
  nickname: string;
}

const KEY = 'yeoksadam:v2';
const empty = (): StoreData => ({ discoveries: [], notifications: [], nickname: '나그네' });

function load(): StoreData {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...empty(), ...JSON.parse(raw) } : empty();
  } catch {
    return empty();
  }
}

const data = load();
const listeners = new Set<() => void>();
const same = (a: Pick<Discovery, 'type' | 'refId'>, b: Pick<Discovery, 'type' | 'refId'>) =>
  a.type === b.type && a.refId === b.refId;

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* 저장 불가 환경: 메모리에서만 유지 */
  }
  listeners.forEach((fn) => fn());
}

export const store = {
  onChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => void listeners.delete(fn);
  },
  get nickname() {
    return data.nickname;
  },
  setNickname(name: string) {
    data.nickname = name.trim().slice(0, 12) || data.nickname;
    save();
  },
  isDiscovered(type: DiscoveryType, refId: string) {
    return data.discoveries.some((d) => same(d, { type, refId }));
  },
  /** 최근 발견 순 */
  discoveries(type?: DiscoveryType): Discovery[] {
    return data.discoveries.filter((d) => !type || d.type === type).sort((a, b) => b.at - a.at);
  },
  /** 기록(같은 항목이면 최초 발견 시각은 유지하고 정보만 갱신). 새로 발견했으면 true */
  record(d: Omit<Discovery, 'at'>): boolean {
    const existing = data.discoveries.find((x) => same(x, d));
    if (existing) Object.assign(existing, d);
    else data.discoveries.push({ ...d, at: Date.now() });
    save();
    return !existing;
  },
  remove(d: Pick<Discovery, 'type' | 'refId'>) {
    data.discoveries = data.discoveries.filter((x) => !same(x, d));
    save();
  },
  get notifications() {
    return data.notifications;
  },
  get unread() {
    return data.notifications.filter((n) => !n.read).length;
  },
  notify(n: Omit<NotificationItem, 'id' | 'at'>) {
    data.notifications.unshift({ ...n, id: `${Date.now()}`, at: Date.now() });
    data.notifications = data.notifications.slice(0, 50);
    save();
  },
  markAllRead() {
    if (!data.notifications.some((n) => !n.read)) return;
    data.notifications.forEach((n) => (n.read = true));
    save();
  },
};
