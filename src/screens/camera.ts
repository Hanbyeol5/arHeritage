import { loadDetail } from '../data.ts';
import type { Screen } from '../router.ts';
import { speak, stopSpeaking } from '../speech.ts';
import { store, type DiscoveryType } from '../store.ts';
import type { HeritageDetail } from '../types.ts';
import { esc } from '../ui/dom.ts';
import { icons } from '../ui/icons.ts';
import { monoMedal } from '../ui/medal.ts';
import { captureFrame, recognizePhoto, type PhotoRecognition } from '../vision.ts';

type Phase = 'preview' | 'recognizing' | 'result';

const SITE_KEYWORDS = ['사적', '명승', '유적', '성곽', '성', '궁', '문', '전', '탑', '사지', '능', '묘', '서원', '향교', '건조물', '요지', '고분', '누각', '정자'];

/** AI 카테고리 우선, 없으면 키워드로 유적지/유물 분류 (historydam CameraViewModel.typeOf) */
function typeOf(category: string, name: string, kind: string): DiscoveryType {
  if (category === 'figure' || category === 'site' || category === 'relic') return category;
  return SITE_KEYWORDS.some((k) => `${name} ${kind}`.includes(k)) ? 'site' : 'relic';
}

/** 3. 유물·건물 인식 카메라 — 촬영 → AI 판별(+국가유산청 보강) → 후보로 보정 */
export const cameraScreen: Screen = {
  tab: 'camera',
  fullscreen: true,
  mount(root) {
    root.innerHTML = `<div class="scr cam relic">
      <video playsinline muted autoplay></video>
      <div class="ar-top">
        <a class="icbtn" href="#/home" aria-label="홈">${icons.home.replace('currentColor', '#fff')}</a>
        <button class="icbtn frame" aria-label="전체 화면">${icons.frame}</button>
      </div>
      <div class="viewfinder">
        <div class="reticle"><span class="br tl"></span><span class="br tr"></span><span class="br bl"></span><span class="br brr"></span></div>
        <div class="recog" hidden><span class="spinner"></span>주변 국가유산을 찾는 중…</div>
      </div>
      <div class="cam-bottom"></div>
    </div>`;

    const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
    const video = $<HTMLVideoElement>('video');
    const bottom = $('.cam-bottom');
    let stream: MediaStream | undefined;
    let alive = true;
    let error: string | undefined;
    let result: PhotoRecognition | undefined;
    let selectedId: string | undefined;
    let official: HeritageDetail | undefined;
    let loadingDetail = false;

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      .then((s) => {
        if (!alive) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        video.srcObject = s;
        video.play().catch(() => {});
      })
      .catch(() => {
        error = '카메라 권한을 허용해 주세요.';
        render('preview');
      });

    const displayName = () => official?.name ?? result?.identification.name ?? '국가유산';
    const description = () => official?.description?.trim() || result?.identification.description;

    const render = (phase: Phase) => {
      $('.viewfinder').hidden = phase === 'result';
      $('.recog').hidden = phase !== 'recognizing';
      const err = error && phase !== 'result' ? `<div class="cam-error">${esc(error)}</div>` : '';

      if (phase === 'preview') {
        bottom.innerHTML = `${err}<div class="cam-hint">유적·문화재를 비추고 촬영하면<br />주변 국가유산을 찾아드려요</div>
          <button class="shutter" aria-label="촬영"><i></i></button>`;
        bottom.querySelector('.shutter')!.addEventListener('click', shoot);
        return;
      }
      if (phase === 'recognizing') {
        bottom.innerHTML = err;
        return;
      }

      const r = result!;
      const id = r.identification;
      const source = official ? '국가유산청' : 'AI 판별';
      const conf = id.confidence > 0 ? ` · ${id.confidence}%` : '';
      const sub = [id.kind, official?.era || id.era, official?.address].filter(Boolean).join(' · ');
      const showChips = r.candidates.length && (id.category === 'site' || r.fallback);
      const desc = description();
      bottom.innerHTML = `
        <div class="cam-tag">${esc(r.fallback ? '위치 기반' : source)} · ${esc(displayName())}${esc(conf)}</div>
        ${
          showChips
            ? `<div class="cand-chips">${r.candidates
                .map((c) => `<button class="cand ${c.id === selectedId ? 'on' : ''}" data-id="${esc(c.id)}">${esc(c.name)}</button>`)
                .join('')}</div>`
            : ''
        }
        <div class="result-card">
          ${official?.image ? `<img class="rc-img" src="${esc(official.image)}" alt="${esc(displayName())}" referrerpolicy="no-referrer" />` : ''}
          <div class="rc-head">
            ${monoMedal(displayName(), 34)}
            <div class="rc-title"><b>${esc(displayName())}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
            <button class="spk" aria-label="음성으로 듣기">${icons.speaker}</button>
          </div>
          <div class="rc-desc">${
            loadingDetail
              ? '<span class="spinner dark"></span>공식 정보를 불러오는 중…'
              : desc
                ? esc(desc)
                : '<span class="muted">설명 정보가 없습니다.</span>'
          }</div>
          <button class="retake">↻ 다시 촬영</button>
        </div>`;
      bottom.querySelectorAll<HTMLElement>('.cand').forEach((b) => b.addEventListener('click', () => select(b.dataset.id!)));
      bottom.querySelector('.spk')!.addEventListener('click', () => {
        const d = description();
        if (d) speak(d);
      });
      bottom.querySelector('.retake')!.addEventListener('click', () => {
        stopSpeaking();
        result = official = selectedId = undefined;
        error = undefined;
        render('preview');
      });
    };

    const shoot = async () => {
      error = undefined;
      let photo: Blob;
      try {
        photo = await captureFrame(video);
      } catch (e) {
        error = (e as Error).message;
        return render('preview');
      }
      render('recognizing');
      try {
        result = await recognizePhoto(photo);
        official = result.official;
        selectedId = result.identification.matchedId ?? undefined;
        if (!alive) return;
        render('result');
        // 실제 문화재로 확인된 경우에만 역사의 전당(도감)에 기록
        const id = result.identification;
        if (id.isHeritage) {
          const name = official?.name ?? id.name;
          const kind = official?.designation ?? id.kind;
          store.record({
            type: typeOf(id.category, name, kind),
            refId: official?.id ?? `vision:${name}`,
            name,
            subtitle: [kind, official?.era ?? id.era].filter(Boolean).join(' · '),
            description: official?.description?.trim() || id.description,
            imageUrl: official?.image,
          });
        }
      } catch (e) {
        error = (e as Error).message || '인식에 실패했습니다.';
        if (alive) render('preview');
      }
    };

    /** 주변 후보를 눌러 특정 국가유산으로 보정 → 상세 조회 */
    const select = async (id: string) => {
      stopSpeaking();
      selectedId = id;
      loadingDetail = true;
      render('result');
      try {
        const d = await loadDetail(id);
        if (selectedId === id) official = d;
      } catch {
        error = '상세를 불러오지 못했습니다.';
      }
      loadingDetail = false;
      if (alive && selectedId === id) render('result');
    };

    $('.frame').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen?.().catch(() => {});
    });

    render('preview');
    return () => {
      alive = false;
      stopSpeaking();
      stream?.getTracks().forEach((t) => t.stop());
    };
  },
};
