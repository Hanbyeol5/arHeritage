/**
 * 경기도 역사관광지 현황(경기데이터드림, data/경기도역사관광지현황.json) 반영
 *
 * - 이미 있는 국가유산·향토유산과 겹치면(가까운 위치 + 비슷한 이름) 새로 넣지 않고 전화번호만 보탠다.
 * - 겹치지 않는 곳(예: 수원 화성의 각 문, 파주 이이·신사임당 묘)은 '역사관광지'로 추가한다.
 * 반드시 fetch-heritage, fetch-hyangto 다음에 실행한다.
 * 사용: npm run data:tour
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HeritageDetail, HeritageIndex, HeritageSummary } from '../src/types.ts';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'data');
const SRC = path.join(ROOT, 'data', '경기도역사관광지현황.json');

interface TourRow {
  sigun_nm: string;
  tursm_info_nm: string;
  telno: string;
  dat_crtr_ymd: string;
  refine_road_nm_addr: string;
  refine_lotno_addr: string;
  refine_wgs84_lat: string;
  refine_wgs84_logt: string;
}

/** 비교용 이름: 공백·괄호·흔한 꾸밈말 제거 */
const norm = (s: string) => s.replace(/\s|\(.*?\)|선생|장군|묘소|묘역|유적지?|사적지?|기념관|터$/g, '').replace(/[·ㆍ,.-]/g, '');
const bigrams = (s: string) => new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
function similarity(a: string, b: string) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return a === b ? 1 : 0;
  let n = 0;
  A.forEach((x) => B.has(x) && n++);
  return (2 * n) / (A.size + B.size);
}
function distance(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const r = Math.PI / 180;
  const h =
    Math.sin(((b.lat - a.lat) * r) / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(((b.lng - a.lng) * r) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

async function main() {
  const rows = (JSON.parse(await readFile(SRC, 'utf8')) as TourRow[]).filter((r) => +r.refine_wgs84_lat && +r.refine_wgs84_logt);
  const index = JSON.parse(await readFile(path.join(OUT, 'index.json'), 'utf8')) as HeritageIndex;
  index.items = index.items.filter((i) => !i.tour);
  const base = [...index.items];

  let merged = 0;
  let added = 0;
  for (const r of rows) {
    const p = { lat: +r.refine_wgs84_lat, lng: +r.refine_wgs84_logt };
    const name = r.tursm_info_nm.trim();
    const n = norm(name);
    let best: { it: HeritageSummary; score: number } | undefined;
    for (const it of base) {
      const d = distance(p, it);
      if (d > 800) continue;
      const s = similarity(n, norm(it.name));
      if (s >= 0.5 || (d < 80 && s >= 0.25)) {
        const score = s - d / 2000;
        if (!best || score > best.score) best = { it, score };
      }
    }

    if (best) {
      // 기존 유적에 전화번호만 보탠다
      if (r.telno) {
        const file = path.join(OUT, 'detail', `${best.it.id}.json`);
        const d = JSON.parse(await readFile(file, 'utf8')) as HeritageDetail;
        if (!d.tel) {
          d.tel = r.telno;
          await writeFile(file, JSON.stringify(d));
        }
      }
      merged++;
      continue;
    }

    const id = `tr-${createHash('sha1').update(`${r.sigun_nm}|${name}`).digest('hex').slice(0, 10)}`;
    const address = r.refine_road_nm_addr || r.refine_lotno_addr;
    const detail: HeritageDetail = {
      id,
      name,
      nameHanja: '',
      designation: `${r.sigun_nm} 역사관광지`,
      category: '역사관광지',
      subCategory: '역사관광지',
      era: '',
      city: r.sigun_nm,
      address,
      designatedAt: '',
      lat: p.lat,
      lng: p.lng,
      images: [],
      description: `${r.sigun_nm}의 역사관광지입니다. 경기도 역사관광지 현황(${r.dat_crtr_ymd.slice(0, 4)}년 기준)에 등록된 곳으로, 자세한 이야기는 해설사에게 물어보세요.`,
      sourceUrl: 'https://data.gg.go.kr/',
      tel: r.telno || undefined,
      tour: true,
    };
    await writeFile(path.join(OUT, 'detail', `${id}.json`), JSON.stringify(detail));
    index.items.push({
      id,
      name,
      designation: detail.designation,
      category: detail.category,
      era: '',
      city: r.sigun_nm,
      lat: Math.round(p.lat * 1e6) / 1e6,
      lng: Math.round(p.lng * 1e6) / 1e6,
      tour: true,
    });
    added++;
  }

  index.count = index.items.length;
  index.source = '국가유산청 오픈API · 공공데이터포털 전국향토유산표준데이터 · 경기도 역사관광지 현황';
  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  console.log(`역사관광지 ${rows.length}곳: 기존 유적과 겹침 ${merged}곳(전화번호 보강), 새로 추가 ${added}곳 → 전체 ${index.count}곳`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
