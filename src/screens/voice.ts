import { app } from '../app.ts';
import { reply, session, type Line } from '../conversation.ts';
import { go, type Screen } from '../router.ts';
import { canListen, listen, speak, stopSpeaking } from '../speech.ts';
import { esc } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { medal } from '../ui/medal.ts';

const lbub = (l: Line) => `<div class="lbub ${l.mine ? 'me' : 'them'} ${l.system ? 'sys' : ''}">${esc(l.text)}</div>`;

/** 6. 초상화 음성 대화 — STT 입력 + TTS 응답 + 실시간 자막 */
export const voiceScreen: Screen = {
  tab: 'qa',
  fullscreen: true,
  mount(root, [id]) {
    const f = app.figureById.get(id);
    if (!f) return go('#/qa');
    const lines = session(f);

    root.innerHTML = `<div class="scr voice-scr">
      <div class="topbar" style="padding-bottom:0">
        <a class="icbtn ghost" href="#/home" aria-label="홈">${icons.home}</a>
        <a class="icbtn ghost" href="#/chat/${encodeURIComponent(f.id)}" aria-label="텍스트 대화로">${icons.chevDown}</a>
      </div>
      <div class="voice">
        <div class="pmed"><span class="ring"></span><span class="ring r2"></span>${medal(f, { size: 158, seal: true })}</div>
        <div class="vname">${esc(f.name)}</div>
        <div class="speaking"><i></i> <span class="st">대기 중</span></div>
        <div class="live"><div class="lbl">실시간 대화</div>${lines.slice(-4).map(lbub).join('')}</div>
        <div class="wave">
          <div class="bars">${'<span></span>'.repeat(5)}</div>
          <button class="mic" aria-label="말하기">${icons.mic}</button>
          <div class="bars">${'<span></span>'.repeat(5)}</div>
        </div>
      </div>
    </div>`;

    const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const scr = $('.voice-scr');
    const live = $('.live');
    const setState = (s: 'idle' | 'listening' | 'thinking' | 'speaking') => {
      scr.dataset.state = s;
      $('.st').textContent = { idle: '대기 중', listening: '듣는 중…', thinking: '생각하는 중…', speaking: '말하는 중…' }[s];
    };
    setState('idle');

    const add = (l: Line) => {
      live.insertAdjacentHTML('beforeend', lbub(l));
      live.scrollTop = live.scrollHeight;
    };

    let busy = false;
    $('.mic').addEventListener('click', async () => {
      if (busy) return;
      if (!canListen()) {
        add({ mine: false, system: true, text: '이 브라우저는 음성 인식을 지원하지 않습니다. Chrome 또는 Safari 에서 이용해 주세요.' });
        return;
      }
      busy = true;
      stopSpeaking();
      setState('listening');
      const draft = document.createElement('div');
      draft.className = 'lbub me draft';
      live.appendChild(draft);
      try {
        const { done } = listen((t) => {
          draft.textContent = t;
          live.scrollTop = live.scrollHeight;
        });
        const text = await done;
        draft.remove();
        if (!text) return setState('idle');
        const mine = { mine: true, text };
        lines.push(mine);
        add(mine);
        setState('thinking');
        const r = await reply(f, lines);
        lines.push(r);
        add(r);
        setState('speaking');
        speak(r.text, () => setState('idle'));
      } catch (e) {
        draft.remove();
        add({ mine: false, system: true, text: (e as Error).message });
        setState('idle');
      } finally {
        busy = false;
      }
    });

    live.scrollTop = live.scrollHeight;
    return () => stopSpeaking();
  },
};
