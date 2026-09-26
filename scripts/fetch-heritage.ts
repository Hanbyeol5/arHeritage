/**
 * 국가유산청 오픈API 수집 파이프라인
 *
 * 1) 목록 API로 대상 지역(기본: 경기 31) 전체 목록 수집
 * 2) 좌표가 있고 지정해제되지 않은 항목만 상세·이미지 API 호출
 * 3) 앱용 JSON 생성
 *    - public/data/index.json          : 지도/AR용 경량 목록
 *    - public/data/detail/<id>.json    : 상세 카드용 (설명문, 이미지 등)
 *
 * 원본 XML은 .cache/khs 에 저장해 재실행 시 재사용한다. (--refresh 로 무시)
 * 사용: npm run data:fetch [-- --region=31 --refresh]
 */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import type { HeritageDetail, HeritageIndex, HeritageSummary } from '../src/types.ts';

const BASE = 'https://www.khs.go.kr/cha';
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  }),
);
const REGION = args.region ?? '31'; // 31 = 경기
const REFRESH = args.refresh === 'true';
const CONCURRENCY = 4;
const MAX_IMAGES = 6;

const ROOT = path.resolve(import.meta.dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'khs');
const OUT_DIR = path.join(ROOT, 'public', 'data');

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false, // 관리번호(0000040000000) 등이 숫자로 바뀌지 않도록
  trimValues: true,
  isArray: (name) => ['item', 'sn', 'imageUrl', 'ccimDesc', 'imageNuri'].includes(name),
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchXml(url: string, cacheKey: string): Promise<any> {
  const cacheFile = path.join(CACHE_DIR, `${cacheKey}.xml`);
  let xml: string | undefined;
  if (!REFRESH && existsSync(cacheFile)) {
    xml = await readFile(cacheFile, 'utf8');
  } else {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        xml = await res.text();
        if (!xml.includes('<result')) throw new Error('unexpected response');
        break;
      } catch (e) {
        if (attempt >= 4) throw new Error(`${url} 요청 실패: ${(e as Error).message}`);
        await sleep(1000 * attempt);
      }
    }
    await mkdir(path.dirname(cacheFile), { recursive: true });
    await writeFile(cacheFile, xml);
  }
  return parser.parse(xml).result;
}

/** http 이미지 주소는 HTTPS 페이지에서 차단될 수 있으므로 https 로 변환 */
const toHttps = (url?: string) => (url ? url.replace(/^http:\/\//, 'https://') : undefined);

const str = (v: unknown) => (v == null ? '' : String(v).trim());

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
        done++;
        if (done % 50 === 0 || done === items.length) {
          process.stdout.write(`\r  상세 수집 ${done}/${items.length}`);
        }
      }
    }),
  );
  process.stdout.write('\n');
  return results;
}

async function fetchList() {
  const pageUnit = 300;
  const items: any[] = [];
  for (let page = 1; ; page++) {
    const url = `${BASE}/SearchKindOpenapiList.do?ccbaCtcd=${REGION}&pageUnit=${pageUnit}&pageIndex=${page}`;
    const res = await fetchXml(url, `list-${REGION}-${page}`);
    const pageItems = res.item ?? [];
    items.push(...pageItems);
    const total = Number(res.totalCnt);
    console.log(`  목록 ${page}페이지: 누적 ${items.length}/${total}`);
    if (pageItems.length === 0 || items.length >= total) break;
  }
  return items;
}

async function main() {
  console.log(`[1/3] 목록 수집 (지역코드 ${REGION})`);
  const list = await fetchList();

  const targets = list.filter(
    (it) => str(it.ccbaCncl) !== 'Y' && Number(it.latitude) !== 0 && Number(it.longitude) !== 0,
  );
  console.log(`  좌표 보유·지정 유지: ${targets.length}건 (제외 ${list.length - targets.length}건)`);

  console.log('[2/3] 상세·이미지 수집');
  const details = await mapLimit(targets, CONCURRENCY, async (it) => {
    const key = `${it.ccbaKdcd}-${it.ccbaAsno}-${it.ccbaCtcd}`;
    const q = `ccbaKdcd=${it.ccbaKdcd}&ccbaAsno=${it.ccbaAsno}&ccbaCtcd=${it.ccbaCtcd}`;
    const dt = await fetchXml(`${BASE}/SearchKindOpenapiDt.do?${q}`, `dt-${key}`);
    const img = await fetchXml(`${BASE}/SearchImageOpenapi.do?${q}`, `img-${key}`);
    const d = dt.item?.[0] ?? {};

    const imgItem = img.item?.[0] ?? {};
    const urls: string[] = imgItem.imageUrl ?? [];
    const descs: string[] = imgItem.ccimDesc ?? [];
    const images = urls
      .slice(0, MAX_IMAGES)
      .map((u, i) => ({ url: toHttps(str(u))!, desc: str(descs[i]) }))
      .filter((x) => x.url);

    const detail: HeritageDetail = {
      id: key,
      name: str(it.ccbaMnm1),
      nameHanja: str(it.ccbaMnm2),
      designation: str(it.ccmaName),
      category: str(d.gcodeName),
      subCategory: [d.bcodeName, d.mcodeName, d.scodeName].map(str).filter(Boolean).join(' > '),
      era: str(d.ccceName),
      city: str(it.ccsiName),
      address: str(d.ccbaLcad),
      designatedAt: str(d.ccbaAsdt),
      lat: Number(it.latitude),
      lng: Number(it.longitude),
      image: toHttps(str(d.imageUrl)) || images[0]?.url,
      images,
      description: str(d.content),
      sourceUrl: `https://www.heritage.go.kr/heri/cul/culSelectDetail.do?ccbaCpno=${str(it.ccbaCpno)}`,
    };
    return detail;
  });

  console.log('[3/3] JSON 생성');
  await rm(path.join(OUT_DIR, 'detail'), { recursive: true, force: true });
  await mkdir(path.join(OUT_DIR, 'detail'), { recursive: true });

  const summaries: HeritageSummary[] = [];
  for (const d of details) {
    await writeFile(path.join(OUT_DIR, 'detail', `${d.id}.json`), JSON.stringify(d));
    summaries.push({
      id: d.id,
      name: d.name,
      designation: d.designation,
      category: d.category,
      era: d.era,
      city: d.city,
      lat: Math.round(d.lat * 1e6) / 1e6,
      lng: Math.round(d.lng * 1e6) / 1e6,
      thumb: d.image,
    });
  }
  const index: HeritageIndex = {
    region: REGION,
    generatedAt: new Date().toISOString(),
    source: '국가유산청 오픈API',
    count: summaries.length,
    items: summaries,
  };
  await writeFile(path.join(OUT_DIR, 'index.json'), JSON.stringify(index));

  const byCategory = summaries.reduce<Record<string, number>>((acc, s) => {
    acc[s.category || '(미분류)'] = (acc[s.category || '(미분류)'] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`  완료: ${summaries.length}건`, byCategory);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
