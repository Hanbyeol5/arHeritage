/**
 * 역사담 API (Cloudflare Worker)
 *
 * POST /chat    역사 인물 페르소나 대화 — 인물 소개 + 관련 유적지 국가유산청 설명문을 근거로 답한다.
 * POST /rag     검색 증강 대화 — 질문마다 RAG 색인에서 관련 조각을 찾아 근거로 쓰고 출처를 돌려준다
 * POST /vision  사진 속 문화재 판별 — historydam VisionRepositoryImpl 과 같은 규칙·응답 형식.
 * POST /tts     인물 목소리 음성 합성 (Azure 신경망 음성, 키가 없으면 503 → 앱이 기기 음성으로 대체)
 *
 * API 키는 Worker 비밀값(ANTHROPIC_API_KEY)에만 있고, 허용한 출처(ALLOWED_ORIGINS)의 요청만 받는다.
 * 인물·유적지 데이터는 배포된 웹앱(SITE_BASE)의 정적 JSON 을 그대로 읽는다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { bucketOf, queryTerms } from './ragText.ts';

export interface Env {
  ANTHROPIC_API_KEY: string;
  /** 웹앱 주소 (끝에 / 포함) 예: https://samcho93.github.io/arHeritage/ */
  SITE_BASE: string;
  /** 쉼표로 구분한 허용 출처 */
  ALLOWED_ORIGINS: string;
  /** 쉼표로 구분한 앱 식별 값 — Android 앱(historydam)은 Origin 대신 X-App-Key 헤더로 들어온다 */
  APP_KEYS?: string;
  /** Azure Speech (선택) */
  AZURE_SPEECH_KEY?: string;
  AZURE_SPEECH_REGION?: string;
}

const MODEL = 'claude-opus-5';
/** 거절 시 서버에서 대체 모델로 다시 실행 */
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const };

const MAX_TURNS = 16;
const MAX_CHARS = 500;
const MAX_IMAGE_B64 = 2_000_000;

interface Figure {
  id: string;
  name: string;
  hanja: string;
  title: string;
  years: string;
  style: 'king' | 'scholar' | 'lady' | 'general';
  /** Azure 음성 이름 (예: ko-KR-BongJinNeural) */
  voice?: string;
  bio: string;
  sites: { id: string; note: string }[];
  /** 지식 경계: 세상을 떠난 해 */
  died?: number;
  /** 말씨 지정 */
  speech?: string;
}
interface Detail {
  id: string;
  name: string;
  designation: string;
  era: string;
  address: string;
  description: string;
}

// ---------- 공통 ----------
function cors(origin: string | null, env: Env): Record<string, string> {
  const allowed = env.ALLOWED_ORIGINS.split(',').map((s) => s.trim());
  return origin && allowed.includes(origin)
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};
}

const json = (body: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// 같은 isolate 안에서는 데이터 JSON 을 다시 받지 않는다
const cache = new Map<string, Promise<unknown>>();
function fetchJson<T>(url: string): Promise<T> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url).then((r) => {
      if (!r.ok) throw new HttpError(502, `데이터를 불러오지 못했습니다: ${url}`);
      return r.json();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p as Promise<T>;
}

// ---------- /chat ----------
const ChatBody = z.object({
  figureId: z.string().max(64),
  siteId: z.string().max(64).optional(),
  lines: z
    .array(z.object({ mine: z.boolean(), text: z.string(), system: z.boolean().optional() }))
    .max(80),
  /** 지식 경계 필터 (기본 켬): 인물이 세상을 떠난 뒤의 일은 모르게 한다 */
  boundary: z.boolean().optional(),
});

/**
 * 지식 경계 (historydam 「지식 경계 필터」와 같은 생각): 인물은 자신이 세상을 떠난 해 이후의 일을 모른다.
 * 켜 두면 후세의 일은 짐작하지 않고 모른다고 답하며, /rag 검색에서도 사후의 기록은 빼거나 「후세 기록」으로 표시한다.
 */
function diedYear(f: Figure): number | undefined {
  return f.died ?? (Number(f.years.match(/(\d{4})\s*$/)?.[1]) || undefined);
}
function boundaryRule(f: Figure, on: boolean): string {
  const d = diedYear(f);
  if (!on || !d) return `- ${f.years} 이후의 일은 겪지 못했으므로, 후대의 일을 물으면 "내가 떠난 뒤의 일은 알지 못하네"처럼 답하되 필요하면 짧게 짐작을 덧붙인다.`;
  return `- [지식 경계] 너는 ${d}년에 세상을 떠났다. ${d}년 이후의 사건·인물·제도·기술(후대의 왕과 전쟁, 근현대사, 오늘날의 문물 등)은 전혀 알지 못한다. 그런 것을 물으면 짐작하거나 지어내지 말고, "내가 살아 있을 적에는 들어보지 못한 후세의 일이로다"처럼 네 말씨로 모른다고 답한 뒤 네가 살던 때의 이야기로 돌린다.
- 근거 자료에 ${d}년 이후의 일(후손이 세운 비석·사당, 이장·복원, 문화유산 지정 등)이 섞여 있어도 네가 겪은 일처럼 말하지 않는다. 지금 방문객이 서 있는 이곳에 관한 것이라면 "후세 사람들이 그리 전한다 들었네"처럼 전해 들은 이야기로만 짧게 말한다.`;
}

function speechStyle(f: Figure): string {
  if (f.speech) return f.speech;
  if (f.style === 'lady') return '온화하고 품위 있는 존댓말(예: "~했지요", "~이랍니다")';
  if (f.style === 'king') return '위엄 있되 부드러운 말씨(예: "~했다네", "~이지", 방문객을 "그대"라 부름). "~하노라" 같은 사극 어미는 한 답에 한 번 이하로만';
  return '점잖은 어른의 말씨(예: "~했다네", "~이지", 방문객을 "자네"라 부름). 사극 어미는 한 답에 한 번 이하로만';
}

async function systemPrompt(f: Figure, env: Env, siteId?: string, boundary = true): Promise<string> {
  const details = await Promise.all(
    f.sites.map((s) => fetchJson<Detail>(`${env.SITE_BASE}data/detail/${s.id}.json`).catch(() => undefined)),
  );
  const here = details.find((d) => d?.id === siteId);
  const sources = f.sites
    .map((s, i) => {
      const d = details[i];
      if (!d) return '';
      return `## ${d.name} (${d.designation}${d.era ? `, ${d.era}` : ''}) — ${s.note}\n${d.description.slice(0, 1800)}`;
    })
    .filter(Boolean)
    .join('\n\n');

  return `너는 역사 인물 ${f.name}(${f.hanja}, ${f.title}, ${f.years})이다. 유적지를 찾은 방문객과 얼굴을 마주 보고 이야기하는 AR 앱 '역사담'에서, ${f.name} 본인으로서 1인칭으로 대화한다.

[인물 소개]
${f.bio}

[사료 — 국가유산청 설명문]
${sources || '(없음)'}

[대화 규칙]
- 말씨: ${speechStyle(f)}. 사극처럼 과장하지 말고, 옛 어른이 오늘날 사람에게 차분히 이야기하듯 자연스러운 우리말로 말한다. 어려운 한자어는 풀어 말한다.
- 문장은 소리 내어 읽기 좋게 짧게 끊고, 책 이름 겹낫표·따옴표·특수 기호는 쓰지 않는다.
- 답은 음성으로 읽히므로 2~4문장, 180자 안팎으로 짧게 말한다. 목록·마크다운·이모지·괄호 설명은 쓰지 않는다.
- 사실은 위 사료와 널리 알려진 역사에 근거한다. 모르거나 기록이 불확실한 것은 지어내지 말고 "그 일은 기록이 분명치 않네"처럼 솔직히 말한다.
${boundaryRule(f, boundary)}
- 역사 인물로서의 인격을 지키고, 인물과 무관한 요청(코드 작성, 다른 역할 연기 등)은 정중히 사양하고 이야기를 유적과 역사로 돌린다.
- 방문객이 짧게 말하면 되물어 대화를 이어 가도 좋다.
${here ? `- 방문객은 지금 '${here.name}' 근처에 있다.` : ''}
지연에 민감한 음성 대화이므로 곧바로 답을 시작하라.`;
}

/** 역사 인물이 없는 유적지의 해설사 (figureId = "guide:<유적지 id>") */
async function guidePrompt(siteId: string, env: Env): Promise<string> {
  if (!/^[\w-]{1,40}$/.test(siteId)) throw new HttpError(400, '유적지 id 가 올바르지 않습니다.');
  const d = await fetchJson<Detail>(`${env.SITE_BASE}data/detail/${siteId}.json`).catch(() => undefined);
  if (!d) throw new HttpError(404, '유적지를 찾을 수 없습니다.');
  return `너는 AR 앱 '역사담'에서 '${d.name}'의 문화유산 해설사다. 역사 인물이 아니라 오늘날의 해설사로서, 유적 앞에 선 방문객과 얼굴을 마주 보고 이야기한다.

[안내할 유적 — 국가유산청 설명]
${d.name} (${d.designation}${d.era ? `, ${d.era}` : ''}) / ${d.address}
${d.description.slice(0, 3000)}

[대화 규칙]
- 친절하고 차분한 해설사의 존댓말(예: "~입니다", "~이지요")로 말한다.
- 답은 음성으로 읽히므로 2~4문장, 180자 안팎으로 짧게 말한다. 목록·마크다운·이모지·괄호 설명·특수 기호는 쓰지 않는다.
- 사실은 위 설명과 널리 알려진 역사에 근거한다. 모르거나 기록이 불확실한 것은 지어내지 말고 솔직히 말한다.
- 유적의 볼거리, 얽힌 인물과 이야기, 관람 포인트를 방문객 눈높이에서 들려주고, 필요하면 되물어 대화를 이어 간다.
- 유적·역사와 무관한 요청은 정중히 사양하고 이야기를 유적으로 돌린다.
지연에 민감한 음성 대화이므로 곧바로 답을 시작하라.`;
}

async function chat(req: Request, env: Env, client: Anthropic) {
  const body = ChatBody.parse(await req.json());
  const { figures } = await fetchJson<{ figures: Figure[] }>(`${env.SITE_BASE}data/figures.json`);
  const guideSite = body.figureId.startsWith('guide:') ? body.figureId.slice(6) : undefined;
  const f = figures.find((x) => x.id === body.figureId);
  if (!f && !guideSite) throw new HttpError(404, '인물을 찾을 수 없습니다.');
  const system = guideSite ? await guidePrompt(guideSite, env) : await systemPrompt(f!, env, body.siteId, body.boundary ?? true);

  // 안내 문구는 빼고, 인물의 첫 인사는 system 에 넣어 첫 메시지가 user 가 되게 한다
  const lines = body.lines.filter((l) => !l.system && l.text.trim()).slice(-MAX_TURNS);
  while (lines.length && !lines[0].mine) lines.shift();
  if (!lines.length) throw new HttpError(400, '질문이 없습니다.');
  const messages: Anthropic.Beta.BetaMessageParam[] = lines.map((l) => ({
    role: l.mine ? 'user' : 'assistant',
    content: l.text.slice(0, MAX_CHARS),
  }));

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    ...FALLBACK,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
  });

  if (response.stop_reason === 'refusal') {
    return { text: '그 이야기는 내가 답하기 어렵구려. 다른 것을 물어 주시게.' };
  }
  const text = response.content
    .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return { text: text || '…' };
}

// ---------- /rag : 검색 증강 대화 ----------
/**
 * 질문마다 RAG 색인(public/data/rag, BM25)에서 관련 조각을 찾아 문서로 넣고,
 * Claude 의 인용(citations) 기능으로 답변이 근거로 삼은 유적을 돌려준다.
 * 색인 파일은 질문에 든 단어의 것만 읽어 무료 Worker CPU 한도 안에서 검색한다.
 */
interface RagMeta {
  /** 색인 버전 (내용 해시) — 색인·본문 파일 주소에 붙여 옛 캐시와 섞이지 않게 한다 */
  v?: string;
  n: number;
  avgdl: number;
  group: number;
  /** [출처 id, 길이, 가장 이른 연도, 가장 늦은 연도] (연도 없으면 0) */
  docs: [string, number, number?, number?][];
}
interface RagChunk {
  s: string;
  t: string;
  x: string;
}
const TOP_K = 6;

/**
 * 색인 메타는 1분마다 다시 확인한다 (RAG 자료 편집기로 고친 내용이 배포되면 isolate 를 다시 띄우지 않아도 반영).
 * 버전이 바뀌면 옛 버전의 색인·본문 캐시를 비운다.
 */
let metaCache: { at: number; p: Promise<RagMeta> } | undefined;
function ragMeta(base: string): Promise<RagMeta> {
  if (metaCache && Date.now() - metaCache.at < 60_000) return metaCache.p;
  const prev = metaCache?.p;
  const p = fetch(`${base}meta.json?t=${Date.now()}`).then(async (r) => {
    if (!r.ok) throw new HttpError(502, 'RAG 색인을 불러오지 못했습니다.');
    const m = (await r.json()) as RagMeta;
    const old = await prev?.catch(() => undefined);
    if (old && old.v !== m.v) for (const k of cache.keys()) if (k.startsWith(base)) cache.delete(k);
    return m;
  });
  // 실패하면 직전 메타로 계속 동작
  const safe = prev ? p.catch(() => prev) : p;
  metaCache = { at: Date.now(), p: safe };
  safe.catch(() => (metaCache = undefined));
  return safe;
}

/** 지식 경계: 이 해 이후의 기록만 담긴 조각은 빼고(own 출처는 남겨 「후세 기록」으로 표시), 섞인 조각은 표시만 한다 */
interface Boundary {
  died: number;
  own: Set<string>;
}
type Era = 'late' | 'mixed';

async function retrieve(
  env: Env,
  query: string,
  boost: Map<string, number>,
  must: string[],
  limit?: Boundary,
): Promise<{ i: number; c: RagChunk; era?: Era }[]> {
  const base = `${env.SITE_BASE}data/rag/`;
  const meta = await ragMeta(base);
  const ver = meta.v ? `?v=${meta.v}` : '';
  const qt = queryTerms(query);
  const bucketIds = [...new Set(qt.map(bucketOf))];
  const buckets = new Map(
    await Promise.all(
      bucketIds.map(async (b) => [b, await fetchJson<Record<string, number[]>>(`${base}b/${b}.json${ver}`).catch(() => ({}) as Record<string, number[]>)] as const),
    ),
  );
  // BM25 (k1 = 1.2, b = 0.75)
  const scores = new Map<number, number>();
  for (const t of qt) {
    const e = buckets.get(bucketOf(t))?.[t];
    if (!e) continue;
    const df = e[0];
    const idf = Math.log(1 + (meta.n - df + 0.5) / (df + 0.5));
    for (let k = 1; k < e.length; k += 2) {
      const i = e[k];
      const tf = e[k + 1];
      const dl = meta.docs[i][1];
      scores.set(i, (scores.get(i) ?? 0) + (idf * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * dl) / meta.avgdl)));
    }
  }
  // 대화 상대와 연결된 유적·인물 조각에 가중치
  for (const [i, s] of scores) scores.set(i, s * (boost.get(meta.docs[i][0]) ?? 1));
  // 지식 경계 필터: 인물이 세상을 떠난 뒤의 일만 적힌 조각은 검색에서 뺀다 (이 인물의 유적 조각은 「후세 기록」으로 남김)
  const eraOf = (i: number): Era | undefined => {
    if (!limit) return undefined;
    const [, , yMin = 0, yMax = 0] = meta.docs[i];
    return yMin > limit.died ? 'late' : yMax > limit.died ? 'mixed' : undefined;
  };
  if (limit) for (const i of [...scores.keys()]) if (eraOf(i) === 'late' && !limit.own.has(meta.docs[i][0])) scores.delete(i);
  // 꼭 넣을 조각 (인물 소개 / 해설사가 안내하는 유적의 첫 조각)
  const mustIdx = must.map((src) => meta.docs.findIndex(([s]) => s === src)).filter((i) => i >= 0);
  const top = [...new Set([...mustIdx, ...[...scores].sort((a, b) => b[1] - a[1]).map(([i]) => i)])].slice(0, TOP_K);

  const groups = new Map(
    await Promise.all(
      [...new Set(top.map((i) => Math.floor(i / meta.group)))].map(async (g) => [g, await fetchJson<RagChunk[]>(`${base}c/${g}.json${ver}`)] as const),
    ),
  );
  return top.map((i) => ({ i, c: groups.get(Math.floor(i / meta.group))![i % meta.group], era: eraOf(i) }));
}

async function rag(req: Request, env: Env, client: Anthropic) {
  const body = ChatBody.parse(await req.json());
  const { figures } = await fetchJson<{ figures: Figure[] }>(`${env.SITE_BASE}data/figures.json`);
  const guideSite = body.figureId.startsWith('guide:') ? body.figureId.slice(6) : undefined;
  const f = figures.find((x) => x.id === body.figureId);
  if (!f && !guideSite) throw new HttpError(404, '인물을 찾을 수 없습니다.');
  if (guideSite && !/^[\w-]{1,40}$/.test(guideSite)) throw new HttpError(400, '유적지 id 가 올바르지 않습니다.');

  const lines = body.lines.filter((l) => !l.system && l.text.trim()).slice(-MAX_TURNS);
  while (lines.length && !lines[0].mine) lines.shift();
  if (!lines.length || !lines[lines.length - 1].mine) throw new HttpError(400, '질문이 없습니다.');
  const question = lines[lines.length - 1].text.slice(0, MAX_CHARS);
  // 검색어: 이번 질문 + 바로 앞 질문 (대명사로 이어지는 질문 대비)
  const prevQ = lines.slice(0, -1).filter((l) => l.mine).slice(-1)[0]?.text ?? '';
  const boost = new Map<string, number>();
  const must: string[] = [];
  if (f) {
    f.sites.forEach((s) => boost.set(s.id, 1.6));
    boost.set(`fig:${f.id}`, 2);
    must.push(`fig:${f.id}`);
  } else {
    boost.set(guideSite!, 2);
    must.push(guideSite!);
  }
  const died = f && (body.boundary ?? true) ? diedYear(f) : undefined;
  const limit = died ? { died, own: new Set(f!.sites.map((x) => x.id)) } : undefined;
  const found = await retrieve(env, `${question} ${prevQ}`, boost, must, limit);

  const persona = f
    ? `너는 역사 인물 ${f.name}(${f.hanja}, ${f.title}, ${f.years})이다. 유적지를 찾은 방문객과 얼굴을 마주 보고 이야기하는 AR 앱 '역사담'에서, ${f.name} 본인으로서 1인칭으로 대화한다.
[인물 소개] ${f.bio}
- 말씨: ${speechStyle(f)}. 옛 어른이 오늘날 사람에게 차분히 이야기하듯 자연스러운 우리말로.
${boundaryRule(f, body.boundary ?? true)}`
    : `너는 AR 앱 '역사담'의 문화유산 해설사다. 역사 인물이 아니라 오늘날의 해설사로서 친절한 존댓말로 유적을 안내한다.`;
  const system = `${persona}

[근거 자료 사용 규칙 — RAG]
- 방문객의 질문과 함께 검색된 자료 문서가 주어진다. 답은 반드시 그 문서에 적힌 사실에 근거하고, 문서에 없는 내용은 지어내지 말고 기록이 분명치 않다고 솔직히 말한다.
- 답은 음성으로 읽히므로 2~4문장, 180자 안팎. 목록·마크다운·이모지·괄호 설명·특수 기호는 쓰지 않는다.
- 문서 제목이나 "자료에 따르면" 같은 말은 소리 내어 말하지 말고, 대화하듯 자연스럽게 녹여 말한다.
- 역사·유적과 무관한 요청은 정중히 사양한다.
지연에 민감한 음성 대화이므로 곧바로 답을 시작하라.`;

  const history: Anthropic.Beta.BetaMessageParam[] = lines.slice(0, -1).map((l) => ({
    role: l.mine ? 'user' : 'assistant',
    content: l.text.slice(0, MAX_CHARS),
  }));
  const documents: Anthropic.Beta.BetaRequestDocumentBlock[] = found.map(({ c, era }) => ({
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: c.x },
    // 지식 경계: 사후의 기록이 담긴 문서는 제목으로 알려 준다 (인물은 전해 들은 이야기로만 말함)
    title: era === 'late' ? `${c.t} (후세 기록: ${died}년 이후)` : era === 'mixed' ? `${c.t} (${died}년 이후 기록 일부 포함)` : c.t,
    citations: { enabled: true },
  }));

  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2000,
    ...FALLBACK,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'low' },
    system,
    messages: [...history, { role: 'user', content: [...documents, { type: 'text', text: question }] }],
  });
  if (response.stop_reason === 'refusal') {
    return { text: '그 이야기는 답하기 어렵구려. 다른 것을 물어 주시게.', sources: [] };
  }

  const blocks = response.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text');
  const text = blocks.map((b) => b.text).join('').trim();
  // 인용된 문서 → 출처 유적 (같은 유적은 한 번만)
  const sources = new Map<string, { id: string; name: string; quote: string }>();
  for (const b of blocks) {
    for (const cit of b.citations ?? []) {
      if (!('document_index' in cit)) continue;
      const hit = found[cit.document_index];
      if (!hit || sources.has(hit.c.s)) continue;
      sources.set(hit.c.s, { id: hit.c.s, name: hit.c.t, quote: cit.cited_text.replace(/\s+/g, ' ').slice(0, 90) });
    }
  }
  return { text: text || '…', sources: [...sources.values()], retrieved: found.map(({ c }) => c.t) };
}

// ---------- /vision ----------
const VisionBody = z.object({
  image: z.string().max(MAX_IMAGE_B64),
  candidates: z
    .array(z.object({ id: z.string(), name: z.string(), kind: z.string(), city: z.string().optional() }))
    .max(12),
});

const VisionResult = z.object({
  matchedId: z.string().nullable(),
  name: z.string(),
  kind: z.string(),
  era: z.string(),
  description: z.string(),
  confidence: z.number(),
  isHeritage: z.boolean(),
  category: z.enum(['figure', 'site', 'relic']),
});

function visionPrompt(candidates: z.infer<typeof VisionBody>['candidates']): string {
  const block = candidates.length
    ? candidates.map((c) => `- id=${c.id} | ${c.name} | ${c.kind} | ${c.city ?? ''}`).join('\n')
    : '(주변 후보 없음)';
  return `너는 한국 문화재·유물 감정 전문가다. 사용자가 촬영한 사진 1장을 보고, 그 안의 문화재/유물/건축물이 무엇인지 판별하라.

아래는 사용자의 현재 위치 주변 국가유산 후보다(참고용 힌트):
${block}

규칙:
- matchedId: 사진 속 대상이 위 후보 목록의 그 국가유산 "자체"(같은 건물·유적)일 때만 그 id 를 넣어라.
- 유물·초상화·동상·조각상 등은 대개 주변 유적지와 다른 대상이다. 이런 경우 matchedId 를 null 로 두고 주변 유적지에 억지로 맞추지 말고, 네 지식으로 "그 대상 자체"를 판별하라.
- isHeritage: 대상이 문화재/유물/유적/전통 건축물이거나 "역사 인물의 초상화·동상·조각상"이면 true. 살아있는 실제 사람이나 현대 사물(노트북·휴대폰·음식 등)이면 false.
- category: 대상을 하나로 분류 — "figure"(인물의 초상화·동상·흉상 등 사람을 묘사한 문화재), "site"(건물·궁궐·성곽·탑·유적), "relic"(도자기·회화·공예품 등 그 외 유물).
- description 은 한국어로 2~3문장, 사실 위주(과장·창작 금지). figure 면 그 인물에 대한 설명 위주로.
- confidence 는 0~100. 확신이 낮으면 낮게 매겨라.`;
}

async function vision(req: Request, client: Anthropic) {
  const body = VisionBody.parse(await req.json());
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 4000,
    ...FALLBACK,
    thinking: { type: 'adaptive' },
    output_config: { effort: 'medium', format: betaZodOutputFormat(VisionResult) },
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: body.image } },
          { type: 'text', text: visionPrompt(body.candidates) },
        ],
      },
    ],
  });
  if (response.stop_reason === 'refusal' || !response.parsed_output) {
    throw new HttpError(422, '사진을 판별하지 못했습니다.');
  }
  const v = response.parsed_output;
  return { ...v, matchedId: body.candidates.some((c) => c.id === v.matchedId) ? v.matchedId : null };
}

// ---------- /tts ----------
const TtsBody = z.object({ figureId: z.string().max(64), text: z.string().min(1).max(600) });

/** 인물 성격에 맞춘 기본 목소리 (figures.json 의 voice 가 우선) */
const DEFAULT_VOICE: Record<Figure['style'], string> = {
  king: 'ko-KR-BongJinNeural',
  scholar: 'ko-KR-InJoonNeural',
  general: 'ko-KR-GookMinNeural',
  lady: 'ko-KR-SunHiNeural',
};

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

async function tts(req: Request, env: Env): Promise<Response> {
  if (!env.AZURE_SPEECH_KEY || !env.AZURE_SPEECH_REGION) throw new HttpError(503, '서버 음성이 설정되지 않았습니다.');
  const body = TtsBody.parse(await req.json());
  const { figures } = await fetchJson<{ figures: Figure[] }>(`${env.SITE_BASE}data/figures.json`);
  const f = figures.find((x) => x.id === body.figureId);
  const isGuide = body.figureId.startsWith('guide:');
  if (!f && !isGuide) throw new HttpError(404, '인물을 찾을 수 없습니다.');
  const voice = f ? (f.voice ?? DEFAULT_VOICE[f.style]) : 'ko-KR-InJoonNeural';
  const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR"><voice name="${voice}"><prosody rate="-6%">${xml(body.text)}</prosody></voice></speak>`;
  const res = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'yeoksadam-api',
    },
    body: ssml,
  });
  if (!res.ok) {
    console.error('Azure TTS 오류', res.status, await res.text().catch(() => ''));
    throw new HttpError(502, '음성을 만들지 못했습니다.');
  }
  return new Response(res.body, { headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' } });
}

// ---------- 진입점 ----------
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const headers = cors(req.headers.get('Origin'), env);
    if (req.method === 'OPTIONS') return new Response(null, { status: headers['Access-Control-Allow-Origin'] ? 204 : 403, headers });
    // 웹앱은 Origin, Android 앱은 X-App-Key 로 확인한다 (둘 다 비밀은 아니며, 브라우저 밖의 남용 방지 수준)
    const appKey = req.headers.get('X-App-Key');
    const fromApp = !!appKey && (env.APP_KEYS ?? '').split(',').map((k) => k.trim()).includes(appKey);
    if (!headers['Access-Control-Allow-Origin'] && !fromApp) return json({ error: '허용되지 않은 출처입니다.' }, 403, headers);
    if (req.method !== 'POST') return json({ error: 'POST 만 지원합니다.' }, 405, headers);

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const path = new URL(req.url).pathname;
    try {
      if (path === '/chat') return json(await chat(req, env, client), 200, headers);
      if (path === '/rag') return json(await rag(req, env, client), 200, headers);
      if (path === '/vision') return json(await vision(req, client), 200, headers);
      if (path === '/tts') {
        const audio = await tts(req, env);
        Object.entries(headers).forEach(([k, v]) => audio.headers.set(k, v));
        return audio;
      }
      return json({ error: '없는 경로입니다.' }, 404, headers);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.message }, e.status, headers);
      if (e instanceof z.ZodError) return json({ error: '요청 형식이 올바르지 않습니다.' }, 400, headers);
      if (e instanceof Anthropic.RateLimitError) return json({ error: '요청이 많습니다. 잠시 후 다시 시도해 주세요.' }, 429, headers);
      if (e instanceof Anthropic.APIError) {
        console.error('Claude API 오류', e.status, e.message);
        // 원인 파악용 상태 코드만 전달 (401: 키 오류, 400: 요청 형식, 529: 과부하)
        return json({ error: '인물이 잠시 대답하지 못합니다.', upstream: e.status }, 502, headers);
      }
      console.error(e);
      return json({ error: '서버 오류가 발생했습니다.' }, 500, headers);
    }
  },
};
