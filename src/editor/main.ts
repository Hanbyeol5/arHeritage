/**
 * RAG 자료 편집기 (/editor/) — 웹앱과 분리된 관리 도구. 웹앱 메뉴에는 링크가 없다.
 *
 * 원본 데이터는 그대로 두고 public/data/rag-edits.json 하나에 수정 사항을 모은다.
 *   · 유적·인물 글 바꾸기(overrides) · RAG 에서 빼기(hidden) · 새 자료 추가(extra)
 * 작업 내용은 이 브라우저에 초안으로 자동 저장되고, 「GitHub 에 반영」을 누르면
 * GitHub API 로 rag-edits.json 을 커밋한다 → 배포 워크플로가 RAG 색인을 다시 만들어 게시 →
 * Worker(/rag)는 1분 안에 새 색인 버전을 읽는다.
 */
import './editor.css';
import { emptyEdits, splitChunks, type RagEdits } from '../../worker/src/ragText.ts';
import type { Figure, HeritageDetail, HeritageIndex } from '../types.ts';

const BASE = import.meta.env.BASE_URL;
const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '');
const FILE = 'public/data/rag-edits.json';
const DRAFT_KEY = 'yeoksadam-editor:draft';
const CONF_KEY = 'yeoksadam-editor:conf';
const TOKEN_KEY = 'yeoksadam-editor:token';

type Kind = 'heritage' | 'local' | 'tour' | 'figure';
interface Source {
  id: string;
  name: string;
  sub: string;
  kind: Kind;
}
type Extra = RagEdits['extra'][number];

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
const normEdits = (e: Partial<RagEdits> | undefined): RagEdits => ({ ...emptyEdits(), ...(e ?? {}) });

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
/** 초안의 기준(마지막으로 받은 게시본)과 현재 작업본 */
let base: RagEdits = emptyEdits();
let edits: RagEdits = emptyEdits();
let selected: string | null = null; // 출처 id 또는 "x:<추가 자료 id>"
let query = '';
let filter = 'all';

const conf = (() => {
  const saved = JSON.parse(safeGet(localStorage, CONF_KEY) ?? '{}') as { repo?: string };
  // https://<owner>.github.io/<repo>/editor/ → owner/repo
  const owner = location.hostname.endsWith('.github.io') ? location.hostname.split('.')[0] : 'samcho93';
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return { repo: saved.repo || `${owner}/${repo && repo !== 'editor' ? repo : 'arHeritage'}` };
})();
const token = () => safeGet(sessionStorage, TOKEN_KEY) ?? safeGet(localStorage, TOKEN_KEY) ?? '';

// ---------- 차이 계산 (o: 글 바꾸기, h: 제외, x: 추가 자료) ----------
function keyValue(e: RagEdits, key: string): string | undefined {
  const id = key.slice(2);
  if (key.startsWith('o:')) return e.overrides[id];
  if (key.startsWith('h:')) return e.hidden.includes(id) ? '1' : undefined;
  const x = e.extra.find((v) => v.id === id);
  return x && JSON.stringify(x);
}
function allKeys(...list: RagEdits[]): Set<string> {
  const keys = new Set<string>();
  for (const e of list) {
    Object.keys(e.overrides).forEach((id) => keys.add(`o:${id}`));
    e.hidden.forEach((id) => keys.add(`h:${id}`));
    e.extra.forEach((x) => keys.add(`x:${x.id}`));
  }
  return keys;
}
const changedKeys = () => [...allKeys(base, edits)].filter((k) => keyValue(base, k) !== keyValue(edits, k));

/** from 의 key 값을 to 에 옮긴다 (없으면 to 에서도 지운다) */
function applyKey(to: RagEdits, from: RagEdits, key: string) {
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
  safeSet(localStorage, DRAFT_KEY, changedKeys().length ? JSON.stringify({ base, edits }) : null);
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

// ---------- 화면 ----------
const root = document.getElementById('app')!;
root.innerHTML = `
  <header class="ed-top">
    <div class="ed-brand"><span class="seal">談</span><div><b>RAG 자료 편집기</b><small>역사담 인물 대화(RAG 서버)가 참고하는 자료</small></div></div>
    <div class="ed-status"></div>
    <div class="ed-actions">
      <button class="btn ghost" data-act="io" title="초안 내려받기·불러오기">파일</button>
      <button class="btn ghost" data-act="conf">GitHub 설정</button>
      <button class="btn solid" data-act="publish">GitHub 에 반영</button>
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
    <section class="ed-pane"><div class="ed-empty">왼쪽에서 유적·인물을 고르거나 <b>새 자료</b>를 추가하세요.<br/><br/>
      <small>여기서 고친 내용은 <b>RAG 서버</b> 대화 방식에만 쓰입니다. 원본 데이터는 바뀌지 않으며, 언제든 원문으로 되돌릴 수 있습니다.</small></div></section>
  </main>`;

const $ = <T extends HTMLElement>(sel: string, el: ParentNode = root) => el.querySelector<T>(sel)!;
const listEl = $('.ed-list');
const pane = $('.ed-pane');

function notice(html: string, kind: 'info' | 'ok' | 'err' = 'info') {
  const n = $('.ed-notice');
  n.className = `ed-notice ${kind}`;
  n.innerHTML = `<span>${html}</span><button aria-label="닫기">✕</button>`;
  n.hidden = false;
  n.querySelector('button')!.onclick = () => (n.hidden = true);
}

function renderHeader() {
  const n = changedKeys().length;
  const e = edits;
  $('.ed-status').innerHTML = `
    <span>글 바꿈 <b>${Object.keys(e.overrides).length}</b></span>
    <span>제외 <b>${e.hidden.length}</b></span>
    <span>추가 <b>${e.extra.length}</b></span>
    <span class="${n ? 'dirty' : ''}">${n ? `반영 안 한 변경 <b>${n}</b>건` : '모두 반영됨'}</span>`;
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

function select(id: string | null) {
  selected = id;
  root.classList.toggle('picked', !!id);
  renderList();
  if (!id) return;
  if (id.startsWith('x:')) renderExtra(id.slice(2));
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
    <summary>🗨 대화로 확인 <small>배포된(반영 완료) 자료 기준</small></summary>
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
    if (!API_BASE) return void (out.textContent = 'API 주소(VITE_API_BASE)가 설정되지 않은 빌드입니다.');
    out.innerHTML = '<p class="muted">검색하고 답을 만드는 중…</p>';
    try {
      const res = await fetch(`${API_BASE}/rag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ figureId: $<HTMLSelectElement>('select', box).value, lines: [{ mine: true, text: q }] }),
      });
      const d = (await res.json()) as { text?: string; error?: string; sources?: { name: string; quote: string }[]; retrieved?: string[] };
      if (!res.ok) throw new Error(d.error ?? String(res.status));
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
      <small class="hint">빈 줄로 문단을 나누면 조각도 나뉩니다. 틀린 내용을 고치거나, 대화에 쓰일 사실·일화를 덧붙이세요.</small>
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
  const x: Extra = { id: Date.now().toString(36), title: '', text: '', ...(link ? { link } : {}) };
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
    <div class="ph"><h2>추가 자료</h2><div class="meta"><code>u:${esc(x.id)}</code></div></div>
    <div class="fld"><div class="fl"><b>제목</b></div>
      <input class="title" type="text" maxlength="60" placeholder="예: 수원 화성 축성 일화" value="${esc(x.title)}" /></div>
    <div class="fld"><div class="fl"><b>연결할 유적·인물</b><small>(선택)</small></div>
      <input class="link" list="ed-sources" placeholder="이름으로 검색해 고르기 — 비우면 독립 자료" value="${esc(linkLabel(x.link))}" />
      <datalist id="ed-sources">${sources.map((s) => `<option value="${esc(`${s.name} · ${s.id}`)}">${esc(KIND_LABEL[s.kind])} · ${esc(s.sub)}</option>`).join('')}</datalist>
      <small class="hint">연결하면 그 인물·유적과 대화할 때 우선 검색되고, 답변의 📚 근거 버튼이 그 유적 카드로 이어집니다.</small></div>
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
  $<HTMLInputElement>('.title', pane).addEventListener('input', (e) => {
    x.title = (e.target as HTMLInputElement).value.trim();
    changed();
  });
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
    if (!confirm(`'${x.title || '제목 없음'}' 자료를 삭제할까요?`)) return;
    edits.extra = edits.extra.filter((v) => v.id !== xid);
    saveDraft();
    select(null);
    pane.innerHTML = '<div class="ed-empty">삭제했습니다.</div>';
  });
  $('.back', pane).addEventListener('click', () => select(null));
  bindTest();
}

// ---------- GitHub 반영 ----------
const b64encode = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
const b64decode = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

async function gh(path: string, init: RequestInit = {}) {
  return fetch(`https://api.github.com/repos/${conf.repo}/${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token()}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

async function publish() {
  const keys = changedKeys();
  if (!keys.length) return;
  if (!token()) return openConf('먼저 GitHub 토큰을 넣어 주세요.');
  const btn = $<HTMLButtonElement>('[data-act=publish]');
  btn.disabled = true;
  btn.textContent = '반영 중…';
  try {
    // 최신 게시본을 받아 내가 바꾼 항목만 덮어쓴다 (다른 사람이 먼저 저장한 변경은 유지)
    const cur = await gh(`contents/${FILE}`);
    if (cur.status === 401) throw new Error('토큰이 올바르지 않거나 만료되었습니다.');
    if (cur.status === 404 && !(await gh('')).ok) throw new Error(`저장소 ${conf.repo} 에 접근할 수 없습니다.`);
    const file = cur.ok ? ((await cur.json()) as { sha: string; content: string }) : undefined;
    const remote = normEdits(file ? (JSON.parse(b64decode(file.content)) as Partial<RagEdits>) : undefined);
    const merged = clone(remote);
    for (const k of keys) applyKey(merged, edits, k);
    merged.updatedAt = new Date().toISOString();
    const body = JSON.stringify(merged, null, 2) + '\n';
    const put = await gh(`contents/${FILE}`, {
      method: 'PUT',
      body: JSON.stringify({ message: `RAG 자료 수정 ${keys.length}건 (RAG 자료 편집기)`, content: b64encode(body), ...(file ? { sha: file.sha } : {}) }),
    });
    if (put.status === 403 || put.status === 404) throw new Error('토큰에 이 저장소의 Contents 쓰기 권한이 없습니다.');
    if (put.status === 409) throw new Error('그 사이에 다른 저장이 있었습니다. 다시 눌러 주세요.');
    if (!put.ok) throw new Error(`GitHub 오류 ${put.status}`);
    const res = (await put.json()) as { commit: { html_url: string } };
    base = clone(merged);
    edits = clone(merged);
    saveDraft();
    renderList();
    if (selected) select(selected);
    notice(
      `✅ ${keys.length}건을 반영했습니다. 배포(약 2~3분)가 끝나면 RAG 서버 대화에 쓰입니다. <a href="${res.commit.html_url}" target="_blank" rel="noopener">커밋</a> · <a href="https://github.com/${conf.repo}/actions" target="_blank" rel="noopener">배포 진행 보기</a>`,
      'ok',
    );
  } catch (e) {
    notice(`❌ 반영하지 못했습니다: ${esc(String((e as Error).message ?? e))}`, 'err');
  } finally {
    btn.textContent = 'GitHub 에 반영';
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

function openConf(msg = '') {
  const remembered = !!safeGet(localStorage, TOKEN_KEY);
  const m = modal(`
    <h3>GitHub 설정</h3>
    ${msg ? `<p class="err">${esc(msg)}</p>` : ''}
    <label>저장소<input class="repo" value="${esc(conf.repo)}" placeholder="owner/repo" /></label>
    <label>토큰 (fine-grained personal access token)<input class="tok" type="password" autocomplete="off" value="${esc(token())}" placeholder="github_pat_…" /></label>
    <label class="chk"><input type="checkbox" class="rem" ${remembered ? 'checked' : ''}/> 이 브라우저에 기억하기 (공용 PC 에서는 끄세요)</label>
    <ol class="help">
      <li>GitHub → Settings → Developer settings → <b>Fine-grained tokens</b> → Generate new token</li>
      <li>Repository access: <b>Only select repositories</b> → 이 저장소만</li>
      <li>Permissions → Repository permissions → <b>Contents: Read and write</b></li>
      <li>만든 토큰을 위에 붙여 넣기. 토큰은 이 브라우저에만 저장되고 GitHub API 로만 보냅니다.</li>
    </ol>
    <div class="row"><button class="btn ghost" data-close>취소</button><button class="btn solid" data-save>저장</button></div>`);
  $('[data-close]', m).addEventListener('click', () => m.remove());
  $('[data-save]', m).addEventListener('click', () => {
    conf.repo = $<HTMLInputElement>('.repo', m).value.trim() || conf.repo;
    safeSet(localStorage, CONF_KEY, JSON.stringify({ repo: conf.repo }));
    const tok = $<HTMLInputElement>('.tok', m).value.trim();
    const rem = $<HTMLInputElement>('.rem', m).checked;
    safeSet(localStorage, TOKEN_KEY, tok && rem ? tok : null);
    safeSet(sessionStorage, TOKEN_KEY, tok && !rem ? tok : null);
    m.remove();
    notice('설정을 저장했습니다.', 'ok');
  });
}
$('[data-act=conf]').addEventListener('click', () => openConf());

// 초안 파일 내려받기·불러오기 (토큰 없이 작업을 넘길 때)
$('[data-act=io]').addEventListener('click', () => {
  const m = modal(`
    <h3>파일로 주고받기</h3>
    <p>GitHub 토큰 없이 작업할 때, 현재 작업본을 <code>rag-edits.json</code> 으로 내려받아 관리자에게 보내거나 저장소의 <code>${FILE}</code> 에 직접 올릴 수 있습니다.</p>
    <div class="row">
      <button class="btn outline" data-dl>작업본 내려받기</button>
      <label class="btn outline">파일 불러오기<input type="file" accept="application/json,.json" hidden /></label>
    </div>
    <div class="row"><button class="btn ghost danger" data-drop>반영 안 한 변경 모두 버리기</button><button class="btn ghost" data-close>닫기</button></div>`);
  $('[data-close]', m).addEventListener('click', () => m.remove());
  $('[data-dl]', m).addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(edits, null, 2) + '\n'], { type: 'application/json' }));
    a.download = 'rag-edits.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $<HTMLInputElement>('input[type=file]', m).addEventListener('change', async (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (!f) return;
    try {
      const v = normEdits(JSON.parse(await f.text()) as Partial<RagEdits>);
      if (typeof v.overrides !== 'object' || !Array.isArray(v.hidden) || !Array.isArray(v.extra)) throw new Error();
      edits = v;
      saveDraft();
      renderList();
      select(null);
      m.remove();
      notice(`파일을 불러왔습니다. 반영 안 한 변경 ${changedKeys().length}건.`, 'ok');
    } catch {
      notice('rag-edits.json 형식이 아닙니다.', 'err');
    }
  });
  $('[data-drop]', m).addEventListener('click', () => {
    if (!confirm('반영하지 않은 변경을 모두 버릴까요?')) return;
    edits = clone(base);
    saveDraft();
    renderList();
    select(null);
    m.remove();
  });
});

window.addEventListener('beforeunload', (e) => {
  if (changedKeys().length) e.preventDefault(); // 초안은 저장돼 있지만 반영 전임을 알린다
});

// ---------- 시작 ----------
async function start() {
  listEl.innerHTML = '<p class="more">자료 목록을 불러오는 중…</p>';
  const [index, figs, published] = await Promise.all([
    json<HeritageIndex>('index.json'),
    json<{ figures: Figure[] }>('figures.json'),
    json<Partial<RagEdits>>(`rag-edits.json?t=${Date.now()}`).catch(() => undefined),
  ]);
  for (const f of figs.figures) {
    figures.set(f.id, f);
    sources.push({ id: `fig:${f.id}`, name: f.name, sub: `${f.title}, ${f.years}`, kind: 'figure' });
  }
  for (const it of index.items) {
    sources.push({ id: it.id, name: it.name, sub: [it.designation, it.city].filter(Boolean).join(' · '), kind: it.local ? 'local' : it.tour ? 'tour' : 'heritage' });
  }
  sources.forEach((s) => byId.set(s.id, s));

  base = normEdits(published);
  edits = clone(base);
  const draft = JSON.parse(safeGet(localStorage, DRAFT_KEY) ?? 'null') as { base: RagEdits; edits: RagEdits } | null;
  if (draft) {
    // 초안의 변경분을 최신 게시본 위에 다시 얹는다
    const draftBase = normEdits(draft.base);
    const draftEdits = normEdits(draft.edits);
    const keys = [...allKeys(draftBase, draftEdits)].filter((k) => keyValue(draftBase, k) !== keyValue(draftEdits, k));
    for (const k of keys) applyKey(edits, draftEdits, k);
    if (keys.length) notice(`반영하지 않은 초안 ${keys.length}건을 이어서 불러왔습니다. 「GitHub 에 반영」을 누르면 게시됩니다.`);
  }
  saveDraft();
  renderList();
}
start().catch((e) => {
  listEl.innerHTML = `<p class="more err">자료를 불러오지 못했습니다: ${esc(String(e))}</p>`;
});
