/** Web Speech API 래퍼 — TTS(speechSynthesis) + STT(SpeechRecognition) */

export const canSpeak = () => 'speechSynthesis' in window;

function koreanVoice(): SpeechSynthesisVoice | undefined {
  return speechSynthesis.getVoices().find((v) => v.lang.startsWith('ko'));
}

export interface SpeakOptions {
  pitch?: number;
  rate?: number;
  /** 읽고 있는 글자 위치 (브라우저·음성에 따라 오지 않을 수 있음) */
  onBoundary?: (charIndex: number) => void;
  onEnd?: () => void;
}

export function speak(text: string, opts: SpeakOptions | (() => void) = {}) {
  const o: SpeakOptions = typeof opts === 'function' ? { onEnd: opts } : opts;
  if (!canSpeak()) return o.onEnd?.();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  u.rate = o.rate ?? 0.95;
  u.pitch = o.pitch ?? 0.9;
  const v = koreanVoice();
  if (v) u.voice = v;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    o.onEnd?.();
  };
  u.onboundary = (e) => o.onBoundary?.(e.charIndex);
  u.onend = end;
  u.onerror = end;
  speechSynthesis.speak(u);
}

export function stopSpeaking() {
  if (canSpeak()) speechSynthesis.cancel();
}

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
