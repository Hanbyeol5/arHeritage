import { josa } from '../ui/josa.ts';
import { app } from '../app.ts';
import { reply, session, type Line } from '../conversation.ts';
import { openFigureSheet } from '../figureSheet.ts';
import { openHeritage } from '../heritageSheet.ts';
import { angleDiff, bearing } from '../geo.ts';
import { guideFor } from '../guide.ts';
import { go, type Screen } from '../router.ts';
import { canListen, canSpeak, listen, speak, stopSpeaking, unlockAudio } from '../speech.ts';
import { store } from '../store.ts';
import type { Figure } from '../types.ts';
import { asset, esc } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { immersive } from '../ui/immersive.ts';

type State = 'idle' | 'listening' | 'thinking' | 'speaking';

const STATUS: Record<State, string> = {
  idle: '마이크를 눌러 말을 걸어 보세요',
  listening: '듣고 있어요…',
  thinking: '생각하는 중…',
  speaking: '말하는 중…',
};

/** 한국어 음성 대략적인 속도(글자/초) — 읽는 위치를 알려 주지 않는 기기 음성용 */
const CHARS_PER_SEC = 7;
/** 세로 모드 후면 카메라 대략적인 시야각 */
const H_FOV = 55;
const V_FOV = 70;

/** 배경을 걷어낸 인물 (초상 컷아웃이 아직 없으면 한자 이름 인장) */
function cutout(f: Figure): string {
  if (f.cutout) return `<img src="${esc(asset(f.cutout))}" alt="${esc(f.name)}" draggable="false" />`;
  if (f.fullBody) {
    const id = { king: 'bodyKing', lady: 'bodyLady', general: 'bodyGeneral', scholar: 'bodyGuide', guide: 'bodyGuide' }[f.fullBody];
    return `<svg class="tk-body" viewBox="0 0 200 390" aria-label="${esc(f.name)}"><use href="#${id}"/></svg>`;
  }
  return `<div class="tk-seal"><span>${esc(f.hanja || f.name)}</span><small>${esc(f.name)}</small></div>`;
}

/**
 * 역사 인물과 마주 보는 대화 — 후면 카메라 화면 위에 인물 컷아웃을 AR 로 세우고,
 * 대화는 라이브 방송 자막처럼 흘러가며 음성으로도 들린다.
 */
export const talkScreen: Screen = {
  tab: 'qa',
  fullscreen: true,
  mount(root, [id], query) {
    // 역사 인물이 없는 유적지는 해설사가 안내한다 (#/talk/guide?site=...)
    const f = id === 'guide' ? guideFor(query.get('site')) : app.figureById.get(id);
    if (!f) return go('#/qa');
    const lines = session(f);
    const site = app.nearestSiteOf(f).site;

    root.innerHTML = `<div class="scr talk" data-state="idle">
      <video class="tk-cam" playsinline muted autoplay></video>
      <div class="tk-world">
        <div class="tk-figure${f.cutout ? '' : f.fullBody ? ' full' : ''}"><div class="tk-face">${cutout(f)}</div><div class="tk-shadow"></div></div>
      </div>
      <div class="tk-find" hidden></div>
      <div class="tk-top">
        <a class="icbtn" href="#/home" aria-label="홈">${icons.home.replace('currentColor', '#fff')}</a>
        <button class="tk-who" aria-label="인물 정보">
          <span class="live">● LIVE</span><b>${esc(f.name)}</b><small>${esc(f.title)}</small>${
            store.chatMode === 'basic' ? '' : `<span class="mode">${store.chatMode === 'rag' ? 'RAG' : '외부 RAG'}</span>`
          }
        </button>
        <button class="icbtn tk-mute" aria-label="음성 끄기" aria-pressed="false">${icons.speaker}</button>
      </div>
      <div class="tk-feed" aria-live="polite"></div>
      <div class="tk-bottom">
        <div class="tk-status"></div>
        <form class="tk-type" hidden>
          <input name="msg" autocomplete="off" placeholder="말 대신 글로 여쭈어 보세요…" />
          <button class="send" aria-label="보내기">${icons.send}</button>
        </form>
        <div class="tk-controls">
          <button class="tk-side tk-kbd" aria-label="글자로 입력">⌨</button>
          <button class="tk-mic" aria-label="대화 시작">${icons.mic}</button>
          <button class="tk-side tk-call" aria-label="인물을 정면으로 부르기">⟲</button>
        </div>
      </div>
    </div>`;

    const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const scr = $('.talk');
    const feed = $('.tk-feed');
    const world = $('.tk-world');
    const figureEl = $('.tk-figure');
    let state: State = 'idle';
    let conversing = false; // 마이크를 켜 둔 연속 대화 모드
    let muted = false;
    let alive = true;
    let stopListening: (() => void) | undefined;
    let camStream: MediaStream | undefined;
    let revealTimer: number | undefined;

    // ---------- AR: 후면 카메라 + 인물 배치 ----------
    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        camStream = s;
        const v = $<HTMLVideoElement>('.tk-cam');
        v.srcObject = s;
        v.play().catch(() => {});
        scr.classList.add('has-cam');
      })
      .catch(() => scr.classList.remove('has-cam'));

    const sensor = app.sensor;
    sensor.start();
    /** 인물이 서 있는 방위 — 처음 센서 값을 받은 방향(정면)에 세운다 */
    let anchor: number | undefined;
    const callToFront = () => (anchor = sensor.value.heading);

    let raf = 0;
    const frame = () => {
      if (!alive) return;
      const w = world.clientWidth;
      const h = world.clientHeight;
      const { heading, pitch } = sensor.value;
      if (anchor === undefined && sensor.hasSensor) callToFront();
      const delta = anchor === undefined ? 0 : angleDiff(anchor, heading);
      const x = delta * (w / H_FOV);
      const y = pitch * (h / V_FOV);
      figureEl.style.transform = `translate(calc(-50% + ${x.toFixed(1)}px), ${y.toFixed(1)}px)`;
      // 전신 인물은 유적지가 있는 쪽을 바라보고 선다 (그림은 왼쪽을 보고 있음)
      if (f.fullBody && app.pos) {
        const siteDelta = angleDiff(bearing(app.pos, site), heading);
        figureEl.classList.toggle('face-right', siteDelta > delta);
      }
      // 시야 밖이면 방향 안내
      const out = Math.abs(delta) > H_FOV / 2 + 12;
      const find = $('.tk-find');
      find.hidden = !out;
      if (out) {
        find.className = `tk-find ${delta < 0 ? 'left' : 'right'}`;
        find.textContent = delta < 0 ? `◀ ${josa(f.name, '은/는')} 이쪽에` : `${josa(f.name, '은/는')} 이쪽에 ▶`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    // 센서가 없는 데스크톱: 드래그로 둘러보기
    let dragX: number | undefined;
    world.addEventListener('pointerdown', (e) => {
      if (!sensor.hasSensor) dragX = e.clientX;
    });
    world.addEventListener('pointermove', (e) => {
      if (dragX === undefined) return;
      sensor.rotateBy(-(e.clientX - dragX) / 6);
      anchor ??= 0;
      dragX = e.clientX;
    });
    const endDrag = () => (dragX = undefined);
    world.addEventListener('pointerup', endDrag);
    world.addEventListener('pointerleave', endDrag);

    // ---------- 대화 ----------
    const showStatus = (msg: string, cls: string) => {
      const el = $('.tk-status');
      el.textContent = msg;
      el.dataset.note = cls;
    };
    const setState = (s: State) => {
      delete $('.tk-status').dataset.note;
      state = s;
      scr.dataset.state = s;
      $('.tk-status').textContent = conversing && s === 'idle' ? '잠시 후 다시 듣습니다…' : STATUS[s];
      $('.tk-mic').setAttribute('aria-label', conversing ? '대화 멈추기' : '대화 시작');
      scr.classList.toggle('conversing', conversing);
    };

    /** 자막 한 줄 추가 (라이브 방송처럼 아래에 쌓이고 위로 밀려 사라짐) */
    /** RAG 답변의 근거 자료 (누르면 유적 카드·인물 소개) */
    const addSources = (el: HTMLElement, l: Line) => {
      if (!l.sources?.length || el.querySelector('.tk-src')) return;
      const box = document.createElement('div');
      box.className = 'tk-src';
      box.innerHTML = `📚 근거 ${l.sources
        // "u:" 는 RAG 자료 편집기로 추가한 자료(연결된 유적 없음) — 이름만 표시
        .map((s) => (s.id?.startsWith('u:') ? `<span title="${esc(s.quote ?? '')}">${esc(s.name)}</span>` : s.id ? `<button data-src="${esc(s.id)}" title="${esc(s.quote ?? '')}">${esc(s.name)}</button>` : `<q>${esc(s.quote ?? s.name)}</q>`))
        .join('')}`;
      box.querySelectorAll<HTMLElement>('[data-src]').forEach((b) =>
        b.addEventListener('click', () => {
          const id = b.dataset.src!;
          if (id.startsWith('fig:')) openFigureSheet(id.slice(4));
          else openHeritage(id);
        }),
      );
      el.appendChild(box);
      feed.scrollTop = feed.scrollHeight;
    };

    const addLine = (l: Line, text = l.text): HTMLElement => {
      const el = document.createElement('div');
      el.className = `tk-line ${l.mine ? 'me' : 'them'} ${l.system ? 'sys' : ''}`;
      el.innerHTML = `<b>${l.system ? '안내' : l.mine ? '나' : esc(f.name)}</b><span></span>`;
      el.querySelector('span')!.textContent = text;
      if (text === l.text) addSources(el, l);
      feed.appendChild(el);
      while (feed.children.length > 30) feed.firstElementChild!.remove();
      feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
      return el;
    };

    /** 인물의 말: 자막을 읽는 속도에 맞춰 한 글자씩 보여 주며 음성 출력 */
    const say = (l: Line) =>
      new Promise<void>((resolve) => {
        const el = addLine(l, '');
        const span = el.querySelector('span')!;
        let shown = 0;
        const show = (n: number) => {
          shown = Math.max(shown, Math.min(l.text.length, n));
          span.textContent = l.text.slice(0, shown);
          feed.scrollTop = feed.scrollHeight;
        };
        const finish = () => {
          clearInterval(revealTimer);
          show(l.text.length);
          addSources(el, l);
          resolve();
        };
        if (l.system || muted || !canSpeak()) {
          revealTimer = window.setInterval(() => (shown >= l.text.length ? finish() : show(shown + 2)), 40);
          return;
        }
        setState('speaking');
        // 음성 진행률에 맞춰 자막을 드러낸다. 진행률이 오지 않는 기기 음성은 읽기 속도로 추정
        let progressed = false;
        const started = performance.now();
        revealTimer = window.setInterval(() => {
          const t = performance.now() - started;
          if (!progressed && t > 1500) show(((t - 1500) / 1000) * CHARS_PER_SEC);
        }, 100);
        speak(l.text, {
          figureId: f.id,
          gender: f.style === 'lady' ? 'female' : 'male',
          onProgress: (p) => {
            progressed = true;
            show(Math.ceil(p * l.text.length));
          },
          onEnd: finish,
          onBlocked: () => showStatus('🔊 화면을 터치하면 목소리가 나와요', 'blocked'),
          onUnblocked: () => setState('speaking'),
          onSilent: (reason) => showStatus(reason, 'silent'),
        });
      });

    // 처음 만났으면 인사를 음성으로, 이어서 온 대화면 지난 자막을 그대로 보여 준다
    const fresh = lines.length === 1;
    if (!fresh) lines.forEach((l) => addLine(l));

    const ask = async (text: string) => {
      lines.push({ mine: true, text });
      setState('thinking');
      const r = await reply(f, lines);
      if (!alive) return;
      lines.push(r);
      await say(r);
      if (!alive) return;
      setState('idle');
      if (conversing) setTimeout(() => alive && conversing && state === 'idle' && hear(), 600);
    };

    /** 내 음성 → 텍스트 (말하는 동안 자막으로 실시간 표시) */
    const hear = async () => {
      if (!canListen()) {
        conversing = false;
        addLine({ mine: false, system: true, text: '이 브라우저는 음성 인식을 지원하지 않습니다. ⌨ 버튼으로 글자를 입력해 주세요.' });
        $('.tk-type').hidden = false;
        return setState('idle');
      }
      stopSpeaking();
      setState('listening');
      const draft = addLine({ mine: true, text: '' }, '…');
      draft.classList.add('draft');
      try {
        const rec = listen((t) => {
          draft.querySelector('span')!.textContent = t;
          feed.scrollTop = feed.scrollHeight;
        });
        stopListening = rec.abort;
        const text = await rec.done;
        stopListening = undefined;
        if (!alive) return;
        if (!text) {
          draft.remove();
          conversing = false; // 말이 없으면 연속 대화를 멈춘다
          return setState('idle');
        }
        draft.classList.remove('draft');
        draft.querySelector('span')!.textContent = text;
        await ask(text);
      } catch (e) {
        draft.remove();
        conversing = false;
        addLine({ mine: false, system: true, text: (e as Error).message });
        setState('idle');
      }
    };

    // 서버 음성을 나중에 코드로 재생할 수 있도록 첫 탭에서 오디오를 풀어 둔다 (iOS)
    root.addEventListener('pointerdown', unlockAudio, { once: true });

    $('.tk-mic').addEventListener('click', () => {
      sensor.requestPermission(); // iOS: 제스처 안에서 방향 센서 권한
      if (conversing || state === 'listening') {
        conversing = false;
        stopListening?.();
        stopSpeaking();
        return setState('idle');
      }
      conversing = true;
      if (state === 'idle' || state === 'speaking') hear();
    });

    $('.tk-kbd').addEventListener('click', () => {
      const form = $('.tk-type');
      form.hidden = !form.hidden;
      if (!form.hidden) form.querySelector('input')!.focus();
    });
    $<HTMLFormElement>('.tk-type').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $<HTMLInputElement>('.tk-type input');
      const text = input.value.trim();
      if (!text || state === 'thinking') return;
      input.value = '';
      stopSpeaking();
      addLine({ mine: true, text });
      ask(text);
    });

    $('.tk-mute').addEventListener('click', (e) => {
      muted = !muted;
      if (muted) stopSpeaking();
      const b = e.currentTarget as HTMLElement;
      b.setAttribute('aria-pressed', String(muted));
      b.classList.toggle('off', muted);
    });
    $('.tk-call').addEventListener('click', () => {
      sensor.requestPermission();
      callToFront();
    });
    // 해설사는 안내하는 유적지 정보를, 역사 인물은 인물 정보를 연다
    $('.tk-who').addEventListener('click', () => (f.role === 'guide' ? openHeritage(site.id) : openFigureSheet(f.id)));

    setState('idle');
    if (fresh) say(lines[0]).then(() => alive && setState('idle'));
    const offImmersive = immersive(scr);

    return () => {
      offImmersive();
      alive = false;
      conversing = false;
      cancelAnimationFrame(raf);
      clearInterval(revealTimer);
      stopListening?.();
      stopSpeaking();
      camStream?.getTracks().forEach((t) => t.stop());
    };
  },
};
