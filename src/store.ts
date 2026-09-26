/**
 * 기기 내 저장소 (역사의 전당 도감, 위치 알림).
 * localStorage 는 사생활 보호 모드 등에서 실패할 수 있으므로 모든 접근을 try/catch 로 감싼다.
 */
export interface NotificationItem {
  id: string;
  at: number;
  title: string;
  body: string;
  siteId: string;
  read?: boolean;
}

interface StoreData {
  sites: Record<string, number>;
  figures: Record<string, number>;
  relics: Record<string, number>;
  notifications: NotificationItem[];
  nickname: string;
}

const KEY = 'yeoksadam:v1';
const empty = (): StoreData => ({ sites: {}, figures: {}, relics: {}, notifications: [], nickname: '나그네' });

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

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* 저장 불가 환경: 메모리에서만 유지 */
  }
  listeners.forEach((fn) => fn());
}

export const store = {
  onChange(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get nickname() {
    return data.nickname;
  },
  setNickname(name: string) {
    data.nickname = name.trim().slice(0, 12) || data.nickname;
    save();
  },
  isDiscovered(kind: 'sites' | 'figures' | 'relics', id: string) {
    return id in data[kind];
  },
  discovered(kind: 'sites' | 'figures' | 'relics') {
    return Object.entries(data[kind])
      .sort((a, b) => a[1] - b[1])
      .map(([id]) => id);
  },
  /** 새로 발견했으면 true */
  discover(kind: 'sites' | 'figures' | 'relics', id: string): boolean {
    if (id in data[kind]) return false;
    data[kind][id] = Date.now();
    save();
    return true;
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
