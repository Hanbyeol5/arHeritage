import { fixJosa } from './ui/josa.ts';
/**
 * 음성 출력·입력
 * - 인물 목소리: 서버(Worker /tts, Azure 신경망 음성)를 우선 쓰고, 안 되면 기기 음성(Web Speech)으로 대체
 * - 내 목소리: SpeechRecognition(STT)
 */

export const canSpeak = () => 'speechSynthesis' in window;

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '');
/** 서버 음성이 설정되지 않았으면(503) 이번 방문 동안은 다시 묻지 않는다 */
let serverVoiceOff = !API_BASE;

// iOS 등은 사용자 탭 안에서 한 번 재생해 둔 오디오 요소만 나중에 코드로 재생할 수 있다
const player = new Audio();
player.preload = 'auto';
/** 0.05초 무음 WAV (8kHz, 8bit) */
const SILENCE = (() => {
  const n = 400;
  const b = new Uint8Array(44 + n);
  const v = new DataView(b.buffer);
  const str = (o: number, t: string) => [...t].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + n, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, n, true); b.fill(128, 44);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...b))}`;
})();
let unlocked = false;
let playing = false;
/** 사용자 탭 안에서 오디오 요소를 한 번 재생해 둔다 (iOS·일부 안드로이드는 이후에만 코드로 재생 가능) */
export function unlockAudio() {
  if (unlocked || playing) return;
  unlocked = true;
  player.src = SILENCE;
  player.play().catch(() => (unlocked = false));
}

export type Gender = 'male' | 'female';

const MALE_HINT = /male(?!.*female)|남성|남자|injoon|hyunsu|gookmin|bongjin|minsu|jinho|x-koc|x-kod/i;
const FEMALE_HINT = /female|여성|여자|sunhi|yuna|heami|jimin|seohyeon|yujin|x-kob|x-ism/i;

const koVoices = () =>
  canSpeak() ? speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('ko')) : [];

/** 기기의 한국어 음성 중 성별이 맞는 것을 고른다 (없으면 기본 한국어 음성) */
function deviceVoice(gender: Gender): SpeechSynthesisVoice | undefined {
  const ko = koVoices();
  const want = gender === 'male' ? MALE_HINT : FEMALE_HINT;
  return ko.find((v) => want.test(`${v.name} ${v.voiceURI}`)) ?? ko[0];
}
if (canSpeak()) speechSynthesis.getVoices(); // 일부 브라우저는 목록을 늦게 채운다

/** 기기에 한국어 음성이 아예 없는지 (목록을 아직 못 받았으면 모른다고 보고 false) */
const noKoreanVoice = () => canSpeak() && speechSynthesis.getVoices().length > 0 && koVoices().length === 0;

export interface SpeakOptions {
  gender?: Gender;
  /** 서버 음성에 쓸 인물 id */
  figureId?: string;
  /** 읽은 비율(0~1) — 자막을 음성 진행에 맞추는 데 사용 */
  onProgress?: (fraction: number) => void;
  onEnd?: () => void;
  /** 자동 재생이 막혀 화면을 한 번 터치해야 들을 수 있을 때 */
  onBlocked?: () => void;
  /** 막혔던 재생이 터치로 시작됐을 때 */
  onUnblocked?: () => void;
  /** 이 기기에서는 소리를 낼 수 없을 때 (자막만 표시) */
  onSilent?: (reason: string) => void;
}

let stopCurrent: (() => void) | undefined;

export function stopSpeaking() {
  stopCurrent?.();
  stopCurrent = undefined;
  if (canSpeak()) speechSynthesis.cancel();
}

async function fetchVoice(text: string, figureId: string): Promise<Response | undefined> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figureId, text }),
      });
      if (res.status === 503) serverVoiceOff = true;
      if (res.ok || res.status < 500) return res;
    } catch {
      /* 네트워크 오류 — 한 번 더 */
    }
  }
  return undefined;
}

/** 서버 음성으로 재생. 서버 음성을 쓸 수 없으면 false */
async function speakServer(text: string, o: SpeakOptions): Promise<boolean> {
  if (serverVoiceOff || !o.figureId) return false;
  const res = await fetchVoice(text, o.figureId);
  if (!res?.ok) return false;
  const url = URL.createObjectURL(await res.blob());
  let done = false;
  let retry: (() => void) | undefined;
  const finish = () => {
    if (done) return;
    done = true;
    playing = false;
    if (retry) document.removeEventListener('pointerdown', retry, true);
    player.ontimeupdate = player.onended = player.onerror = null;
    URL.revokeObjectURL(url);
    o.onProgress?.(1);
    o.onEnd?.();
  };
  stopCurrent = () => {
    player.pause();
    finish();
  };
  player.src = url;
  player.ontimeupdate = () => player.duration && o.onProgress?.(player.currentTime / player.duration);
  player.onended = finish;
  player.onerror = finish;
  playing = true;
  try {
    await player.play();
  } catch (err) {
    if ((err as DOMException).name !== 'NotAllowedError') {
      finish();
      return true;
    }
    // 자동 재생이 막힘 → 다음 터치(사용자 제스처) 때 이어서 재생
    o.onBlocked?.();
    retry = () => {
      retry = undefined;
      player.play().then(() => o.onUnblocked?.(), finish);
    };
    document.addEventListener('pointerdown', retry, { once: true, capture: true });
  }
  return true;
}

/** 크롬 안드로이드는 긴 문장을 중간에 끊는 경우가 있어 문장 단위로 나눠 읽는다 */
const sentences = (t: string) => t.match(/[^.!?。]+[.!?。]?s*/g)?.map((x) => x.trim()).filter(Boolean) ?? [t];

/** 기기 음성 — 음높이는 건드리지 않는다 (억지로 낮추면 부자연스러움) */
function speakDevice(text: string, o: SpeakOptions) {
  if (!canSpeak() || noKoreanVoice()) {
    o.onSilent?.(canSpeak() ? '이 기기에는 한국어 음성이 없어 자막으로만 보여 드려요' : '이 브라우저는 음성 출력을 지원하지 않아요');
    return o.onEnd?.();
  }
  const parts = sentences(text);
  const v = deviceVoice(o.gender ?? 'male');
  let ended = false;
  let before = 0;
  const end = () => {
    if (ended) return;
    ended = true;
    o.onProgress?.(1);
    o.onEnd?.();
  };
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.lang = 'ko-KR';
    u.rate = 0.95;
    if (v) u.voice = v;
    const offset = before;
    before += p.length + 1;
    u.onstart = () => o.onProgress?.(offset / text.length);
    u.onboundary = (e) => o.onProgress?.((offset + e.charIndex) / text.length);
    if (i === parts.length - 1) u.onend = end;
    u.onerror = (e) => {
      if (e.error === 'not-allowed') o.onSilent?.('화면을 터치한 뒤 다시 말을 걸어 주세요');
      end();
    };
    speechSynthesis.speak(u);
  });
  // 일부 크롬은 일시정지 상태로 멈춰 있는 경우가 있다
  if (speechSynthesis.paused) speechSynthesis.resume();
}

export async function speak(rawText: string, opts: SpeakOptions | (() => void) = {}) {
  const text = fixJosa(rawText);
  const o: SpeakOptions = typeof opts === 'function' ? { onEnd: opts } : opts;
  stopSpeaking();
  if (await speakServer(text, o)) return;
  speakDevice(text, o);
}

// ---------- 음성 인식 ----------
type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
};

const RecognitionCtor = (window as any).SpeechRecognition ?? (window as any).webkitSpeechRecognition;
export const canListen = () => !!RecognitionCtor;

/** 한 번 듣기. interim 으로 중간 결과, 최종 문장으로 resolve (말이 없으면 빈 문자열) */
export function listen(onInterim: (text: string) => void): { done: Promise<string>; stop: () => void; abort: () => void } {
  const rec: Recognition = new RecognitionCtor();
  rec.lang = 'ko-KR';
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = '';
  const done = new Promise<string>((resolve, reject) => {
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      onInterim(finalText + interim);
    };
    rec.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return; // onend 에서 빈 문자열로 종료
      reject(new Error(e.error === 'not-allowed' ? '마이크 권한이 거부되었습니다.' : '음성을 인식하지 못했습니다.'));
    };
    rec.onend = () => resolve(finalText.trim());
  });
  try {
    rec.start();
  } catch {
    /* 이미 시작된 경우 등 — onend 로 정리 */
  }
  return { done, stop: () => rec.stop(), abort: () => rec.abort() };
}
