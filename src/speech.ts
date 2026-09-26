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
export function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  player.src = SILENCE;
  player.play().catch(() => (unlocked = false));
}

export type Gender = 'male' | 'female';

const MALE_HINT = /male(?!.*female)|남성|남자|injoon|hyunsu|gookmin|bongjin|minsu|jinho|x-koc|x-kod/i;
const FEMALE_HINT = /female|여성|여자|sunhi|yuna|heami|jimin|seohyeon|yujin|x-kob|x-ism/i;

/** 기기의 한국어 음성 중 성별이 맞는 것을 고른다 (없으면 기본 한국어 음성) */
function deviceVoice(gender: Gender): SpeechSynthesisVoice | undefined {
  const ko = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').toLowerCase().startsWith('ko'));
  const want = gender === 'male' ? MALE_HINT : FEMALE_HINT;
  return ko.find((v) => want.test(`${v.name} ${v.voiceURI}`)) ?? ko[0];
}
if (canSpeak()) speechSynthesis.getVoices(); // 일부 브라우저는 목록을 늦게 채운다

export interface SpeakOptions {
  gender?: Gender;
  /** 서버 음성에 쓸 인물 id */
  figureId?: string;
  /** 읽은 비율(0~1) — 자막을 음성 진행에 맞추는 데 사용 */
  onProgress?: (fraction: number) => void;
  onEnd?: () => void;
}

let stopCurrent: (() => void) | undefined;

export function stopSpeaking() {
  stopCurrent?.();
  stopCurrent = undefined;
  if (canSpeak()) speechSynthesis.cancel();
}

/** 서버 음성으로 재생. 실패하면 false */
async function speakServer(text: string, o: SpeakOptions): Promise<boolean> {
  if (serverVoiceOff || !o.figureId) return false;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ figureId: o.figureId, text }),
    });
  } catch {
    return false;
  }
  if (res.status === 503) serverVoiceOff = true;
  if (!res.ok) return false;
  const url = URL.createObjectURL(await res.blob());
  return new Promise<boolean>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
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
    player
      .play()
      .then(() => resolve(true))
      .catch(() => {
        // 자동 재생이 막혔으면 기기 음성으로 대체
        done = true;
        URL.revokeObjectURL(url);
        resolve(false);
      });
  });
}

/** 기기 음성 — 음높이는 건드리지 않는다 (억지로 낮추면 부자연스러움) */
function speakDevice(text: string, o: SpeakOptions) {
  if (!canSpeak()) return o.onEnd?.();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  u.rate = 0.95;
  const v = deviceVoice(o.gender ?? 'male');
  if (v) u.voice = v;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    o.onProgress?.(1);
    o.onEnd?.();
  };
  u.onboundary = (e) => o.onProgress?.(e.charIndex / text.length);
  u.onend = end;
  u.onerror = end;
  speechSynthesis.speak(u);
}

export async function speak(text: string, opts: SpeakOptions | (() => void) = {}) {
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
