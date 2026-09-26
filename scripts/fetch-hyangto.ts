/**
 * 향토유산(시·군 지정) 수집 — 공공데이터포털 '전국향토유산표준데이터'(15021147)
 *
 * 국가유산청 데이터(fetch-heritage)에는 시·군이 지정한 향토유산이 없으므로 별도로 받아
 * public/data/index.json 에 추가하고 detail/hy-*.json 을 만든다.
 * 반드시 fetch-heritage 다음에 실행한다 (그 스크립트가 index.json 과 detail/ 을 새로 쓰기 때문).
 *
 * 인증키 없이 포털의 파일 내려받기와 같은 경로를 쓴다 (페이지 방문 → 세션 쿠키 → 목록·데이터 JSON).
 * 사용: npm run data:hyangto
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { HeritageDetail, HeritageIndex, HeritageSummary } from '../src/types.ts';

const PK = '15021147';
const PAGE = `https://www.data.go.kr/data/${PK}/standard.do`;
const ROOT = path.resolve(import.meta.dirname, '..');
const OUT = path.join(ROOT, 'public', 'data');
/** 경기도를 감싸는 범위 — 다른 시·도 좌표가 섞인 행을 거른다 */
const BOUNDS = { south: 36.85, west: 126.3, north: 38.35, east: 127.9 };

let cookie = '';
async function get(url: string): Promise<Response> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (yeoksadam data pipeline)', Referer: PAGE, 'X-Requested-With': 'XMLHttpRequest', Cookie: cookie },
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = [...cookie.split('; ').filter(Boolean), ...set.map((c) => c.split(';')[0])].join('; ');
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res;
}

async function main() {
  console.log('[1/3] 공공데이터포털 세션 · 열 정보');
  await get(PAGE);
  const header = (await (await get(`https://www.data.go.kr/download/columList.json?pk=${PK}&ext=JSON`)).json()) as {
    totalCount: number;
    columList: { columCode: string; columNm: string }[];
    tableVO: { colNmList: string[]; svcTableNm: string };
  };
  const names = Object.fromEntries(header.columList.map((c) => [c.columCode, c.columNm]));

  console.log(`[2/3] 전국 ${header.totalCount}건 내려받기`);
  const rows: Record<string, string>[] = [];
  for (let page = 1; page <= Math.ceil(header.totalCount / 10000); page++) {
    const q = new URLSearchParams({ publicDataPk: PK, totalCount: String(header.totalCount), svcTableNm: header.tableVO.svcTableNm, perPage: '10000', page: String(page) });
    header.tableVO.colNmList.forEach((c) => q.append('colNmList', c));
    const part = (await (await get(`https://www.data.go.kr/download/standard.json?${q}`)).json()) as Record<string, string>[];
    for (const r of part) rows.push(Object.fromEntries(Object.entries(r).map(([k, v]) => [names[k] ?? k, v ?? ''])));
  }

  const gg = rows.filter((r) => {
    const lat = Number(r['위도']);
    const lng = Number(r['경도']);
    return (r['제공기관명'] ?? '').startsWith('경기도') && lat > BOUNDS.south && lat < BOUNDS.north && lng > BOUNDS.west && lng < BOUNDS.east;
  });
  console.log(`  경기도 좌표 보유 ${gg.length}건`);

  console.log('[3/3] JSON 생성');
  const index = JSON.parse(await readFile(path.join(OUT, 'index.json'), 'utf8')) as HeritageIndex;
  index.items = index.items.filter((i) => !i.local);
  const seen = new Set<string>();
  for (const r of gg) {
    const city = r['제공기관명'].replace(/^경기도\s*/, '');
    const hash = createHash('sha1').update(`${r['제공기관코드']}|${r['문화유산지정번호']}|${r['향토유산명']}`).digest('hex').slice(0, 10);
    const id = `hy-${hash}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const kind = [r['향토유산구분'], r['향토유산종류']].filter(Boolean).join(' · ');
    const address = r['소재지도로명주소'] || r['소재지지번주소'];
    const detail: HeritageDetail = {
      id,
      name: r['향토유산명'],
      nameHanja: '',
      designation: `${city} 향토유산`,
      category: r['향토유산구분'].includes('무형') ? '무형유산' : '향토유적',
      subCategory: kind,
      era: r['조성시대'],
      city,
      address,
      designatedAt: r['지정일자'].replaceAll('-', ''),
      lat: Number(r['위도']),
      lng: Number(r['경도']),
      images: [],
      description: r['향토유산소개'] || `${city}에서 지정한 향토유산(${kind})입니다.`,
      sourceUrl: PAGE,
      local: true,
    };
    await writeFile(path.join(OUT, 'detail', `${id}.json`), JSON.stringify(detail));
    const summary: HeritageSummary = {
      id,
      name: detail.name,
      designation: detail.designation,
      category: detail.category,
      era: detail.era,
      city,
      lat: Math.round(detail.lat * 1e6) / 1e6,
      lng: Math.round(detail.lng * 1e6) / 1e6,
      local: true,
    };
    index.items.push(summary);
  }
  index.count = index.items.length;
  index.source = '국가유산청 오픈API · 공공데이터포털 전국향토유산표준데이터';
  await writeFile(path.join(OUT, 'index.json'), JSON.stringify(index));
  console.log(`  완료: 향토유산 ${seen.size}건 추가, 전체 ${index.count}건`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
