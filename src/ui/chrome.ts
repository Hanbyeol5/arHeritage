import { store } from '../store.ts';
import { esc } from './dom.ts';
import { icons } from './icons.ts';

/** 홈 상단바: 談 로고 + 알림 */
export const brandTopbar = () => `
  <div class="topbar">
    <div class="brand"><div class="seal">談</div><b>역사담</b></div>
    <a class="icbtn bell" href="#/notifications" aria-label="알림">${store.unread ? '<span class="dot"></span>' : ''}${icons.bell}</a>
  </div>`;

/** 하위 화면 상단바: 홈 버튼 + 제목 (모든 화면에서 홈 복귀 동선 통일) */
export const titleTopbar = (title: string, right = '<span style="width:38px"></span>') => `
  <div class="topbar sub">
    <a class="icbtn" href="#/home" aria-label="홈">${icons.home}</a>
    <b class="tb-title">${esc(title)}</b>
    ${right}
  </div>`;
