import { app } from './app.ts';
import { loadDetail } from './data.ts';
import type { HeritageDetail, HeritageSummary } from './types.ts';

/**
 * 사진 인식 (historydam RecognizeHeritagePhotoUseCase 와 같은 흐름)
 * 현재 위치 → 주변 국가유산 후보(힌트) → AI 비전 판별 → 유적(site)이면 국가유산청 상세로 보강.
 * AI 를 쓸 수 없으면 가장 가까운 국가유산으로 대체한다.
 */

/** AI 비전 판별 결과 (Worker 응답 형식 — historydam HeritageVisionResult 와 동일) */
export interface VisionResult {
  matchedId: string | null;
  name: string;
  kind: string;
  era: string;
  description: string;
  confidence: number;
  isHeritage: boolean;
  /** figure(초상화·인물상) / site(건물·유적) / relic(유물) */
  category: string;
}

export interface PhotoRecognition {
  identification: VisionResult;
  candidates: (HeritageSummary & { distance: number })[];
  official?: HeritageDetail;
  /** AI 판별 없이 위치로 대체한 결과 */
  fallback: boolean;
}

/** 4단계에서 배포할 Cloudflare Worker 주소 (예: https://yeoksadam-api.<계정>.workers.dev) */
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '');
const CANDIDATE_LIMIT = 8;

export const visionAvailable = () => !!API_BASE;

/** 비디오 프레임을 최대 변 1024px JPEG 로 캡처 */
export async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) throw new Error('카메라 화면을 캡처하지 못했습니다.');
  const ratio = Math.min(1, 1024 / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  canvas.getContext('2d')!.drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('사진 변환에 실패했습니다.'))), 'image/jpeg', 0.85),
  );
}

const toBase64 = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

async function callVision(photo: Blob, candidates: PhotoRecognition['candidates']): Promise<VisionResult> {
  if (!API_BASE) throw new Error('vision-unavailable');
  const res = await fetch(`${API_BASE}/vision`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      image: await toBase64(photo),
      candidates: candidates.map((c) => ({ id: c.id, name: c.name, kind: c.designation, city: c.city })),
    }),
  });
  if (!res.ok) throw new Error(`AI 인식 오류 (${res.status})`);
  const v = (await res.json()) as VisionResult;
  return {
    ...v,
    matchedId: candidates.some((c) => c.id === v.matchedId) ? v.matchedId : null,
    confidence: Math.max(0, Math.min(100, Math.round(v.confidence ?? 0))),
  };
}

export async function recognizePhoto(photo: Blob): Promise<PhotoRecognition> {
  const candidates = app.pos ? app.nearbySites(Infinity).slice(0, CANDIDATE_LIMIT) : [];
  try {
    const v = await callVision(photo, candidates);
    // 유물·인물이 주변 '유적지'로 덮어써지지 않도록 site 일 때만 공식 상세로 보강
    const official = v.matchedId && v.category === 'site' ? await loadDetail(v.matchedId).catch(() => undefined) : undefined;
    return { identification: v, candidates, official, fallback: false };
  } catch (e) {
    const nearest = candidates[0];
    if (!nearest) throw e instanceof Error && e.message !== 'vision-unavailable' ? e : new Error('주변에 국가유산이 없습니다.');
    const official = await loadDetail(nearest.id).catch(() => undefined);
    return {
      identification: {
        matchedId: nearest.id,
        name: nearest.name,
        kind: nearest.designation,
        era: nearest.era,
        description:
          'AI 이미지 인식을 사용할 수 없어, 현재 위치에서 가장 가까운 국가유산을 표시합니다. 아래 후보에서 다른 유산을 고를 수 있습니다.',
        confidence: 0,
        isHeritage: false,
        category: 'site',
      },
      candidates,
      official,
      fallback: true,
    };
  }
}
