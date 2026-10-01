// 인물 초상 처리 — 생성한 초상 이미지를 메달용 정사각 JPG 와 AR 컷아웃(배경 제거 WebP)으로 만들고
// public/data/figures.json 의 portrait·cutout 을 채운다.
//
//   cd tools && npm install
//   node make-cutout.mjs <인물 id> <이미지 경로> [left,top,width,height]
//   예) node make-cutout.mjs hyojong ./hyojong.png
//       node make-cutout.mjs taejo ./taejo-full.jpg 170,88,310,310   (얼굴·상반신 부분만 잘라 쓰기)
//
// 결과: public/figures/<id>.jpg (512px, 메달) · public/figures/<id>-cutout.webp (512px, 투명 배경)
// 초상 프롬프트는 docs/SETUP.md 「인물 초상 만들기」 참고.
import { removeBackground } from '@imgly/background-removal-node';
import sharp from 'sharp';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');
const [id, src, cropArg] = process.argv.slice(2);
if (!id || !src) {
  console.error('사용법: node make-cutout.mjs <인물 id> <이미지 경로> [left,top,width,height]');
  process.exit(1);
}
const FIG = path.join(ROOT, 'public', 'data', 'figures.json');
const data = JSON.parse(await readFile(FIG, 'utf8'));
const figure = data.figures.find((f) => f.id === id);
if (!figure) throw new Error(`figures.json 에 '${id}' 인물이 없습니다.`);

/**
 * AI 마스크가 놓친 부분(모자 날개 등)을 배경색 거리 키잉으로 복원한다.
 * 모서리 평균색과 먼 픽셀 중 AI 마스크와 이어진 영역만 살려 배경 얼룩은 버린다.
 */
function keyFix(rgba, mask, W, H) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = 0; y < 24; y++)
    for (const x of [...Array(24).keys(), ...Array.from({ length: 24 }, (_, i) => W - 1 - i)]) {
      const i = (y * W + x) * 4;
      r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
    }
  r /= n; g /= n; b /= n;
  const key = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const d = Math.hypot(rgba[i * 4] - r, rgba[i * 4 + 1] - g, rgba[i * 4 + 2] - b);
    key[i] = d > 70 ? 255 : d < 40 ? 0 : Math.round(((d - 40) / 30) * 255);
  }
  const keep = new Uint8Array(W * H);
  const stack = [];
  for (let i = 0; i < W * H; i++) if (mask[i * 4 + 3] > 128) { keep[i] = 1; stack.push(i); }
  while (stack.length) {
    const i = stack.pop(), x = i % W, y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (!keep[j] && key[j] > 128) { keep[j] = 1; stack.push(j); }
    }
  }
  const out = Buffer.from(rgba);
  for (let i = 0; i < W * H; i++) out[i * 4 + 3] = Math.max(mask[i * 4 + 3], keep[i] ? key[i] : 0);
  return out;
}

let img = sharp(src);
if (cropArg) {
  const [left, top, width, height] = cropArg.split(',').map(Number);
  img = img.extract({ left, top, width, height });
}
const square = await img.resize(512, 512, { fit: 'cover' }).jpeg({ quality: 86 }).toBuffer();
await writeFile(path.join(ROOT, 'public', 'figures', `${id}.jpg`), square);

const cut = await removeBackground(new Blob([square], { type: 'image/jpeg' }), { model: 'medium', output: { format: 'image/png' } });
const mask = await sharp(Buffer.from(await cut.arrayBuffer())).ensureAlpha().raw().toBuffer();
const rgba = await sharp(square).ensureAlpha().raw().toBuffer();
await sharp(keyFix(rgba, mask, 512, 512), { raw: { width: 512, height: 512, channels: 4 } })
  .webp({ quality: 88, alphaQuality: 100 })
  .toFile(path.join(ROOT, 'public', 'figures', `${id}-cutout.webp`));

// figures.json 갱신: 초상이 생기면 전신 실루엣 대신 컷아웃을 쓴다
figure.portrait = `figures/${id}.jpg`;
figure.cutout = `figures/${id}-cutout.webp`;
figure.imagined = true;
figure.portraitCredit ??= '전해지는 진본 초상이 없어 조선 초상화 양식으로 새로 그린 상상 초상 (AI 생성)';
delete figure.fullBody;
await writeFile(FIG, `${JSON.stringify(data, null, 2)}\n`);
console.log(`완료: public/figures/${id}.jpg, ${id}-cutout.webp, figures.json 갱신`);
