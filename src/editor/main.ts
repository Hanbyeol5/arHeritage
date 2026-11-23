/**
 * RAG 자료 편집기 (/editor/) — 웹앱과 분리된 관리 도구. 웹앱 메뉴에는 링크가 없다.
 *
 * 자료는 서버 저장소(Worker /doc, Cloudflare KV)에 Markdown 문서로 저장한다 (docs/SERVER-STORAGE.md).
 *   · 유적·인물 글 바꾸기 → 「대상: <id>」 문서 (원문 대체)
 *   · RAG 에서 빼기      → 「대상: <id> / 제외: 예」 문서
 *   · 새 자료 추가       → 제목 이름의 문서 (「연결: <id>」 가 있으면 그 유적·인물의 자료)
 * 폰 앱(관리자 모드)에서 올린 .md 와 같은 저장소·형식이다. 저장하면 1분 안에 RAG 서버 대화에 쓰인다.
 *
 * 「외부 RAG 인물 설정」 탭은 Android 앱 백엔드 RAG(historydam backend 방식)의 인물 설정
 * (말투·사망 연도·검색어)을 편집해 /store/personas.json 에 저장한다.
 */
import './editor.css';
import { splitChunks } from '../../worker/src/ragText.ts';
import type { Figure, HeritageDetail, HeritageIndex } from '../types.ts';
import { josa } from '../ui/josa.ts';

const BASE = import.meta.env.BASE_URL;
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '');
const DRAFT_KEY = 'yeoksadam-editor:draft2';

type Kind = 'heritage' | 'local' | 'tour' | 'figure';
interface Source {
  id: string;
  name: string;
  sub: string;
  kind: Kind;
}
interface Extra {
  /** 서버 문서 열쇠 (새로 만든 자료는 「new-…」) */
  id: string;
  title: string;
  link?: string;
  text: string;
  source?: string;
  years?: string;
}
interface Edits {
  overrides: Record<string, string>;
  hidden: string[];
  extra: Extra[];
}
const emptyEdits = (): Edits => ({ overrides: {}, hidden: [], extra: [] });

/** 서버 문서 목록 항목 (worker/src/store.ts DocEntry) */
interface DocEntry {
  name: string;
  key: string;
  source: string;
  years?: [number, number];
  target?: { id: string; name: string };
  hidden?: boolean;
  link?: { id: string; name: string };
  uploadedAt: string;
}
/** 외부 RAG(백엔드) 인물 설정 — Android core:backend BackendRagChat.Persona 와 같은 모양 */
interface Persona {
  name: string;
  era: string;
  maxYear: number;
  keyword: string;
  persona: string;
}

const KIND_LABEL: Record<Kind, string> = { heritage: '국가유산', local: '향토유산', tour: '역사관광지', figure: '인물' };
const FILTERS: [string, string][] = [
  ['all', '전체'],
  ['changed', '수정·추가·제외'],
  ['extra', '추가 자료'],
  ['figure', '인물'],
  ['heritage', '국가유산'],
  ['local', '향토유산'],
  ['tour', '역사관광지'],
];
const LIST_MAX = 300;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
/** 서버와 같은 이름 열쇠 (worker/src/store.ts nameKey) */
const nameKey = (name: string) =>
  name
    .normalize('NFC')
    .replace(/\.(glb|md)$/i, '')
    .replace(/\s+/g, '');

function safeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function safeSet(store: Storage, key: string, value: string | null) {
  try {
    if (value === null) store.removeItem(key);
    else store.setItem(key, value);
  } catch {
    /* 저장 불가 환경 */
  }
}

// ---------- 상태 ----------
let sources: Source[] = [];
const byId = new Map<string, Source>();
const figures = new Map<string, Figure>();
/** 초안의 기준(서버에 저장된 상태)과 현재 작업본 */
let base: Edits = emptyEdits();
let edits: Edits = emptyEdits();
/** 대상 출처 id → 서버 문서 이름 (폰에서 올린 문서는 이름이 제각각이라 기억해 둔다) */
let targetDoc = new Map<string, string>();
/** 외부 RAG 인물 설정: 서버 값과 작업본 (없는 인물은 기본값) */
let personaBase: Record<string, Persona> = {};
let personas: Record<string, Persona> = {};
let mode: 'rag' | 'persona' = 'rag';
let selected: string | null = null; // 출처 id, "x:<추가 자료 id>", 인물 설정은 "p:<인물 id>"
let query = '';
let filter = 'all';

// ---------- 차이 계산 (o: 글 바꾸기, h: 제외, x: 추가 자료, p: 인물 설정) ----------
function keyValue(e: Edits, key: string): string | undefined {
  const id = key.slice(2);
  if (key.startsWith('o:')) return e.overrides[id];
  if (key.startsWith('h:')) return e.hidden.includes(id) ? '1' : undefined;
  const x = e.extra.find((v) => v.id === id);
  return x && JSON.stringify(x);
}
function allKeys(...list: Edits[]): Set<string> {
  const keys = new Set<string>();
  for (const e of list) {
    Object.keys(e.overrides).forEach((id) => keys.add(`o:${id}`));
    e.hidden.forEach((id) => keys.add(`h:${id}`));
    e.extra.forEach((x) => keys.add(`x:${x.id}`));
  }
  return keys;
}
const ragChanged = () => [...allKeys(base, edits)].filter((k) => keyValue(base, k) !== keyValue(edits, k));
const personaChanged = () =>
  [...new Set([...Object.keys(personaBase), ...Object.keys(personas)])].filter((id) => JSON.stringify(personaBase[id]) !== JSON.stringify(personas[id]));
const changedCount = () => ragChanged().length + personaChanged().length;

/** from 의 key 값을 to 에 옮긴다 (없으면 to 에서도 지운다) */
function applyKey(to: Edits, from: Edits, key: string) {
  const id = key.slice(2);
  if (key.startsWith('o:')) {
    if (id in from.overrides) to.overrides[id] = from.overrides[id];
    else delete to.overrides[id];
  } else if (key.startsWith('h:')) {
    to.hidden = to.hidden.filter((v) => v !== id);
    if (from.hidden.includes(id)) to.hidden.push(id);
  } else {
    const x = from.extra.find((v) => v.id === id);
    const i = to.extra.findIndex((v) => v.id === id);
    if (x && i >= 0) to.extra[i] = clone(x);
    else if (x) to.extra.push(clone(x));
    else if (i >= 0) to.extra.splice(i, 1);
  }
}

function saveDraft() {
  const dirty = changedCount() > 0;
  safeSet(localStorage, DRAFT_KEY, dirty ? JSON.stringify({ base, edits, personaBase, personas }) : null);
  renderHeader();
}

// ---------- 데이터 ----------
const json = <T>(p: string) =>
  fetch(`${BASE}data/${p}`, { cache: 'no-cache' }).then((r) => {
    if (!r.ok) throw new Error(`${p} ${r.status}`);
    return r.json() as Promise<T>;
  });
const detailCache = new Map<string, Promise<HeritageDetail>>();
const detail = (id: string) => {
  let p = detailCache.get(id);
  if (!p) detailCache.set(id, (p = json<HeritageDetail>(`detail/${id}.json`)));
  return p;
};

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  if (!API_BASE) throw new Error('API 주소(VITE_API_BASE)가 설정되지 않은 빌드입니다.');
  return fetch(`${API_BASE}${path}`, { cache: 'no-store', ...init });
}
async function apiJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await api(path, init);
  const d = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(d.error ?? `서버 오류 ${r.status}`);
  return d;
}
const docPath = (name: string) => `/doc/${encodeURIComponent(name)}.md`;

/** 원문: 유적은 상세 설명, 인물은 소개 글 */
async function originalText(id: string): Promise<string> {
  if (id.startsWith('fig:')) return figures.get(id.slice(4))?.bio ?? '';
  return (await detail(id)).description;
}
/** 조각 머리말 (색인 만들기와 같은 형식) */
async function chunkHead(id: string): Promise<string> {
  if (id.startsWith('fig:')) {
    const f = figures.get(id.slice(4))!;
    return `${f.name}(${f.hanja}) — ${f.title}, ${f.years}`;
  }
  const d = await detail(id);
  return `${d.name} (${[d.designation, d.era, d.city].filter(Boolean).join(', ')})`;
}

/** 머리말 + 본문 (worker/src/store.ts parseDoc) */
function parseDoc(text: string): { meta: Record<string, string>; body: string } {
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
const docText = (meta: [string, string | undefined][], body: string) =>
  `${meta
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n')}\n---\n${body.trim()}\n`;

/** 같은 이름의 유적이 여럿이면 id 를 붙여 문서 이름이 겹치지 않게 한다 */
function targetDocName(id: string): string {
  const known = targetDoc.get(id);
  if (known) return known;
  const s = byId.get(id)!;
  const dup = sources.some((o) => o.id !== id && nameKey(o.name) === nameKey(s.name));
  return `${s.name}${dup ? ` ${id}` : ''} 고침`;
}

/** 서버 문서 → 편집 상태 */
async function loadServer(): Promise<Edits> {
  const { docs } = await apiJson<{ docs: DocEntry[] }>('/store/docs.json');
  const texts = await Promise.all(docs.map((d) => api(docPath(d.name)).then((r) => (r.ok ? r.text() : ''))));
  const e = emptyEdits();
  targetDoc = new Map();
  docs.forEach((d, i) => {
    const { meta, body } = parseDoc(texts[i]);
    if (d.target) {
      targetDoc.set(d.target.id, d.name);
      if (d.hidden) e.hidden.push(d.target.id);
      else e.overrides[d.target.id] = body;
      return;
    }
    e.extra.push({
      id: d.key,
      title: d.name,
      text: body,
      ...(d.link ? { link: d.link.id } : {}),
      ...(meta['출처'] ? { source: meta['출처'] } : {}),
      ...(meta['연도'] ? { years: meta['연도'] } : {}),
    });
  });
  return e;
}

// ---------- 외부 RAG 기본 인물 설정 (Android BackendRagChat 과 같은 규칙) ----------
const BACKEND_FIGURES: Record<string, Persona> = {
  sejong: { name: '세종대왕', era: '조선', maxYear: 1450, keyword: '세종', persona: '조선의 제4대 왕이다. 백성을 아끼는 자애롭고 위엄 있는 어조(~하노라, ~이니라)를 쓴다.' },
  'jang-yeongsil': {
    name: '장영실',
    era: '조선',
    maxYear: 1450,
    keyword: '장영실',
    persona: '조선의 천민 출신 과학자이다. 신분은 낮았으나 기술에 대한 열정이 넘치며, 겸손하고 공손한 어조(~하옵니다, ~였습니다)를 쓴다.',
  },
};
function defaultPersona(f: Figure): Persona {
  if (BACKEND_FIGURES[f.id]) return BACKEND_FIGURES[f.id];
  const died = f.died ?? 2026;
  const tone =
    f.style === 'king'
      ? '임금으로서 백성을 아끼는 위엄 있고 자애로운 어조(~하노라, ~이니라)를 쓴다.'
      : f.style === 'general'
        ? '장수로서 결연하고 강직한 어조(~하였소, ~하겠네)를 쓴다.'
        : f.style === 'lady'
          ? '단아하고 온화하며 기품 있는 어조(~하옵니다, ~이지요)를 쓴다.'
          : '선비로서 차분하고 품위 있는 어조(~하오, ~이외다)를 쓴다.';
  const years = /\d/.test(f.years) ? `(${f.years})` : '';
  const title = f.title ? `${f.title}.` : '';
  return {
    name: f.name,
    era: died <= 1392 ? '고려' : '조선',
    maxYear: died,
    keyword: f.name.split(' ').pop()!.replace(/대왕$/, ''),
    persona: `${f.name}${years} 이다. ${title} ${f.bio.trim()} ${tone}`.replace(/\s+/g, ' ').replace(' 이다.', '이다.').trim(),
  };
}

// ---------- 화면 ----------
const root = document.getElementById('app')!;
root.innerHTML = `
  <header class="ed-top">
    <div class="ed-brand"><span class="seal">談</span><div><b>RAG 자료 편집기</b><small>인물 대화(RAG 서버·외부 RAG)가 참고하는 자료 — 서버 저장</small></div></div>
    <nav class="ed-tabs">
      <button class="on" data-mode="rag">RAG 자료</button>
      <button data-mode="persona">외부 RAG 인물 설정</button>
    </nav>
    <div class="ed-status"></div>
    <div class="ed-actions">
      <button class="btn ghost" data-act="io" title="작업본 내려받기·불러오기">파일</button>
      <button class="btn solid" data-act="publish">서버에 저장</button>
    </div>
  </header>
  <div class="ed-notice" hidden></div>
  <main class="ed-main">
    <aside class="ed-side">
      <div class="ed-search">
        <input type="search" placeholder="유적·인물 이름, 시군, id 검색" />
        <select>${FILTERS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      </div>
      <button class="btn outline add" data-act="add">+ 새 자료 추가</button>
      <div class="ed-list" role="list"></div>
    </aside>
    <section class="ed-pane"></section>
  </main>`;

const $ = <T extends HTMLElement>(sel: string, el: ParentNode = root) => el.querySelector<T>(sel)!;
const listEl = $('.ed-list');
const pane = $('.ed-pane');

const EMPTY_RAG = `<div class="ed-empty">왼쪽에서 유적·인물을 고르거나 <b>새 자료</b>를 추가하세요.<br/><br/>
  <small>고친 내용은 <b>서버에 저장</b>을 누르면 서버 저장소에 Markdown 문서로 올라가고, 1분 안에 <b>RAG 서버</b> 대화와 Android 앱 <b>백엔드 RAG</b>(인물에 연결된 자료)에 쓰입니다. 원본 데이터는 바뀌지 않으며, 언제든 원문으로 되돌릴 수 있습니다.</small></div>`;
const EMPTY_PERSONA = `<div class="ed-empty">왼쪽에서 인물을 고르세요.<br/><br/>
  <small><b>외부 RAG 인물 설정</b>은 Android 앱의 기본 대화 방식인 <b>백엔드 RAG</b>(의도 분류 → 공공기관 자료 7곳 검색 → Gemini)가 인물을 연기할 때 쓰는 설정입니다. 고치지 않은 인물은 앱에 들어 있는 기본값을 씁니다.<br/>
  인물에 연결된 보충 자료는 <b>RAG 자료</b> 탭에서 추가하면 백엔드 RAG 의 참고 자료에도 함께 들어갑니다.</small></div>`;
pane.innerHTML = EMPTY_RAG;

function notice(html: string, kind: 'info' | 'ok' | 'err' = 'info') {
  const n = $('.ed-notice');
  n.className = `ed-notice ${kind}`;
  n.innerHTML = `<span>${html}</span><button aria-label="닫기">✕</button>`;
  n.hidden = false;
  n.querySelector('button')!.onclick = () => (n.hidden = true);
}

function renderHeader() {
  const n = changedCount();
  const e = edits;
  $('.ed-status').innerHTML = `
    <span>글 바꿈 <b>${Object.keys(e.overrides).length}</b></span>
    <span>제외 <b>${e.hidden.length}</b></span>
    <span>추가 <b>${e.extra.length}</b></span>
    <span>인물 설정 <b>${Object.keys(personas).length}</b></span>
    <span class="${n ? 'dirty' : ''}">${n ? `저장 안 한 변경 <b>${n}</b>건` : '모두 저장됨'}</span>`;
  $<HTMLButtonElement>('[data-act=publish]').disabled = !n;
}

function badges(id: string): string {
  const b: string[] = [];
  if (id in edits.overrides) b.push('<i class="bd edit">수정</i>');
  if (edits.hidden.includes(id)) b.push('<i class="bd off">제외</i>');
  const n = edits.extra.filter((x) => x.link === id).length;
  if (n) b.push(`<i class="bd add">추가 ${n}</i>`);
  return b.join('');
}

function renderList() {
  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const rows: string[] = [];

  if (mode === 'persona') {
    for (const f of figures.values()) {
      if (!match(`${f.name} ${f.title} ${f.id}`)) continue;
      const edited = !!personas[f.id];
      rows.push(`<button class="it ${selected === `p:${f.id}` ? 'on' : ''}" data-id="p:${esc(f.id)}">
        <b>${esc(f.name)}</b><small>${esc(f.title)}, ${esc(f.years)}</small>${edited ? '<i class="bd edit">수정</i>' : ''}</button>`);
    }
    listEl.innerHTML = rows.join('') || '<p class="more">찾는 인물이 없습니다.</p>';
    return;
  }

  if (filter === 'all' || filter === 'extra' || filter === 'changed') {
    for (const x of edits.extra) {
      if (!match(`${x.title} ${x.text.slice(0, 200)}`)) continue;
      const link = x.link ? byId.get(x.link)?.name : '';
      rows.push(`<button class="it ${selected === `x:${x.id}` ? 'on' : ''}" data-id="x:${esc(x.id)}">
        <b>${esc(x.title || '(제목 없음)')}</b><small>추가 자료${link ? ` · ${esc(link)}에 연결` : ''}</small><i class="bd add">추가</i></button>`);
    }
  }
  let shown = 0;
  let total = 0;
  if (filter !== 'extra') {
    for (const s of sources) {
      if (filter === 'changed' && !(s.id in edits.overrides || edits.hidden.includes(s.id))) continue;
      if (filter !== 'all' && filter !== 'changed' && s.kind !== filter) continue;
      if (!match(`${s.name} ${s.sub} ${s.id}`)) continue;
      total++;
      if (shown >= LIST_MAX) continue;
      shown++;
      rows.push(`<button class="it ${selected === s.id ? 'on' : ''}" data-id="${esc(s.id)}">
        <b>${esc(s.name)}</b><small>${esc(KIND_LABEL[s.kind])} · ${esc(s.sub)}</small>${badges(s.id)}</button>`);
    }
  }
  if (total > shown) rows.push(`<p class="more">그 밖에 ${total - shown}곳 — 검색어로 좁혀 보세요.</p>`);
  listEl.innerHTML = rows.join('') || '<p class="more">찾는 자료가 없습니다.</p>';
}

listEl.addEventListener('click', (ev) => {
  const b = (ev.target as HTMLElement).closest<HTMLElement>('[data-id]');
  if (b) select(b.dataset.id!);
});
$<HTMLInputElement>('.ed-search input').addEventListener('input', (e) => {
  query = (e.target as HTMLInputElement).value;
  renderList();
});
$<HTMLSelectElement>('.ed-search select').addEventListener('change', (e) => {
  filter = (e.target as HTMLSelectElement).value;
  renderList();
});
root.querySelectorAll<HTMLButtonElement>('.ed-tabs button').forEach((b) =>
  b.addEventListener('click', () => {
    mode = b.dataset.mode as typeof mode;
    root.querySelectorAll('.ed-tabs button').forEach((x) => x.classList.toggle('on', x === b));
    $<HTMLSelectElement>('.ed-search select').hidden = mode === 'persona';
    $('[data-act=add]').hidden = mode === 'persona';
    $<HTMLInputElement>('.ed-search input').placeholder = mode === 'persona' ? '인물 이름 검색' : '유적·인물 이름, 시군, id 검색';
    select(null);
    pane.innerHTML = mode === 'persona' ? EMPTY_PERSONA : EMPTY_RAG;
  }),
);

function select(id: string | null) {
  selected = id;
  root.classList.toggle('picked', !!id);
  renderList();
  if (!id) return;
  if (id.startsWith('p:')) renderPersona(id.slice(2));
  else if (id.startsWith('x:')) renderExtra(id.slice(2));
  else void renderSource(id);
}

/** 조각 미리보기 */
function chunkPreview(el: HTMLElement, text: string, head: string) {
  const parts = splitChunks(text);
  el.innerHTML = parts.length
    ? `<div class="ch-sum">RAG 조각 <b>${parts.length}</b>개 · 조각당 최대 500자, 앞에 「${esc(head)}」가 붙습니다</div>
       ${parts.map((p, i) => `<div class="ch"><span>${i + 1}</span><p>${esc(p.length > 160 ? `${p.slice(0, 160)}…` : p)}</p><small>${p.length}자</small></div>`).join('')}`
    : '<div class="ch-sum">글이 비어 있습니다. 유적은 이름·지정·시군 한 줄만 들어갑니다.</div>';
}

function testBox(defaultPersona: string): string {
  const opts = [...figures.values()].map((f) => `<option value="${esc(f.id)}" ${f.id === defaultPersona ? 'selected' : ''}>${esc(f.name)}</option>`);
  if (selected && !selected.startsWith('x:') && !selected.startsWith('fig:')) {
    opts.unshift(`<option value="guide:${esc(selected)}" ${defaultPersona.startsWith('guide:') ? 'selected' : ''}>이 유적 해설사</option>`);
  }
  return `<details class="ed-test">
    <summary>🗨 대화로 확인 <small>서버에 저장된 자료 기준 (저장 후 1분 안에 반영)</small></summary>
    <div class="tb">
      <select>${opts.join('')}</select>
      <input type="text" placeholder="질문 (예: 이곳은 언제 지어졌나요?)" />
      <button class="btn solid sm">묻기</button>
    </div>
    <div class="tr"></div>
  </details>`;
}
function bindTest() {
  const box = $('.ed-test', pane);
  const run = async () => {
    const q = $<HTMLInputElement>('input', box).value.trim();
    const out = $('.tr', box);
    if (!q) return;
    out.innerHTML = '<p class="muted">검색하고 답을 만드는 중…</p>';
    try {
      const d = await apiJson<{ text?: string; sources?: { name: string; quote: string }[]; retrieved?: string[] }>('/rag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figureId: $<HTMLSelectElement>('select', box).value, lines: [{ mine: true, text: q }] }),
      });
      out.innerHTML = `<p class="ans">${esc(d.text ?? '')}</p>
        <p class="muted">📚 인용된 근거: ${d.sources?.length ? d.sources.map((s) => `<b title="${esc(s.quote)}">${esc(s.name)}</b>`).join(', ') : '없음'}</p>
        <p class="muted">🔎 검색된 조각: ${esc((d.retrieved ?? []).join(' · '))}</p>`;
    } catch (e) {
      out.innerHTML = `<p class="err">실패: ${esc(String((e as Error).message ?? e))}</p>`;
    }
  };
  $('button', box).addEventListener('click', run);
  $('input', box).addEventListener('keydown', (e) => (e as KeyboardEvent).key === 'Enter' && run());
}

async function renderSource(id: string) {
  const s = byId.get(id)!;
  pane.innerHTML = `<div class="ed-loading">불러오는 중…</div>`;
  let orig = '';
  let head = s.name;
  try {
    [orig, head] = await Promise.all([originalText(id), chunkHead(id)]);
  } catch {
    pane.innerHTML = `<div class="ed-empty">원문을 불러오지 못했습니다.</div>`;
    return;
  }
  if (selected !== id) return;
  const cleanOrig = splitChunks(orig).join('\n\n');
  const linked = edits.extra.filter((x) => x.link === id);
  pane.innerHTML = `
    <button class="back btn ghost sm">← 목록</button>
    <div class="ph"><h2>${esc(s.name)}</h2><div class="meta">${esc(KIND_LABEL[s.kind])} · ${esc(s.sub)} · <code>${esc(id)}</code></div></div>
    <label class="chk"><input type="checkbox" class="hide" ${edits.hidden.includes(id) ? 'checked' : ''}/> RAG 에서 제외 (대화에서 이 자료를 찾지 않음)</label>
    <div class="fld">
      <div class="fl"><b>RAG 에 들어갈 글</b><span class="state"></span><button class="btn ghost sm reset">원문으로 되돌리기</button></div>
      <textarea class="txt" rows="14" spellcheck="false"></textarea>
      <small class="hint">빈 줄로 문단을 나누면 조각도 나뉩니다. 고치면 서버에 「${esc(targetDocName(id))}.md」 문서(대상: ${esc(id)})로 저장됩니다.</small>
    </div>
    <div class="chunks"></div>
    <details class="orig"><summary>원문 보기 (${esc(id.startsWith('fig:') ? '인물 소개' : '국가유산청·향토유산·관광지 데이터')})</summary><pre>${esc(cleanOrig || '(원문 없음)')}</pre></details>
    ${linked.length ? `<div class="linked"><b>이 자료에 연결된 추가 자료</b>${linked.map((x) => `<button class="btn outline sm" data-x="${esc(x.id)}">${esc(x.title || '(제목 없음)')}</button>`).join('')}</div>` : ''}
    <button class="btn outline sm addlinked">+ 이 ${s.kind === 'figure' ? '인물' : '유적'}에 연결된 자료 추가</button>
    ${testBox(id.startsWith('fig:') ? id.slice(4) : `guide:${id}`)}`;

  const ta = $<HTMLTextAreaElement>('.txt', pane);
  const state = $('.state', pane);
  const chunks = $('.chunks', pane);
  ta.value = edits.overrides[id] ?? cleanOrig;
  const refresh = () => {
    const edited = id in edits.overrides;
    state.textContent = edited ? '수정됨' : '원문';
    state.className = `state ${edited ? 'edit' : ''}`;
    chunkPreview(chunks, ta.value, head);
  };
  refresh();
  let t = 0;
  ta.addEventListener('input', () => {
    const v = ta.value.trim();
    if (v === cleanOrig.trim() || v === orig.trim()) delete edits.overrides[id];
    else edits.overrides[id] = ta.value.trim();
    refresh();
    clearTimeout(t);
    t = window.setTimeout(() => (saveDraft(), renderList()), 300);
  });
  $('.reset', pane).addEventListener('click', () => {
    if (!(id in edits.overrides) || !confirm('고친 글을 버리고 원문으로 되돌릴까요?')) return;
    delete edits.overrides[id];
    ta.value = cleanOrig;
    refresh();
    saveDraft();
    renderList();
  });
  $<HTMLInputElement>('.hide', pane).addEventListener('change', (e) => {
    edits.hidden = edits.hidden.filter((v) => v !== id);
    if ((e.target as HTMLInputElement).checked) edits.hidden.push(id);
    saveDraft();
    renderList();
  });
  pane.querySelectorAll<HTMLElement>('[data-x]').forEach((b) => b.addEventListener('click', () => select(`x:${b.dataset.x}`)));
  $('.addlinked', pane).addEventListener('click', () => addExtra(id));
  $('.back', pane).addEventListener('click', () => select(null));
  bindTest();
}

function addExtra(link?: string) {
  const x: Extra = { id: `new-${Date.now().toString(36)}`, title: '', text: '', ...(link ? { link } : {}) };
  edits.extra.push(x);
  saveDraft();
  select(`x:${x.id}`);
  $<HTMLInputElement>('.title', pane).focus();
}
$('[data-act=add]').addEventListener('click', () => addExtra());

function renderExtra(xid: string) {
  const x = edits.extra.find((v) => v.id === xid);
  if (!x) return select(null);
  const linkLabel = (id?: string) => (id && byId.get(id) ? `${byId.get(id)!.name} · ${id}` : '');
  pane.innerHTML = `
    <button class="back btn ghost sm">← 목록</button>
    <div class="ph"><h2>추가 자료</h2><div class="meta">서버 문서 <code>${esc(x.title || '(제목)')}.md</code></div></div>
    <div class="fld"><div class="fl"><b>제목</b><small>서버 문서 이름이 됩니다</small></div>
      <input class="title" type="text" maxlength="60" placeholder="예: 수원 화성 축성 일화" value="${esc(x.title)}" /></div>
    <div class="fld"><div class="fl"><b>연결할 유적·인물</b><small>(선택)</small></div>
      <input class="link" list="ed-sources" placeholder="이름으로 검색해 고르기 — 비우면 독립 자료" value="${esc(linkLabel(x.link))}" />
      <datalist id="ed-sources">${sources.map((s) => `<option value="${esc(`${s.name} · ${s.id}`)}">${esc(KIND_LABEL[s.kind])} · ${esc(s.sub)}</option>`).join('')}</datalist>
      <small class="hint">연결하면 그 인물·유적과 대화할 때 우선 검색되고, 답변의 📚 근거 버튼이 그 유적 카드로 이어집니다. 인물에 연결한 자료는 앱의 백엔드 RAG 참고 자료에도 들어갑니다.</small></div>
    <div class="fld two">
      <div><div class="fl"><b>출처</b><small>(선택)</small></div><input class="src" type="text" maxlength="60" placeholder="예: 난중일기" value="${esc(x.source ?? '')}" /></div>
      <div><div class="fl"><b>연도</b><small>(선택, 지식 경계 필터)</small></div><input class="yrs" type="text" maxlength="20" placeholder="예: 1592 또는 1592-1598" value="${esc(x.years ?? '')}" /></div>
    </div>
    <div class="fld"><div class="fl"><b>내용</b></div>
      <textarea class="txt" rows="14" placeholder="대화에 쓰일 사실·일화·설명을 적으세요. 빈 줄로 문단을 나눕니다."></textarea></div>
    <div class="chunks"></div>
    <button class="btn outline danger sm del">이 자료 삭제</button>
    ${testBox(x.link?.startsWith('fig:') ? x.link.slice(4) : x.link ? `guide:${x.link}` : ([...figures.keys()][0] ?? ''))}`;

  const ta = $<HTMLTextAreaElement>('.txt', pane);
  const chunks = $('.chunks', pane);
  ta.value = x.text;
  const refresh = () => chunkPreview(chunks, ta.value, x.title || '(제목)');
  refresh();
  let t = 0;
  const changed = () => {
    refresh();
    clearTimeout(t);
    t = window.setTimeout(() => (saveDraft(), renderList()), 300);
  };
  const field = (sel: string, set: (v: string) => void) =>
    $<HTMLInputElement>(sel, pane).addEventListener('input', (e) => {
      set((e.target as HTMLInputElement).value.trim());
      changed();
    });
  field('.title', (v) => (x.title = v));
  field('.src', (v) => (v ? (x.source = v) : delete x.source));
  field('.yrs', (v) => (v ? (x.years = v) : delete x.years));
  ta.addEventListener('input', () => {
    x.text = ta.value.trim();
    changed();
  });
  $<HTMLInputElement>('.link', pane).addEventListener('change', (e) => {
    const inp = e.target as HTMLInputElement;
    const id = inp.value.split(' · ').pop()?.trim() ?? '';
    if (!inp.value.trim()) delete x.link;
    else if (byId.has(id)) x.link = id;
    else {
      inp.value = linkLabel(x.link);
      return notice('목록에 있는 유적·인물을 골라 주세요.', 'err');
    }
    changed();
  });
  $('.del', pane).addEventListener('click', () => {
    if (!confirm(`'${x.title || '제목 없음'}' 자료를 삭제할까요? 서버에 저장하면 서버에서도 지워집니다.`)) return;
    edits.extra = edits.extra.filter((v) => v.id !== xid);
    saveDraft();
    select(null);
    pane.innerHTML = '<div class="ed-empty">삭제했습니다.</div>';
  });
  $('.back', pane).addEventListener('click', () => select(null));
  bindTest();
}

// ---------- 외부 RAG 인물 설정 ----------
function renderPersona(fid: string) {
  const f = figures.get(fid);
  if (!f) return select(null);
  const def = defaultPersona(f);
  const cur = personas[fid] ?? def;
  pane.innerHTML = `
    <button class="back btn ghost sm">← 목록</button>
    <div class="ph"><h2>${esc(f.name)} <small>외부 RAG 인물 설정</small></h2><div class="meta">${esc(f.title)}, ${esc(f.years)} · <code>${esc(fid)}</code> · <span class="state"></span></div></div>
    <div class="fld two">
      <div><div class="fl"><b>이름</b></div><input class="p-name" maxlength="40" /></div>
      <div><div class="fl"><b>시대</b></div><input class="p-era" maxlength="20" placeholder="조선 / 고려" /></div>
    </div>
    <div class="fld two">
      <div><div class="fl"><b>지식 경계 연도</b><small>세상을 떠난 해</small></div><input class="p-year" type="number" min="0" max="3000" /></div>
      <div><div class="fl"><b>검색어</b><small>공공기관 자료 검색에 쓰임</small></div><input class="p-kw" maxlength="40" /></div>
    </div>
    <div class="fld"><div class="fl"><b>신분·말투 지침</b><button class="btn ghost sm reset">기본값으로 되돌리기</button></div>
      <textarea class="txt p-text" rows="9"></textarea>
      <small class="hint">Gemini 프롬프트의 [상세 신분 및 말투 지침]에 그대로 들어갑니다. 예: 「조선의 수군절도사이다. 결연하고 강직한 어조(~하였소)를 쓴다.」</small></div>
    <details class="orig"><summary>앱 기본값 보기</summary><pre>${esc(`이름: ${def.name}\n시대: ${def.era}\n지식 경계: ${def.maxYear}\n검색어: ${def.keyword}\n\n${def.persona}`)}</pre></details>
    <p class="muted">저장하면 Android 앱이 다음 대화부터 이 설정을 씁니다(백엔드 RAG 방식). 보충 자료는 <b>RAG 자료</b> 탭에서 이 인물에 연결해 추가하세요.</p>`;

  const inp = {
    name: $<HTMLInputElement>('.p-name', pane),
    era: $<HTMLInputElement>('.p-era', pane),
    year: $<HTMLInputElement>('.p-year', pane),
    kw: $<HTMLInputElement>('.p-kw', pane),
    text: $<HTMLTextAreaElement>('.p-text', pane),
  };
  const fill = (p: Persona) => {
    inp.name.value = p.name;
    inp.era.value = p.era;
    inp.year.value = String(p.maxYear);
    inp.kw.value = p.keyword;
    inp.text.value = p.persona;
  };
  const state = $('.state', pane);
  const refresh = () => {
    state.textContent = personas[fid] ? '수정됨 (서버 값 사용)' : '기본값';
    state.className = `state ${personas[fid] ? 'edit' : ''}`;
  };
  fill(cur);
  refresh();
  let t = 0;
  const changed = () => {
    const p: Persona = {
      name: inp.name.value.trim() || def.name,
      era: inp.era.value.trim(),
      maxYear: Math.max(0, Math.min(3000, Number(inp.year.value) || def.maxYear)),
      keyword: inp.kw.value.trim() || def.keyword,
      persona: inp.text.value.trim() || def.persona,
    };
    if (JSON.stringify(p) === JSON.stringify(def)) delete personas[fid];
    else personas[fid] = p;
    refresh();
    clearTimeout(t);
    t = window.setTimeout(() => (saveDraft(), renderList()), 300);
  };
  Object.values(inp).forEach((el) => el.addEventListener('input', changed));
  $('.reset', pane).addEventListener('click', () => {
    if (!personas[fid] || !confirm('이 인물의 설정을 앱 기본값으로 되돌릴까요?')) return;
    delete personas[fid];
    fill(def);
    refresh();
    saveDraft();
    renderList();
  });
  $('.back', pane).addEventListener('click', () => select(null));
}

// ---------- 서버에 저장 ----------
interface Op {
  label: string;
  method: 'PUT' | 'DELETE';
  path: string;
  body?: string;
  headers?: Record<string, string>;
}

/** 바뀐 항목 → 서버 요청 목록 */
function plan(): Op[] {
  const ops: Op[] = [];
  const targets = new Set(
    ragChanged()
      .filter((k) => k[0] === 'o' || k[0] === 'h')
      .map((k) => k.slice(2)),
  );
  for (const id of targets) {
    const name = targetDocName(id);
    const s = byId.get(id)!;
    if (edits.hidden.includes(id)) {
      ops.push({ label: `${s.name} 제외`, method: 'PUT', path: docPath(name), body: docText([['출처', 'RAG 자료 편집기'], ['대상', id], ['제외', '예']], '') });
    } else if (id in edits.overrides) {
      ops.push({ label: `${s.name} 글 바꿈`, method: 'PUT', path: docPath(name), body: docText([['출처', 'RAG 자료 편집기 (고침)'], ['대상', id]], edits.overrides[id]) });
    } else if (targetDoc.has(id)) {
      ops.push({ label: `${s.name} 원문으로`, method: 'DELETE', path: docPath(name) });
    }
  }

  const titles = new Map<string, string>();
  for (const x of edits.extra) {
    if (!x.title || !x.text) throw new Error(`추가 자료 '${x.title || '(제목 없음)'}' 의 제목과 내용을 채워 주세요.`);
    const k = nameKey(x.title);
    if (titles.has(k)) throw new Error(`추가 자료 제목 ${josa(`'${x.title}'`, '이/가')} 겹칩니다. 서버 문서 이름이므로 서로 달라야 합니다.`);
    if ([...targetDoc.values()].some((n) => nameKey(n) === k)) throw new Error(`${josa(`'${x.title}'`, '은/는')} 고친 글 문서 이름과 겹칩니다. 다른 제목을 써 주세요.`);
    titles.set(k, x.id);
  }
  for (const key of ragChanged().filter((k) => k[0] === 'x')) {
    const id = key.slice(2);
    const before = base.extra.find((v) => v.id === id);
    const x = edits.extra.find((v) => v.id === id);
    if (x) {
      const link = x.link && byId.has(x.link) ? x.link : undefined;
      ops.push({
        label: `추가 자료 ${x.title}`,
        method: 'PUT',
        path: docPath(x.title),
        body: docText([['출처', x.source], ['연도', x.years], ['연결', link]], x.text),
      });
    }
    // 제목이 바뀌었거나 지운 자료는 예전 문서를 지운다 (새 제목이 같은 열쇠면 덮어쓰기로 충분)
    if (before && (!x || nameKey(before.title) !== nameKey(x.title))) {
      ops.push({ label: `추가 자료 ${before.title} 삭제`, method: 'DELETE', path: docPath(before.title) });
    }
  }

  if (personaChanged().length) {
    ops.push({
      label: `외부 RAG 인물 설정 ${personaChanged().length}명`,
      method: 'PUT',
      path: '/store/personas.json',
      body: JSON.stringify({ figures: personas }),
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return ops;
}

async function publish() {
  if (!changedCount()) return;
  let ops: Op[];
  try {
    ops = plan();
  } catch (e) {
    return notice(`❌ ${esc((e as Error).message)}`, 'err');
  }
  const btn = $<HTMLButtonElement>('[data-act=publish]');
  btn.disabled = true;
  btn.textContent = '저장 중…';
  const done: string[] = [];
  const warns: string[] = [];
  try {
    for (const op of ops) {
      const r = await api(op.path, { method: op.method, body: op.body, headers: op.headers ?? {} });
      const d = (await r.json().catch(() => ({}))) as { error?: string; warning?: string };
      if (!r.ok && !(op.method === 'DELETE' && r.status === 404)) throw new Error(`${op.label}: ${d.error ?? `서버 오류 ${r.status}`}`);
      if (d.warning) warns.push(`${op.label}: ${d.warning}`);
      done.push(op.label);
    }
    safeSet(localStorage, DRAFT_KEY, null);
    await reload();
    notice(`✅ ${done.length}건을 서버에 저장했습니다. 1분 안에 RAG 서버 대화와 앱의 백엔드 RAG 에 쓰입니다.${warns.length ? `<br/>⚠ ${warns.map(esc).join('<br/>⚠ ')}` : ''}`, 'ok');
  } catch (e) {
    notice(`❌ 저장하지 못했습니다${done.length ? ` (먼저 ${done.length}건은 저장됨)` : ''}: ${esc(String((e as Error).message ?? e))}`, 'err');
    if (done.length) {
      // 일부만 저장된 경우: 서버 상태를 다시 받고, 남은 변경은 초안으로 다시 얹는다
      const keep = { edits: clone(edits), personas: clone(personas) };
      await reload().catch(() => undefined);
      for (const k of [...allKeys(base, keep.edits)]) applyKey(edits, keep.edits, k);
      personas = keep.personas;
      saveDraft();
      renderList();
    }
  } finally {
    btn.textContent = '서버에 저장';
    renderHeader();
  }
}
$('[data-act=publish]').addEventListener('click', () => void publish());

function modal(html: string): HTMLElement {
  const m = document.createElement('div');
  m.className = 'ed-modal';
  m.innerHTML = `<div class="box">${html}</div>`;
  m.addEventListener('click', (e) => e.target === m && m.remove());
  document.body.appendChild(m);
  return m;
}


// 작업본 파일 내려받기·불러오기 (다른 사람에게 작업을 넘길 때)
$('[data-act=io]').addEventListener('click', () => {
  const m = modal(`
    <h3>파일로 주고받기</h3>
    <p>현재 작업본을 JSON 파일로 내려받아 다른 사람에게 넘기거나, 받은 작업본을 불러와 이어서 고친 뒤 서버에 저장할 수 있습니다.</p>
    <div class="row">
      <button class="btn outline" data-dl>작업본 내려받기</button>
      <label class="btn outline">파일 불러오기<input type="file" accept="application/json,.json" hidden /></label>
    </div>
    <div class="row"><button class="btn ghost danger" data-drop>저장 안 한 변경 모두 버리기</button><button class="btn ghost" data-close>닫기</button></div>`);
  $('[data-close]', m).addEventListener('click', () => m.remove());
  $('[data-dl]', m).addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ edits, personas }, null, 2) + '\n'], { type: 'application/json' }));
    a.download = 'rag-editor-work.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $<HTMLInputElement>('input[type=file]', m).addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const v = JSON.parse(await f.text()) as { edits?: Partial<Edits>; personas?: Record<string, Persona> } & Partial<Edits>;
      // 예전 rag-edits.json 형식(overrides·hidden·extra)도 받는다
      const e2 = { ...emptyEdits(), ...(v.edits ?? v) } as Edits;
      if (typeof e2.overrides !== 'object' || !Array.isArray(e2.hidden) || !Array.isArray(e2.extra)) throw new Error();
      e2.extra = e2.extra.map((x) => ({ ...x, id: base.extra.some((b) => b.id === x.id) ? x.id : `new-${x.id}` }));
      edits = { overrides: e2.overrides, hidden: e2.hidden, extra: e2.extra };
      if (v.personas) personas = v.personas;
      saveDraft();
      renderList();
      select(null);
      m.remove();
      notice(`파일을 불러왔습니다. 저장 안 한 변경 ${changedCount()}건.`, 'ok');
    } catch {
      notice('편집기 작업본 형식이 아닙니다.', 'err');
    }
  });
  $('[data-drop]', m).addEventListener('click', () => {
    if (!confirm('저장하지 않은 변경을 모두 버릴까요?')) return;
    edits = clone(base);
    personas = clone(personaBase);
    saveDraft();
    renderList();
    select(null);
    m.remove();
  });
});

window.addEventListener('beforeunload', (e) => {
  if (changedCount()) e.preventDefault(); // 초안은 저장돼 있지만 서버 저장 전임을 알린다
});

// ---------- 시작 ----------
async function reload() {
  const [server, ps] = await Promise.all([loadServer(), apiJson<{ figures?: Record<string, Persona> }>('/store/personas.json')]);
  base = server;
  edits = clone(server);
  personaBase = ps.figures ?? {};
  personas = clone(personaBase);
  saveDraft();
  renderList();
  if (selected) select(selected);
}

async function start() {
  listEl.innerHTML = '<p class="more">자료 목록을 불러오는 중…</p>';
  const [index, figs] = await Promise.all([json<HeritageIndex>('index.json'), json<{ figures: Figure[] }>('figures.json')]);
  for (const f of figs.figures) {
    figures.set(f.id, f);
    sources.push({ id: `fig:${f.id}`, name: f.name, sub: `${f.title}, ${f.years}`, kind: 'figure' });
  }
  for (const it of index.items) {
    sources.push({ id: it.id, name: it.name, sub: [it.designation, it.city].filter(Boolean).join(' · '), kind: it.local ? 'local' : it.tour ? 'tour' : 'heritage' });
  }
  sources.forEach((s) => byId.set(s.id, s));

  try {
    await reload();
  } catch (e) {
    notice(`서버 자료를 불러오지 못했습니다: ${esc(String((e as Error).message ?? e))}. 원본 데이터만 보여 줍니다.`, 'err');
  }
  const draft = JSON.parse(safeGet(localStorage, DRAFT_KEY) ?? 'null') as {
    base: Edits;
    edits: Edits;
    personaBase?: Record<string, Persona>;
    personas?: Record<string, Persona>;
  } | null;
  if (draft) {
    // 초안의 변경분을 최신 서버 상태 위에 다시 얹는다
    const keys = [...allKeys(draft.base, draft.edits)].filter((k) => keyValue(draft.base, k) !== keyValue(draft.edits, k));
    for (const k of keys) applyKey(edits, draft.edits, k);
    let pn = 0;
    for (const id of new Set([...Object.keys(draft.personaBase ?? {}), ...Object.keys(draft.personas ?? {})])) {
      if (JSON.stringify(draft.personaBase?.[id]) === JSON.stringify(draft.personas?.[id])) continue;
      if (draft.personas?.[id]) personas[id] = draft.personas[id];
      else delete personas[id];
      pn++;
    }
    if (keys.length + pn) notice(`저장하지 않은 초안 ${keys.length + pn}건을 이어서 불러왔습니다. 「서버에 저장」을 누르면 저장됩니다.`);
  }
  saveDraft();
  renderList();
}
start().catch((e) => {
  listEl.innerHTML = `<p class="more err">자료를 불러오지 못했습니다: ${esc(String(e))}</p>`;
});
