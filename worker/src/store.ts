/**
 * 서버 저장소 — 3D 인물 모델(.glb) · RAG 자료(.md) · 외부 RAG 인물 설정 (docs/SERVER-STORAGE.md)
 *
 * 저장 위치는 Workers KV(STORE). R2 를 켜면 이 파일의 kv* 함수만 바꾸면 된다.
 *   model:<열쇠>     glb 바이트           idx:models   모델 목록(JSON)
 *   doc:<열쇠>       md 글               idx:docs     문서 목록(JSON)
 *   ext:personas    외부 RAG(백엔드) 인물 설정
 * 목록은 KV list 대신 idx:* 키 하나로 관리한다 (무료 플랜 list 한도가 하루 1,000회라서).
 *
 * 읽기·쓰기 모두 허용 출처(웹앱·편집기)와 앱 키로 들어온 요청만 받는다 (업로드 키 없음 — 교내 시연용).
 * 파일 이름은 인물·유적 이름 그대로 쓰고(예: 이순신.glb, 수원 화성.md), 비교는 NFC + 공백 제거로 한다.
 */
import { z } from 'zod';
import { splitChunks, terms, yearsIn } from './ragText.ts';

export interface StoreEnv {
  STORE: KVNamespace;
  SITE_BASE: string;
}

export class StoreError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/** KV 값 하나의 최대 크기 (25 MiB) */
export const MAX_MODEL_BYTES = 25 * 1024 * 1024;
const MAX_DOC_CHARS = 200_000;

/** 이름 비교 열쇠: 확장자 제거 · NFC(맥 등의 자모 분리 형태 통일) · 공백 제거 */
export const nameKey = (name: string) =>
  name
    .normalize('NFC')
    .replace(/\.(glb|md)$/i, '')
    .replace(/\s+/g, '');
const displayName = (name: string) => name.normalize('NFC').replace(/\.(glb|md)$/i, '').replace(/\s+/g, ' ').trim();

// ---------- 인물·유적 목록 (이름 → id) ----------
interface FigureLite {
  id: string;
  name: string;
  hanja: string;
  title: string;
  years: string;
  bio: string;
  died?: number;
  style: string;
  speech?: string;
  sites: { id: string }[];
}
interface IndexItem {
  id: string;
  name: string;
  designation?: string;
  city?: string;
}
interface DetailLite {
  id: string;
  name: string;
  designation: string;
  era: string;
  city?: string;
}

const dataCache = new Map<string, Promise<unknown>>();
function siteJson<T>(env: StoreEnv, p: string): Promise<T> {
  const url = `${env.SITE_BASE}data/${p}`;
  let v = dataCache.get(url);
  if (!v) {
    v = fetch(url).then((r) => {
      if (!r.ok) throw new StoreError(502, `데이터를 불러오지 못했습니다: ${p}`);
      return r.json();
    });
    v.catch(() => dataCache.delete(url));
    dataCache.set(url, v);
  }
  return v as Promise<T>;
}
const figuresOf = (env: StoreEnv) => siteJson<{ figures: FigureLite[] }>(env, 'figures.json').then((d) => d.figures);

interface Resolved {
  /** 출처 id: 유적 id 또는 fig:<인물 id> */
  id: string;
  name: string;
  /** 색인 조각 머리말 (scripts/build-rag.ts 와 같은 형식) */
  head: string;
}

/** 이름 또는 id → 인물·유적. 같은 이름의 유적이 여럿이면 id 로 적어 달라고 한다 */
async function resolve(env: StoreEnv, ref: string): Promise<Resolved | undefined> {
  const raw = ref.trim();
  if (!raw) return undefined;
  const figures = await figuresOf(env);
  const fid = raw.startsWith('fig:') ? raw.slice(4) : undefined;
  const f = figures.find((x) => x.id === (fid ?? raw) || nameKey(x.name) === nameKey(raw));
  if (f) return { id: `fig:${f.id}`, name: f.name, head: `${f.name}(${f.hanja}) — ${f.title}, ${f.years}` };

  const { items } = await siteJson<{ items: IndexItem[] }>(env, 'index.json');
  let hits = items.filter((it) => it.id === raw);
  if (!hits.length) hits = items.filter((it) => nameKey(it.name) === nameKey(raw));
  if (hits.length > 1) {
    throw new StoreError(400, `'${raw}' 이름의 유적이 ${hits.length}곳입니다. id 로 적어 주세요: ${hits.map((h) => `${h.id}(${h.city ?? ''})`).join(', ')}`);
  }
  if (!hits.length) return undefined;
  const d = await siteJson<DetailLite>(env, `detail/${hits[0].id}.json`);
  return { id: d.id, name: d.name, head: `${d.name} (${[d.designation, d.era, d.city].filter(Boolean).join(', ')})` };
}

// ---------- 목록 ----------
export interface ModelEntry {
  name: string;
  key: string;
  /** 연결된 인물 id (인물 목록에 없는 이름이면 null) */
  id: string | null;
  size: number;
  sha256: string;
  heightM: number;
  uploadedAt: string;
}
export interface DocEntry {
  name: string;
  key: string;
  size: number;
  sha256: string;
  uploadedAt: string;
  source: string;
  /** 연도 머리말 [가장 이른, 가장 늦은] */
  years?: [number, number];
  /** 대상: 이 출처의 원문을 대체(또는 제외) */
  target?: Resolved;
  hidden?: boolean;
  /** 연결: 이 출처의 자료로 취급 (대상이 없을 때) */
  link?: Resolved;
}

const readIdx = async <T>(env: StoreEnv, k: string): Promise<T[]> => ((await env.STORE.get<T[]>(k, 'json')) ?? []);
async function writeIdx<T extends { key: string }>(env: StoreEnv, k: string, entry: T | null, key: string) {
  const list = (await readIdx<T>(env, k)).filter((e) => e.key !== key);
  if (entry) list.push(entry);
  list.sort((a, b) => a.key.localeCompare(b.key, 'ko'));
  await env.STORE.put(k, JSON.stringify(list));
  return list;
}

async function sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string> {
  const h = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- RAG 문서 (.md) ----------
export interface ParsedDoc {
  meta: Record<string, string>;
  body: string;
}
/** 머리말(「키: 값」 줄) + `---` + 본문. `---` 가 없으면 전체가 본문 */
export function parseDoc(text: string): ParsedDoc {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const m = t.match(/^((?:[^\n]*\n)*?)-{3,}\s*\n([\s\S]*)$/);
  if (!m) return { meta: {}, body: t.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^\s*([^:：]+?)\s*[:：]\s*(.*?)\s*$/);
    if (kv) meta[kv[1]] = kv[2];
  }
  return { meta, body: m[2].trim() };
}
const parseYears = (v?: string): [number, number] | undefined => {
  const ys = (v ?? '').match(/\d{3,4}/g)?.map(Number);
  return ys?.length ? [Math.min(...ys), Math.max(...ys)] : undefined;
};
const isYes = (v?: string) => /^(예|네|yes|y|true|1|o)$/i.test((v ?? '').trim());

/** 문서 검사·해석 — 저장 전에 대상·연결 이름을 id 로 바꿔 둔다 (검색할 때는 다시 해석하지 않음) */
async function describeDoc(env: StoreEnv, name: string, text: string): Promise<{ entry: Omit<DocEntry, 'sha256' | 'uploadedAt'>; warning?: string }> {
  const { meta, body } = parseDoc(text);
  const target = meta['대상'] ? await resolve(env, meta['대상']) : undefined;
  if (meta['대상'] && !target) throw new StoreError(400, `대상 '${meta['대상']}': 인물·유적 목록에 없는 이름입니다.`);
  const hidden = isYes(meta['제외']);
  if (hidden && !target) throw new StoreError(400, '제외: 예 는 대상 머리말과 함께 써야 합니다.');
  if (!hidden && !body) throw new StoreError(400, '본문이 비어 있습니다.');
  let link: Resolved | undefined;
  let warning: string | undefined;
  if (!target) {
    link = meta['연결'] ? await resolve(env, meta['연결']) : await resolve(env, name).catch(() => undefined);
    if (meta['연결'] && !link) throw new StoreError(400, `연결 '${meta['연결']}': 인물·유적 목록에 없는 이름입니다.`);
    if (!link) warning = '파일 이름과 같은 인물·유적이 없어 독립 자료로 저장했습니다.';
  }
  const years = parseYears(meta['연도']);
  return {
    entry: {
      name: displayName(name),
      key: nameKey(name),
      size: new TextEncoder().encode(text).length,
      source: meta['출처'] || '직접 작성',
      ...(years ? { years } : {}),
      ...(target ? { target } : {}),
      ...(hidden ? { hidden } : {}),
      ...(link ? { link } : {}),
    },
    warning,
  };
}

// ---------- RAG 겹쳐 쓰기 (Worker /rag · /chat 이 쓴다) ----------
export interface OverlayChunk {
  s: string;
  t: string;
  x: string;
  len: number;
  tf: Map<string, number>;
  years: [number, number];
}
export interface Overlay {
  /** 원문을 쓰지 않을 출처 (대체·제외) */
  excluded: Set<string>;
  /** 원문 대신 쓸 글 (출처 id → 본문) */
  replaced: Map<string, string>;
  chunks: OverlayChunk[];
  /** 단어 → 겹쳐 쓴 조각들의 문서 빈도 */
  df: Map<string, number>;
  version: string;
}
const EMPTY_OVERLAY: Overlay = { excluded: new Set(), replaced: new Map(), chunks: [], df: new Map(), version: '' };

let overlayCache: { at: number; p: Promise<Overlay> } | undefined;
/** 업로드 문서를 1분마다 확인해 조각·단어 빈도를 만들어 둔다 (문서 수가 적어 검색할 때 바로 점수를 매길 수 있다) */
export function loadOverlay(env: StoreEnv): Promise<Overlay> {
  if (!env.STORE) return Promise.resolve(EMPTY_OVERLAY);
  if (overlayCache && Date.now() - overlayCache.at < 60_000) return overlayCache.p;
  const prev = overlayCache?.p;
  const p = (async () => {
    const list = await readIdx<DocEntry>(env, 'idx:docs');
    const version = list.map((e) => e.sha256.slice(0, 8)).join('');
    const old = await prev?.catch(() => undefined);
    if (old && old.version === version) return old;
    const texts = await Promise.all(list.map((e) => env.STORE.get(`doc:${e.key}`)));
    const o: Overlay = { excluded: new Set(), replaced: new Map(), chunks: [], df: new Map(), version };
    list.forEach((e, i) => {
      const text = texts[i];
      if (text == null) return;
      if (e.target) o.excluded.add(e.target.id);
      if (e.hidden) return;
      const { body } = parseDoc(text);
      if (e.target) o.replaced.set(e.target.id, body);
      const src = e.target ?? e.link;
      const s = src?.id ?? `u:${e.key}`;
      const t = src?.name ?? e.name;
      const head = e.target ? e.target.head : e.name;
      addChunks(o, { s, t, head, body, years: e.years });
    });
    return o;
  })();
  const safe = prev ? p.catch(() => prev) : p.catch(() => EMPTY_OVERLAY);
  overlayCache = { at: Date.now(), p: safe };
  return safe;
}

/** 글 하나를 조각으로 나눠 겹쳐 쓰기에 더한다 (단어 빈도·연도 포함) */
export function addChunks(o: Overlay, d: { s: string; t: string; head: string; body: string; years?: [number, number] }) {
  for (const part of splitChunks(d.body)) {
    const x = `${d.head}\n${part}`;
    const ts = terms(x);
    const tf = new Map<string, number>();
    for (const w of ts) tf.set(w, (tf.get(w) ?? 0) + 1);
    for (const w of tf.keys()) o.df.set(w, (o.df.get(w) ?? 0) + 1);
    const ys = d.years ?? ((y) => (y.length ? ([Math.min(...y), Math.max(...y)] as [number, number]) : undefined))(yearsIn(part));
    o.chunks.push({ s: d.s, t: d.t, x, len: ts.length, tf, years: ys ?? [0, 0] });
  }
}

export const emptyOverlay = (): Overlay => ({ excluded: new Set(), replaced: new Map(), chunks: [], df: new Map(), version: '' });

/** 두 겹쳐 쓰기를 합친다 (서버 공용 자료 + 사용자별 자료) */
export function mergeOverlay(a: Overlay, b: Overlay): Overlay {
  if (!b.chunks.length && !b.excluded.size) return a;
  const df = new Map(a.df);
  for (const [w, n] of b.df) df.set(w, (df.get(w) ?? 0) + n);
  return {
    excluded: new Set([...a.excluded, ...b.excluded]),
    replaced: new Map([...a.replaced, ...b.replaced]),
    chunks: [...a.chunks, ...b.chunks],
    df,
    version: `${a.version}+${b.version}`,
  };
}

// ---------- 외부 RAG(백엔드) 인물 설정 ----------
const Persona = z.object({
  name: z.string().min(1).max(40),
  era: z.string().max(20),
  maxYear: z.number().int().min(0).max(3000),
  keyword: z.string().min(1).max(40),
  persona: z.string().min(1).max(2000),
});
const Personas = z.object({ figures: z.record(z.string().max(64), Persona) });

// ---------- HTTP ----------
type Reply = { body: unknown; status?: number } | Response;


/** /store/* · /model/* · /doc/* 처리. 해당 경로가 아니면 undefined */
export async function handleStore(req: Request, env: StoreEnv, path: string): Promise<Reply | undefined> {
  const m = req.method;
  const seg = (prefix: string) => decodeURIComponent(path.slice(prefix.length));
  if (!env.STORE && (path.startsWith('/store/') || path.startsWith('/model/') || path.startsWith('/doc/'))) {
    throw new StoreError(503, '서버 저장소(KV)가 연결되지 않았습니다.');
  }

  if (path === '/store/models.json' && m === 'GET') return { body: { models: await readIdx<ModelEntry>(env, 'idx:models') } };
  if (path === '/store/docs.json' && m === 'GET') return { body: { docs: await readIdx<DocEntry>(env, 'idx:docs') } };
  if (path === '/store/status' && m === 'GET') {
    const [models, docs, overlay] = await Promise.all([readIdx<ModelEntry>(env, 'idx:models'), readIdx<DocEntry>(env, 'idx:docs'), loadOverlay(env)]);
    return { body: { models: models.length, docs: docs.length, chunks: overlay.chunks.length, version: overlay.version } };
  }

  // 외부 RAG 인물 설정
  if (path === '/store/personas.json') {
    if (m === 'GET') return { body: (await env.STORE.get('ext:personas', 'json')) ?? { figures: {} } };
    if (m === 'PUT') {
      const v = Personas.parse(await req.json());
      const saved = { ...v, updatedAt: new Date().toISOString() };
      await env.STORE.put('ext:personas', JSON.stringify(saved));
      return { body: saved };
    }
  }

  // 백엔드 RAG 용: 인물에 연결된 업로드 자료 조각
  if (path.startsWith('/store/context/') && m === 'GET') {
    const fid = seg('/store/context/');
    const figures = await figuresOf(env);
    const f = figures.find((x) => x.id === fid || x.id === fid.replace(/^fig_/, ''));
    if (!f) throw new StoreError(404, '인물을 찾을 수 없습니다.');
    const own = new Set([`fig:${f.id}`, ...f.sites.map((s) => s.id)]);
    const o = await loadOverlay(env);
    const chunks = o.chunks.filter((c) => own.has(c.s)).slice(0, 8).map((c) => ({ source: c.t, text: c.x, years: c.years }));
    return { body: { chunks } };
  }

  // 3D 모델
  if (path.startsWith('/model/')) {
    const name = seg('/model/');
    const key = nameKey(name);
    if (!key || key.length > 60) throw new StoreError(400, '파일 이름이 올바르지 않습니다.');
    if (m === 'GET' || m === 'HEAD') {
      const { value, metadata } = await env.STORE.getWithMetadata<ModelEntry>(`model:${key}`, 'arrayBuffer');
      if (!value || !metadata) throw new StoreError(404, '모델이 없습니다.');
      const etag = `"${metadata.sha256}"`;
      const h = { 'Content-Type': 'model/gltf-binary', ETag: etag, 'Cache-Control': 'public, max-age=604800', 'Content-Length': String(value.byteLength) };
      if (req.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: h });
      return new Response(m === 'HEAD' ? null : value, { headers: h });
    }
    if (m === 'PUT') {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_MODEL_BYTES) throw new StoreError(413, `모델은 ${MAX_MODEL_BYTES / 1024 / 1024}MB 이하만 저장할 수 있습니다. 압축해 주세요.`);
      if (new TextDecoder().decode(buf.slice(0, 4)) !== 'glTF') throw new StoreError(400, 'glb(glTF 바이너리) 파일이 아닙니다.');
      const sha = (req.headers.get('X-Content-SHA256') ?? '').toLowerCase();
      const figures = await figuresOf(env);
      const f = figures.find((x) => nameKey(x.name) === key);
      const height = Number(req.headers.get('X-Height-M'));
      const entry: ModelEntry = {
        name: displayName(name),
        key,
        id: f?.id ?? null,
        size: buf.byteLength,
        sha256: /^[0-9a-f]{64}$/.test(sha) ? sha : await sha256Hex(buf),
        heightM: height > 0.3 && height < 5 ? height : 1.65,
        uploadedAt: new Date().toISOString(),
      };
      await env.STORE.put(`model:${key}`, buf, { metadata: entry });
      await writeIdx(env, 'idx:models', entry, key);
      return { body: { model: entry, ...(f ? {} : { warning: '인물 목록에 없는 이름입니다. 앱에서 이 모델을 찾지 못합니다.' }) } };
    }
    if (m === 'DELETE') {
      await env.STORE.delete(`model:${key}`);
      await writeIdx<ModelEntry>(env, 'idx:models', null, key);
      return { body: { deleted: key } };
    }
  }

  // RAG 문서
  if (path.startsWith('/doc/')) {
    const name = seg('/doc/');
    const key = nameKey(name);
    if (!key || key.length > 80) throw new StoreError(400, '파일 이름이 올바르지 않습니다.');
    if (m === 'GET') {
      const text = await env.STORE.get(`doc:${key}`);
      if (text == null) throw new StoreError(404, '문서가 없습니다.');
      return new Response(text, { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' } });
    }
    if (m === 'PUT') {
      const text = await req.text();
      if (text.length > MAX_DOC_CHARS) throw new StoreError(413, '문서가 너무 깁니다 (20만 자 이하).');
      const { entry, warning } = await describeDoc(env, name, text);
      const full: DocEntry = { ...entry, sha256: await sha256Hex(new TextEncoder().encode(text)), uploadedAt: new Date().toISOString() };
      await env.STORE.put(`doc:${key}`, text);
      await writeIdx(env, 'idx:docs', full, key);
      overlayCache = undefined; // 이 isolate 는 바로 반영 (다른 곳은 1분 안에)
      return { body: { doc: full, ...(warning ? { warning } : {}) } };
    }
    if (m === 'DELETE') {
      await env.STORE.delete(`doc:${key}`);
      await writeIdx<DocEntry>(env, 'idx:docs', null, key);
      overlayCache = undefined;
      return { body: { deleted: key } };
    }
  }
  return undefined;
}
