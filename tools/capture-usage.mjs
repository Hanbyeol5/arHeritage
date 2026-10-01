// 사용법 문서(USAGE.md)용 화면 캡처 — 배포된 웹앱을 폰 크기로 열어 화면별로 찍어 docs/images/ 에 저장한다.
//
//   cd tools && npm install
//   node capture-usage.mjs                 # 전체
//   node capture-usage.mjs 05-ar 08-talk   # 지정한 화면만
//
// 환경 변수
//   BASE_URL     캡처할 주소 (기본 https://samcho93.github.io/arHeritage/)
//   CHROME_PATH  Chrome/Edge 실행 파일 (기본: 설치 경로 자동 탐색)
//   CAMERA_JPG   가짜 카메라 화면으로 쓸 사진 (ffmpeg 가 있으면 사용, 기본: 수원 화성 사진을 내려받음)
import puppeteer from 'puppeteer-core';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const HERE = import.meta.dirname;
const BASE = process.env.BASE_URL ?? 'https://samcho93.github.io/arHeritage/';
const OUT = path.join(HERE, '..', 'docs', 'images');
const CACHE = path.join(HERE, '.cache');
const Q = '?lat=37.2818&lng=127.0137'; // 데모 위치: 수원 화성행궁
const only = process.argv.slice(2);
await mkdir(OUT, { recursive: true });
await mkdir(CACHE, { recursive: true });

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const list = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const hit = list.find((p) => existsSync(p));
  if (!hit) throw new Error('Chrome/Edge 를 찾지 못했습니다. CHROME_PATH 환경 변수로 지정하세요.');
  return hit;
}

/** 가짜 카메라 영상(Y4M) — ffmpeg 가 없으면 Chrome 기본 시험 화면을 쓴다 */
async function fakeCamera() {
  const y4m = path.join(CACHE, 'cam.y4m');
  if (existsSync(y4m)) return y4m;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  } catch {
    console.log('ffmpeg 가 없어 카메라 화면은 Chrome 기본 시험 화면으로 찍힙니다.');
    return undefined;
  }
  let jpg = process.env.CAMERA_JPG;
  if (!jpg) {
    jpg = path.join(CACHE, 'cam.jpg');
    const res = await fetch('https://www.khs.go.kr/unisearch/images/history_site/1625386.jpg'); // 수원 화성
    await writeFile(jpg, Buffer.from(await res.arrayBuffer()));
  }
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', jpg, '-t', '0.5', '-r', '10', '-vf', 'scale=-2:1280,crop=720:1280', '-pix_fmt', 'yuv420p', y4m]);
  return y4m;
}

const cam = await fakeCamera();
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    ...(cam ? [`--use-file-for-fake-video-capture=${cam.replace(/\\/g, '/')}`] : []),
    '--autoplay-policy=no-user-gesture-required',
    '--lang=ko-KR',
  ],
});
const page = await browser.newPage();
await page.emulate({
  viewport: { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36',
});
await browser.defaultBrowserContext().overridePermissions(new URL(BASE).origin, ['geolocation', 'camera', 'microphone']);
await page.setGeolocation({ latitude: 37.2818, longitude: 127.0137 });
await page.evaluateOnNewDocument(() => {
  // 나침반 흉내: 폰을 세워 들고 window.__heading(도) 방향을 보는 값 (300° = 북서, 수원 화성 쪽)
  window.__heading = 300;
  setInterval(() => {
    const a = (360 - window.__heading) % 360;
    for (const t of ['deviceorientationabsolute', 'deviceorientation'])
      window.dispatchEvent(new DeviceOrientationEvent(t, { alpha: a, beta: 90, gamma: 0, absolute: true }));
  }, 50);
});
page.on('pageerror', (e) => console.log('pageerror', e.message));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => {
  if (only.length && !only.includes(name)) return;
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: 'jpeg', quality: 82 });
  console.log('shot', name);
};
const go = async (hash, ms = 2500) => {
  await page.evaluate((h) => (location.hash = h), hash);
  await wait(ms);
};
const click = (sel) => page.evaluate((s) => document.querySelector(s)?.click(), sel);

// 1. 시작 화면
await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.waitForSelector('.start', { timeout: 20000 });
await wait(800);
await shot('01-start');

// 대화 방식을 RAG 로 해 두고 데모 위치로 연다
await page.evaluate(() => {
  const k = 'yeoksadam:v2';
  const d = JSON.parse(localStorage.getItem(k) ?? '{}');
  localStorage.setItem(k, JSON.stringify({ ...d, chatMode: 'rag' }));
});
await page.goto(`${BASE}${Q}#/home`, { waitUntil: 'networkidle2' });
await wait(3000);
await shot('02-home');

await go('#/figures', 5000);
await shot('03-figures');

// 지도: 1km 반경 원
await go('#/map', 5000);
await click('.map-radius [data-r="1000"]');
await wait(2500);
await shot('04-map');

// AR — 몰입 모드라 화면을 한 번 눌러야 버튼이 나타난다
await page.goto(`${BASE}${Q}#/ar`, { waitUntil: 'networkidle2' });
await wait(5000);
await page.touchscreen.tap(195, 780);
await wait(700);
await shot('05-ar');
await page.evaluate(() => {
  const l = [...document.querySelectorAll('.ar-label')].find((e) => /화성/.test(e.textContent) && getComputedStyle(e).display !== 'none');
  (l ?? document.querySelector('.ar-label'))?.click();
});
await wait(2000);
await shot('06-ar-card');
await click('[data-act=info]');
await wait(3500);
await shot('07-heritage');

// 인물 대화 (RAG 서버 방식) — 글로 질문하고 근거가 붙을 때까지 기다린다
await page.goto(`${BASE}${Q}#/talk/jeongjo`, { waitUntil: 'networkidle2' });
await wait(12000);
await click('.tk-kbd');
await wait(500);
await page.type('.tk-type input', '화성은 왜 쌓으셨습니까?');
await page.keyboard.press('Enter');
await page.waitForSelector('.tk-src', { timeout: 60000 }).catch(() => console.log('근거 표시 없음'));
await wait(1500);
await shot('08-talk');

// 카메라 인식
await go('#/camera', 3000);
await shot('09-camera');
await click('.shutter');
await page.waitForSelector('.result-card', { timeout: 60000 }).catch(() => console.log('인식 결과 없음'));
await wait(3000);
await shot('10-camera-result');

await go('#/qa', 3000);
await shot('11-qa');

await go('#/profile', 1500);
await click('.settings summary');
await wait(800);
await shot('12-profile');

await go('#/notifications', 1500);
await shot('13-notifications');

// RAG 자료 편집기 (PC 화면)
await page.emulate({ viewport: { width: 1280, height: 800, deviceScaleFactor: 1.5 }, userAgent: await browser.userAgent() });
await page.goto(`${BASE}editor/`, { waitUntil: 'networkidle2' });
await wait(1500);
await page.type('.ed-search input', '남한산성');
await wait(500);
await click('.ed-list .it');
await wait(2500);
await shot('14-editor');

await browser.close();
