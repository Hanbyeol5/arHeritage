/**
 * RAG 검색 색인 만들기 (BM25, 정적 파일)
 *
 * 유적 설명문(국가유산청·향토유산·역사관광지)과 인물 소개를 문단 조각으로 나누고,
 * 한글 2글자 단위(바이그램) 역색인을 256개 파일로 나눠 public/data/rag/ 에 쓴다.
 * Worker(/rag)는 질문에 들어 있는 단어의 색인 파일만 읽어 점수를 매기므로
 * 벡터 DB 나 임베딩 서버 없이, 무료 Worker 의 짧은 CPU 시간 안에서 검색할 수 있다.
 *
 * 출력
 *   rag/meta.json          버전·조각 수·평균 길이·조각별 [출처 id, 길이, 가장 이른 연도, 가장 늦은 연도]
 *   rag/b/<0..255>.json    { 단어: [문서빈도, 조각번호, 빈도, 조각번호, 빈도, …] }
 *   rag/c/<n>.json         조각 본문 묶음 (32개씩)
 *
 * 사용: npm run data:rag   (fetch-heritage → fetch-hyangto → import-tour 다음)
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Figure, HeritageDetail, HeritageIndex } from '../src/types.ts';
import { BUCKETS, GROUP, bucketOf, emptyEdits, splitChunks, terms, yearsIn, type RagEdits } from '../worker/src/ragText.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');
const OUT = path.join(DATA, 'rag');

interface Chunk {
  /** 출처: 유적 id 또는 "fig:<인물 id>" */
  s: string;
  /** 출처 이름 */
  t: string;
  /** 본문 */
  x: string;
}

/** 조각에 나오는 가장 이른·늦은 연도 (없으면 0, 0) — Worker 의 지식 경계 필터가 쓴다 */
function yearRange(text: string): [number, number] {
  const ys = yearsIn(text);
  return ys.length ? [Math.min(...ys), Math.max(...ys)] : [0, 0];
}

async function main() {
  const index = JSON.parse(await readFile(path.join(DATA, 'index.json'), 'utf8')) as HeritageIndex;
  const { figures } = JSON.parse(await readFile(path.join(DATA, 'figures.json'), 'utf8')) as { figures: Figure[] };

  // RAG 자료 편집기에서 저장한 수정 사항 (없으면 원본 그대로)
  const edits: RagEdits = await readFile(path.join(DATA, 'rag-edits.json'), 'utf8')
    .then((t) => ({ ...emptyEdits(), ...(JSON.parse(t) as Partial<RagEdits>) }))
    .catch(() => emptyEdits());
  const hidden = new Set(edits.hidden);
  const names = new Map<string, string>();

  const chunks: Chunk[] = [];
  for (const it of index.items) {
    const d = JSON.parse(await readFile(path.join(DATA, 'detail', `${it.id}.json`), 'utf8')) as HeritageDetail;
    names.set(d.id, d.name);
    if (hidden.has(d.id)) continue;
    const head = `${d.name} (${[d.designation, d.era, d.city].filter(Boolean).join(', ')})`;
    const parts = splitChunks(edits.overrides[d.id] ?? d.description);
    if (!parts.length) parts.push(`${d.name}은 ${d.city}에 있는 ${d.designation}입니다.`);
    // 조각마다 유적 이름을 붙여 "화성은 누가…" 같은 질문도 찾히게 한다
    for (const p of parts) chunks.push({ s: d.id, t: d.name, x: `${head}\n${p}` });
  }
  for (const f of figures) {
    const s = `fig:${f.id}`;
    names.set(s, f.name);
    if (hidden.has(s)) continue;
    const head = `${f.name}(${f.hanja}) — ${f.title}, ${f.years}`;
    for (const p of splitChunks(edits.overrides[s] ?? f.bio)) chunks.push({ s, t: f.name, x: `${head}\n${p}` });
  }
  // 추가 자료: 연결한 유적·인물이 있으면 그 출처로(대화 상대 가중치·근거 버튼이 이어짐), 없으면 "u:<id>"
  for (const e of edits.extra) {
    const s = e.link && names.has(e.link) ? e.link : `u:${e.id}`;
    const t = e.link && names.has(e.link) ? names.get(e.link)! : e.title;
    for (const p of splitChunks(e.text)) chunks.push({ s, t, x: `${e.title}\n${p}` });
  }
  const edited = Object.keys(edits.overrides).length + edits.hidden.length + edits.extra.length;

  // 역색인
  const postings = new Map<string, number[]>();
  const lens: number[] = [];
  chunks.forEach((c, i) => {
    const tf = new Map<string, number>();
    const ts = terms(c.x);
    lens.push(ts.length);
    for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, n] of tf) {
      const p = postings.get(t) ?? [];
      p.push(i, n);
      postings.set(t, p);
    }
  });

  await rm(OUT, { recursive: true, force: true });
  await mkdir(path.join(OUT, 'b'), { recursive: true });
  await mkdir(path.join(OUT, 'c'), { recursive: true });

  const buckets: Record<string, number[]>[] = Array.from({ length: BUCKETS }, () => ({}));
  for (const [t, p] of postings) buckets[bucketOf(t)][t] = [p.length / 2, ...p];
  await Promise.all(buckets.map((b, i) => writeFile(path.join(OUT, 'b', `${i}.json`), JSON.stringify(b))));

  for (let g = 0; g * GROUP < chunks.length; g++) {
    await writeFile(path.join(OUT, 'c', `${g}.json`), JSON.stringify(chunks.slice(g * GROUP, (g + 1) * GROUP)));
  }
  // 색인 버전: 내용이 바뀔 때만 달라져 Worker 가 새 색인을 받아 가게 한다
  const v = createHash('sha1').update(JSON.stringify(chunks)).digest('hex').slice(0, 12);
  const avgdl = lens.reduce((a, b) => a + b, 0) / lens.length;
  await writeFile(
    path.join(OUT, 'meta.json'),
    JSON.stringify({ v, n: chunks.length, avgdl, buckets: BUCKETS, group: GROUP, docs: chunks.map((c, i) => [c.s, lens[i], ...yearRange(c.x)]) }),
  );
  console.log(`RAG 색인: 조각 ${chunks.length}개 (유적 ${index.items.length}곳 + 인물 ${figures.length}명), 단어 ${postings.size}개, 평균 길이 ${avgdl.toFixed(0)}, 사용자 수정 ${edited}건, 버전 ${v}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
