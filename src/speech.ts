/** Web Speech API 래퍼 — TTS(speechSynthesis) + STT(SpeechRecognition) */

export const canSpeak = () => 'speechSynthesis' in window;

function koreanVoice(): SpeechSynthesisVoice | undefined {
  return speechSynthesis.getVoices().find((v) => v.lang.startsWith('ko'));
}

export function speak(text: string, onEnd?: () => void) {
  if (!canSpeak()) return onEnd?.();
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'ko-KR';
  u.rate = 0.95;
  u.pitch = 0.9;
  const v = koreanVoice();
  if (v) u.voice = v;
  u.onend = () => onEnd?.();
  u.onerror = () => onEnd?.();
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

/** 한 번 듣기. interim 으로 중간 결과, 최종 문장으로 resolve */
export function listen(onInterim: (text: string) => void): { done: Promise<string>; stop: () => void } {
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
    rec.onerror = (e) =>
      reject(new Error(e.error === 'not-allowed' ? '마이크 권한이 거부되었습니다.' : '음성을 인식하지 못했습니다.'));
    rec.onend = () => resolve(finalText.trim());
  });
  rec.start();
  return { done, stop: () => rec.stop() };
}
