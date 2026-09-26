import { openHeritage } from '../heritageSheet.ts';
import type { Screen } from '../router.ts';
import { store } from '../store.ts';
import { titleTopbar } from '../ui/chrome.ts';
import { esc } from '../ui/dom.ts';

const fmt = new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** 위치 알림 목록 (앱이 열려 있는 동안 유적지 도착 시 기록) */
export const notificationsScreen: Screen = {
  tab: 'home',
  mount(root) {
    const items = store.notifications;
    root.innerHTML = `<div class="scr">
      ${titleTopbar('알림')}
      <div class="list noti">${
        items.length
          ? items
              .map(
                (n) => `<button class="noti-item ${n.read ? '' : 'new'}" data-site="${esc(n.siteId)}">
                  <b>${esc(n.title)}</b><small>${esc(n.body)}</small><time>${fmt.format(n.at)}</time></button>`,
              )
              .join('')
          : '<div class="empty"><b>받은 알림이 없습니다.</b><br />유적지에 도착하면 알림이 도착합니다.<br /><small>웹앱 특성상 앱이 열려 있을 때만 위치를 확인합니다.</small></div>'
      }</div>
    </div>`;
    root.querySelectorAll<HTMLElement>('[data-site]').forEach((b) => b.addEventListener('click', () => openHeritage(b.dataset.site!)));
    store.markAllRead();
  },
};
