/**
 * LLM 보강 (빌드 시점, Claude Message Batches API — 비용 50% 할인)
 *
 * A. 유적지마다: 음성·자막용 한두 문장 요약 + 유적과 관련된 역사 인물 추출
 * B. 인물마다: 실존·대화 가능 여부 판단 + 인물 소개(호·생몰년·말씨 유형·약전)
 * 결과
 *   - public/data/detail/<id>.json 에 summary 추가
 *   - public/data/figures.json 에 자동 추출 인물(auto) 추가, 기존 수작업 인물에는 유적만 보탬
 *   - enrich/*.json 캐시 — 설명이 바뀌지 않은 유적·인물은 다시 묻지 않는다
 *
 * 사용: npm run data:enrich [-- --limit=20] [-- --dry-run]
 * 필요: ANTHROPIC_API_KEY (.env.local 또는 환경 변수)
 * 반드시 fetch-heritage → fetch-hyangto → import-tour 다음에 실행한다.
 */
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Figure, HeritageDetail, HeritageIndex } from '../src/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');
const CACHE = path.join(ROOT, 'enrich');
const MODEL = 'claude-opus-5';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')).map(([k, v]) => [k, v ?? 'true']));
const LIMIT = args.limit ? Number(args.limit) : Infinity;
const DRY = args['dry-run'] === 'true';

// .env.local 의 키도 읽는다 (로컬 실행용)
if (!process.env.ANTHROPIC_API_KEY && existsSync(path.join(ROOT, '.env.local'))) {
  const m = (await readFile(path.join(ROOT, '.env.local'), 'utf8')).match(/^ANTHROPIC_API_KEY=(.+)$/m);
  if (m) process.env.ANTHROPIC_API_KEY = m[1].trim();
}

type Style = Figure['style'];
interface SiteResult {
  hash: string;
  summary: string;
  persons: { name: string; hanja: string | null; relation: string; certainty: 'high' | 'medium' | 'low' }[];
}
interface PersonResult {
  hash: string;
  real: boolean;
  notable: boolean;
  name: string;
  hanja: string | null;
  title: string;
  years: string;
  style: Style;
  seal: string;
  bio: string;
}

const sha = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 12);
async function readJson<T>(file: string, fallback: T): Promise<T> {
  return existsSync(file) ? (JSON.parse(await readFile(file, 'utf8')) as T) : fallback;
}

// ---------- 구조화 출력 스키마 ----------
const SITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'persons'],
  properties: {
    summary: { type: 'string', description: '소리 내어 읽기 좋은 한두 문장, 90자 이내, "~입니다" 체' },
    persons: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'hanja', 'relation', 'certainty'],
        properties: {
          name: { type: 'string', description: '인물 이름 (호·존칭 없이, 예: 김홍집)' },
          hanja: { type: ['string', 'null'], description: '한자 이름, 모르면 null' },
          relation: { type: 'string', description: '이 유적과의 관계, 15자 이내 (예: 묘의 주인, 신도비의 주인공, 배향 인물, 태어난 곳, 건립을 명함)' },
          certainty: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
} as const;

const PERSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['real', 'notable', 'name', 'hanja', 'title', 'years', 'style', 'seal', 'bio'],
  properties: {
    real: { type: 'boolean', description: '실존했던 역사 인물이면 true (전설·설화 인물, 신, 단체는 false)' },
    notable: { type: 'boolean', description: '행적이 기록으로 전해져 그 인물로서 대화할 만큼 알려진 인물이면 true' },
    name: { type: 'string' },
    hanja: { type: ['string', 'null'] },
    title: { type: 'string', description: '호 또는 대표 직함, 12자 이내 (예: 다산, 영의정, 조선 제17대 국왕)' },
    years: { type: 'string', description: '생몰년 "1545–1598" 형식, 모르면 빈 문자열' },
    style: { type: 'string', enum: ['king', 'scholar', 'lady', 'general'], description: '말씨·모습 유형: 국왕·왕족 king, 문신·학자·승려 scholar, 여성 lady, 무신·의병장 general' },
    seal: { type: 'string', description: '낙관에 새길 성씨 한자 한 글자' },
    bio: { type: 'string', description: '두 문장 약전, 사실만, 120자 이내' },
  },
} as const;

function sitePrompt(d: HeritageDetail): string {
  return `다음은 경기도 유적 한 곳의 공식 설명이다.

이름: ${d.name}
지정: ${d.designation}${d.subCategory ? ` (${d.subCategory})` : ''}
시대: ${d.era || '미상'}
소재지: ${d.address}
설명:
${d.description.slice(0, 3500)}

할 일
1. summary: AR 화면에 띄우고 소리 내어 읽을 한두 문장 요약 (90자 이내, "~입니다" 체, 설명에 있는 사실만).
2. persons: 이 유적과 직접 관련된 실존 역사 인물을 찾아라.
   - 묘·신도비·사당·생가·서원의 주인공, 건립하거나 명한 사람, 배향된 사람, 이곳에서 활동한 사람.
   - 설명이나 이름에 나오거나 확실히 알려진 경우만. 추측이면 certainty 를 낮게.
   - 이름은 호·존칭·직함 없이 본명으로 (예: "김홍집선생묘" → 김홍집). 가문·단체·신·부처·무명의 인물은 넣지 않는다.
   - 관련 인물이 없으면 빈 배열.`;
}

function personPrompt(name: string, hanja: string | null, contexts: string[]): string {
  return `경기도 유적 설명에서 다음 인물이 언급되었다.

인물: ${name}${hanja ? ` (${hanja})` : ''}
언급된 유적과 관계:
${contexts.slice(0, 6).join('\n')}

이 인물을 역사 인물 대화 앱의 등장인물로 쓸 수 있는지 판단하고 소개를 작성하라.
- 동명이인에 주의해 위 유적과 관련된 바로 그 인물로 판단한다.
- 널리 알려진 역사적 사실만 쓰고, 불확실하면 years 는 빈 문자열, notable 은 false.`;
}

// ---------- 배치 실행 ----------
async function runBatch(
  client: Anthropic,
  label: string,
  requests: { custom_id: string; prompt: string; schema: object; effort: 'low' | 'medium' }[],
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (!requests.length) return out;
  console.log(`  ${label}: ${requests.length}건 배치 제출`);
  const batch = await client.messages.batches.create({
    requests: requests.map((r) => ({
      custom_id: r.custom_id,
      params: {
        model: MODEL,
        max_tokens: 4000,
        output_config: { effort: r.effort, format: { type: 'json_schema', schema: r.schema as Record<string, unknown> } },
        messages: [{ role: 'user', content: r.prompt }],
      },
    })),
  });
  for (;;) {
    const b = await client.messages.batches.retrieve(batch.id);
    const c = b.request_counts;
    console.log(`  [${new Date().toLocaleTimeString('ko-KR')}] ${b.processing_status} — 처리 중 ${c.processing}, 성공 ${c.succeeded}, 오류 ${c.errored}`);
    if (b.processing_status === 'ended') break;
    await new Promise((r) => setTimeout(r, 30_000));
  }
  for await (const res of await client.messages.batches.results(batch.id)) {
    if (res.result.type !== 'succeeded') continue;
    const msg = res.result.message;
    if (msg.stop_reason === 'refusal') continue;
    const text = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    try {
      out.set(res.custom_id, JSON.parse(text));
    } catch {
      /* 형식이 어긋난 응답은 건너뜀 (다음 실행 때 다시 시도) */
    }
  }
  console.log(`  ${label}: ${out.size}/${requests.length}건 결과 수신`);
  return out;
}

// ---------- 인물 유형 → 목소리·전신 모습 ----------
const VOICES: Record<Style, string[]> = {
  king: ['ko-KR-BongJinNeural', 'ko-KR-GookMinNeural'],
  scholar: ['ko-KR-InJoonNeural', 'ko-KR-HyunsuNeural', 'ko-KR-BongJinNeural'],
  general: ['ko-KR-GookMinNeural', 'ko-KR-InJoonNeural'],
  lady: ['ko-KR-SunHiNeural', 'ko-KR-JiMinNeural'],
};

async function main() {
  const index = JSON.parse(await readFile(path.join(DATA, 'index.json'), 'utf8')) as HeritageIndex;
  const figuresFile = path.join(DATA, 'figures.json');
  const figData = JSON.parse(await readFile(figuresFile, 'utf8')) as { note: string; figures: (Figure & { auto?: boolean })[] };
  await mkdir(CACHE, { recursive: true });
  const siteCache = await readJson<Record<string, SiteResult>>(path.join(CACHE, 'sites.json'), {});
  const personCache = await readJson<Record<string, PersonResult>>(path.join(CACHE, 'persons.json'), {});
  const client = DRY ? (undefined as unknown as Anthropic) : new Anthropic();

  // ----- A. 유적지 -----
  console.log('[A] 유적지 요약·관련 인물');
  const details = new Map<string, HeritageDetail>();
  for (const it of index.items) {
    details.set(it.id, JSON.parse(await readFile(path.join(DATA, 'detail', `${it.id}.json`), 'utf8')));
  }
  const todoSites = [...details.values()]
    .filter((d) => siteCache[d.id]?.hash !== sha(d.name + d.description))
    .slice(0, LIMIT);
  console.log(`  캐시 ${Object.keys(siteCache).length}건, 새로 물을 유적 ${todoSites.length}건`);
  if (DRY && todoSites[0]) console.log('--- 예시 프롬프트 ---\n' + sitePrompt(todoSites[0]));
  if (!DRY) {
    const got = await runBatch(
      client,
      '유적 요약',
      todoSites.map((d) => ({ custom_id: d.id, prompt: sitePrompt(d), schema: SITE_SCHEMA, effort: 'low' as const })),
    );
    for (const d of todoSites) {
      const r = got.get(d.id) as Omit<SiteResult, 'hash'> | undefined;
      if (r) siteCache[d.id] = { hash: sha(d.name + d.description), ...r };
    }
    await writeFile(path.join(CACHE, 'sites.json'), JSON.stringify(siteCache, null, 1));
  }

  // ----- B. 인물 -----
  console.log('[B] 인물 소개');
  const seed = figData.figures.filter((f) => !f.auto);
  const seedKey = (n: string, h: string | null) =>
    seed.find((f) => f.name === n || f.name.replace(/대왕$| 이성계$/, '') === n || (h && f.hanja === h));
  const groups = new Map<string, { name: string; hanja: string | null; sites: { id: string; relation: string }[] }>();
  for (const [siteId, r] of Object.entries(siteCache)) {
    if (!details.has(siteId)) continue;
    for (const p of r.persons) {
      if (p.certainty !== 'high' || p.name.length < 2 || p.name.length > 6) continue;
      const key = p.hanja ? `${p.name}|${p.hanja}` : p.name;
      const g = groups.get(key) ?? { name: p.name, hanja: p.hanja, sites: [] };
      if (!g.sites.some((s) => s.id === siteId)) g.sites.push({ id: siteId, relation: p.relation });
      groups.set(key, g);
    }
  }
  const pHash = (g: { sites: { id: string; relation: string }[] }) => sha(g.sites.map((s) => s.id + s.relation).sort().join());
  const todoPersons = [...groups.entries()]
    .filter(([key, g]) => !seedKey(g.name, g.hanja) && personCache[key]?.hash !== pHash(g))
    .slice(0, LIMIT);
  console.log(`  추출 인물 ${groups.size}명 (기존 인물과 겹침 제외), 새로 물을 인물 ${todoPersons.length}명`);
  if (DRY && todoPersons[0]) {
    const [, g] = todoPersons[0];
    console.log('--- 예시 프롬프트 ---\n' + personPrompt(g.name, g.hanja, g.sites.map((s) => `- ${details.get(s.id)!.name}: ${s.relation}`)));
  }
  if (!DRY) {
    const ids = new Map(todoPersons.map(([key]) => [`p${sha(key)}`, key]));
    const got = await runBatch(
      client,
      '인물 소개',
      todoPersons.map(([key, g]) => ({
        custom_id: `p${sha(key)}`,
        prompt: personPrompt(g.name, g.hanja, g.sites.map((s) => `- ${details.get(s.id)!.name} (${details.get(s.id)!.designation}): ${s.relation}`)),
        schema: PERSON_SCHEMA,
        effort: 'medium' as const,
      })),
    );
    for (const [cid, r] of got) {
      const key = ids.get(cid)!;
      personCache[key] = { hash: pHash(groups.get(key)!), ...(r as Omit<PersonResult, 'hash'>) };
    }
    await writeFile(path.join(CACHE, 'persons.json'), JSON.stringify(personCache, null, 1));
  }
  if (DRY) return;

  // ----- 결과 반영 -----
  for (const d of details.values()) {
    const s = siteCache[d.id];
    if (s?.summary && d.summary !== s.summary) {
      d.summary = s.summary;
      await writeFile(path.join(DATA, 'detail', `${d.id}.json`), JSON.stringify(d));
    }
  }
  const figures: (Figure & { auto?: boolean })[] = seed.map((f) => ({ ...f, sites: [...f.sites] }));
  let added = 0;
  for (const [key, g] of groups) {
    const s = seedKey(g.name, g.hanja);
    if (s) {
      const f = figures.find((x) => x.id === s.id)!;
      for (const site of g.sites) if (!f.sites.some((x) => x.id === site.id)) f.sites.push({ id: site.id, note: site.relation });
      continue;
    }
    const p = personCache[key];
    if (!p?.real || !p.notable) continue;
    const id = `p-${sha(key)}`;
    const h = parseInt(sha(key).slice(0, 4), 16);
    figures.push({
      id,
      name: p.name,
      hanja: p.hanja ?? '',
      title: p.title,
      years: p.years,
      seal: p.seal || p.name.slice(0, 1),
      style: p.style,
      bio: p.bio,
      voice: VOICES[p.style][h % VOICES[p.style].length],
      fullBody: p.style === 'king' ? 'king' : p.style === 'lady' ? 'lady' : p.style === 'general' ? 'general' : 'scholar',
      sites: g.sites.map((x) => ({ id: x.id, note: x.relation })),
      auto: true,
    });
    added++;
  }
  figData.figures = figures;
  figData.note =
    '수작업 시드 인물 + LLM 이 유적 설명에서 추출한 인물(auto). 초상: 진본(퍼블릭 도메인) 또는 AI 상상 초상, 없으면 전신 실루엣.';
  await writeFile(figuresFile, JSON.stringify(figData, null, 2));
  console.log(`완료: 요약 ${Object.keys(siteCache).length}곳, 자동 추출 인물 ${added}명 추가 → 전체 ${figures.length}명`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
