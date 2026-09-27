/**
 * RAG 검색 색인 만들기 (BM25, 정적 파일)
 *
 * 유적 설명문(국가유산청·향토유산·역사관광지)과 인물 소개를 문단 조각으로 나누고,
 * 한글 2글자 단위(바이그램) 역색인을 256개 파일로 나눠 public/data/rag/ 에 쓴다.
 * Worker(/rag)는 질문에 들어 있는 단어의 색인 파일만 읽어 점수를 매기므로
 * 벡터 DB 나 임베딩 서버 없이, 무료 Worker 의 짧은 CPU 시간 안에서 검색할 수 있다.
 *
 * 출력
 *   rag/meta.json          조각 수·평균 길이·조각별 [출처 id, 길이]
 *   rag/b/<0..255>.json    { 단어: [문서빈도, 조각번호, 빈도, 조각번호, 빈도, …] }
 *   rag/c/<n>.json         조각 본문 묶음 (32개씩)
 *
 * 사용: npm run data:rag   (fetch-heritage → fetch-hyangto → import-tour 다음)
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Figure, HeritageDetail, HeritageIndex } from '../src/types.ts';
import { BUCKETS, GROUP, bucketOf, terms } from '../worker/src/ragText.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const DATA = path.join(ROOT, 'public', 'data');
const OUT = path.join(DATA, 'rag');
const MAX = 500;

interface Chunk {
  /** 출처: 유적 id 또는 "fig:<인물 id>" */
  s: string;
  /** 출처 이름 */
  t: string;
  /** 본문 */
  x: string;
}

/** 문단 → 500자 이하 조각 (길면 문장 경계에서 자름) */
function split(text: string): string[] {
  const out: string[] = [];
  // 국가유산청 설명에 섞인 HTML 태그 제거
  const clean = text.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  for (const para of clean.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean)) {
    if (para.length <= MAX) {
      out.push(para);
      continue;
    }
    let cur = '';
    for (const s of para.split(/(?<=[.!?다])\s+/)) {
      if (cur && cur.length + s.length + 1 > MAX) {
        out.push(cur);
        cur = s;
      } else cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) out.push(cur);
  }
  return out;
}

async function main() {
  const index = JSON.parse(await readFile(path.join(DATA, 'index.json'), 'utf8')) as HeritageIndex;
  const { figures } = JSON.parse(await readFile(path.join(DATA, 'figures.json'), 'utf8')) as { figures: Figure[] };

  const chunks: Chunk[] = [];
  for (const it of index.items) {
    const d = JSON.parse(await readFile(path.join(DATA, 'detail', `${it.id}.json`), 'utf8')) as HeritageDetail;
    const head = `${d.name} (${[d.designation, d.era, d.city].filter(Boolean).join(', ')})`;
    const parts = split(d.description);
    if (!parts.length) parts.push(`${d.name}은 ${d.city}에 있는 ${d.designation}입니다.`);
    // 조각마다 유적 이름을 붙여 "화성은 누가…" 같은 질문도 찾히게 한다
    for (const p of parts) chunks.push({ s: d.id, t: d.name, x: `${head}\n${p}` });
  }
  for (const f of figures) {
    chunks.push({ s: `fig:${f.id}`, t: f.name, x: `${f.name}(${f.hanja}) — ${f.title}, ${f.years}\n${f.bio}` });
  }

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
  const avgdl = lens.reduce((a, b) => a + b, 0) / lens.length;
  await writeFile(
    path.join(OUT, 'meta.json'),
    JSON.stringify({ n: chunks.length, avgdl, buckets: BUCKETS, group: GROUP, docs: chunks.map((c, i) => [c.s, lens[i]]) }),
  );
  console.log(`RAG 색인: 조각 ${chunks.length}개 (유적 ${index.items.length}곳 + 인물 ${figures.length}명), 단어 ${postings.size}개, 평균 길이 ${avgdl.toFixed(0)}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
