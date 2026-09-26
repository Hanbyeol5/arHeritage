import { app } from '../app.ts';
import { reply, session, type Line } from '../conversation.ts';
import { openFigureSheet } from '../figureSheet.ts';
import { go, type Screen } from '../router.ts';
import { titleTopbar } from '../ui/chrome.ts';
import { esc } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { medal } from '../ui/medal.ts';

const bubble = (l: Line) => `<div class="bub ${l.mine ? 'me' : 'them'} ${l.system ? 'sys' : ''}">${esc(l.text)}</div>`;

/** Q&A 탭 — 대화할 인물 목록 */
export const qaScreen: Screen = {
  tab: 'qa',
  mount(root) {
    const list = app.nearbyFigures();
    root.innerHTML = `<div class="scr">
      ${titleTopbar('역사 인물 Q&A')}
      <p class="qa-lead">대화할 인물을 고르세요. 가까운 인물부터 보여 드립니다.</p>
      <div class="list">${list
        .map(
          (n) => `<a class="row-item" href="#/chat/${encodeURIComponent(n.figure.id)}">
            ${medal(n.figure, { size: 42 })}
            <div class="ri"><b>${esc(n.figure.name)}</b><small>${esc(n.figure.title)} · ${esc(n.site.name)}</small></div>
            <span class="rdist">${esc(app.distanceLabel(n.distance))}</span></a>`,
        )
        .join('')}</div>
    </div>`;
  },
};

/** 5. 챗봇(텍스트) 대화 */
export const chatScreen: Screen = {
  tab: 'qa',
  fullscreen: true,
  mount(root, [id]) {
    const f = app.figureById.get(id);
    if (!f) return go('#/qa');
    const lines = session(f);

    root.innerHTML = `<div class="scr chat">
      <div class="chat-head">
        <a class="icbtn ghost" href="#/home" aria-label="홈" style="width:30px">${icons.home}</a>
        <button class="head-med" aria-label="인물 정보">${medal(f, { size: 38 })}</button>
        <div class="ci"><b>${esc(f.name)}</b><small><i>● </i>대화 중 · ${esc(f.title)}</small></div>
      </div>
      <div class="chat-body"><div class="day">오늘</div>${lines.map(bubble).join('')}</div>
      <form class="chat-input">
        <div class="switch"><a href="#/voice/${encodeURIComponent(f.id)}">${icons.switch} 초상화 대화로 전환</a></div>
        <div class="row">
          <input class="box" name="msg" autocomplete="off" placeholder="메시지를 입력하세요…" />
          <button class="send" aria-label="보내기">${icons.send}</button>
        </div>
      </form>
    </div>`;

    const body = root.querySelector<HTMLElement>('.chat-body')!;
    const input = root.querySelector<HTMLInputElement>('.box')!;
    const scroll = () => (body.scrollTop = body.scrollHeight);
    const push = (l: Line) => {
      lines.push(l);
      body.insertAdjacentHTML('beforeend', bubble(l));
      scroll();
    };
    scroll();

    root.querySelector('.head-med')!.addEventListener('click', () => openFigureSheet(f.id));
    root.querySelector('form')!.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      push({ mine: true, text });
      body.insertAdjacentHTML('beforeend', '<div class="bub them typing"><i></i><i></i><i></i></div>');
      scroll();
      const r = await reply(f, lines);
      body.querySelector('.typing')?.remove();
      push(r);
    });
  },
};
