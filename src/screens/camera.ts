import { app } from '../app.ts';
import type { Screen } from '../router.ts';
import type { Figure } from '../types.ts';
import { speak, stopSpeaking } from '../speech.ts';
import { esc } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { medal } from '../ui/medal.ts';

/** 3. 유물 인식 카메라 — 촬영 → 인식 → 관련 인물 해설 (인식은 4단계에서 Claude Vision 연결) */
export const cameraScreen: Screen = {
  tab: 'camera',
  fullscreen: true,
  mount(root) {
    const figs = app.nearbyFigures().slice(0, 3);
    let sel: Figure | undefined = figs[0]?.figure;

    root.innerHTML = `<div class="scr cam relic">
      <video playsinline muted autoplay></video>
      <div class="ar-top">
        <a class="icbtn" href="#/home" aria-label="홈">${icons.home.replace('currentColor', '#fff')}</a>
        <button class="icbtn frame" aria-label="전체 화면">${icons.frame}</button>
      </div>
      <div class="figs">${figs
        .map(
          (n, i) =>
            `<button class="fchip ${i === 0 ? 'sel' : ''}" data-id="${esc(n.figure.id)}">${medal(n.figure, { size: 46 })}<span>${esc(n.figure.name)}</span></button>`,
        )
        .join('')}</div>
      <div class="reticle"><span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br brr"></span></div>
      <div class="tag" hidden></div>
      <div class="speech" hidden></div>
      <div class="cam-notice" hidden></div>
      <button class="shutter" aria-label="촬영"><i></i></button>
    </div>`;

    const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const video = $<HTMLVideoElement>('video');
    let stream: MediaStream | undefined;
    let alive = true;

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        video.srcObject = s;
        video.play().catch(() => {});
      })
      .catch(() => {
        $('.cam-notice').hidden = false;
        $('.cam-notice').textContent = '카메라를 사용할 수 없습니다. 브라우저 권한을 확인해 주세요.';
      });

    const showSpeech = (text: string) => {
      if (!sel) return;
      const sp = $('.speech');
      sp.hidden = false;
      sp.innerHTML = `<div class="sh">${medal(sel, { size: 30 })}<b>${esc(sel.name)}</b>
        <button class="spk" aria-label="음성으로 듣기">${icons.speaker}</button></div><p>${esc(text)}</p>`;
      sp.querySelector('.spk')!.addEventListener('click', () => speak(text));
    };

    root.querySelectorAll<HTMLElement>('.fchip').forEach((b) =>
      b.addEventListener('click', () => {
        root.querySelectorAll('.fchip').forEach((x) => x.classList.toggle('sel', x === b));
        sel = app.figureById.get(b.dataset.id!);
        stopSpeaking();
        if (!$('.speech').hidden) showSpeech(placeholder());
      }),
    );

    const placeholder = () =>
      `유물 인식 기능은 준비 중입니다. 연결되면 ${sel?.name ?? '인물'}이(가) 촬영한 유물을 해설해 드립니다.`;

    $('.shutter').addEventListener('click', () => {
      $('.tag').hidden = false;
      $('.tag').innerHTML = '<b>유물 인식</b> · 준비 중';
      showSpeech(placeholder());
    });
    $('.frame').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    });

    return () => {
      alive = false;
      stopSpeaking();
      stream?.getTracks().forEach((t) => t.stop());
    };
  },
};
