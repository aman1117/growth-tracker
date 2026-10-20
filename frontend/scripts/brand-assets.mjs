#!/usr/bin/env node
/**
 * Brand asset generator — `npm run brand:assets`
 *
 * Renders every static logo asset from the same geometry the in-app <BrandLogo> draws
 * (src/components/ui/BrandLogo/brandGeometry.json), so all surfaces match:
 *   - web app: favicon (SVG + ICO), Apple touch icon, PWA "any" + maskable icons,
 *     and the monochrome badge shown in the Android status bar for push notifications
 *   - help center (faq/): favicon and header icon
 *   - Android TWA (twa/): launcher, maskable, splash and notification icons
 *   - docs (docs/brand/): full lockups for light and dark backgrounds (README header)
 *
 * Solid fills only: the brand has no gradient logo anywhere.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(here, '..');
const repoDir = path.resolve(frontendDir, '..');

/** Keep in sync with the --brand-* tokens in src/styles/tokens.css */
export const PALETTE = {
  tile: '#6447f2',
  tileLeaf: '#ffffff',
  tileSprout: '#a3e635',
  leafLight: '#6447f2',
  sproutLight: '#22c55e',
  leafDark: '#a594ff',
  sproutDark: '#a3e635',
  inkLight: '#17142c',
  inkDark: '#f3f1ff',
};

const geometry = JSON.parse(
  await readFile(path.join(frontendDir, 'src/components/ui/BrandLogo/brandGeometry.json'), 'utf8')
);
const { mark, icon } = geometry;

const round = (n) => Number(n.toFixed(3));

/** Mark height as a fraction of the canvas (maskable stays inside the 80% safe zone) */
const FAVICON_MARK_HEIGHT = 0.86;
const MASKABLE_MARK_HEIGHT = 0.46;

const leaves = (leaf, sprout) =>
  `<path fill="${sprout}" d="${mark.leafShort}"/><path fill="${leaf}" d="${mark.leafLong}"/>`;

// Optical offset of the mark inside the app-icon tile, as a fraction of the tile
const centeredX = (icon.size - mark.width * icon.mark.scale) / 2;
const centeredY = (icon.size - mark.height * icon.mark.scale) / 2;
const nudge = {
  x: (icon.mark.x - centeredX) / icon.size,
  y: (icon.mark.y - centeredY) / icon.size,
};

/** Transform that centers the mark on a 100-unit canvas at `height` (fraction of the canvas) */
function placeMark(height) {
  const scale = (100 * height) / mark.height;
  const x = (100 - mark.width * scale) / 2 + nudge.x * 100;
  const y = (100 - mark.height * scale) / 2 + nudge.y * 100;
  return `translate(${round(x)} ${round(y)}) scale(${round(scale)})`;
}

const svgDoc = (px, body, viewBox = '0 0 100 100') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="${viewBox}">${body}</svg>`;

/** Rounded app-icon tile: PWA "any" icon, TWA launcher, help-center header */
export function tileSvg(px, { scale = 1 } = {}) {
  const inset = (100 - 100 * scale) / 2;
  const t = icon.mark;
  return svgDoc(
    px,
    `<g transform="translate(${round(inset)} ${round(inset)}) scale(${round(scale)})">` +
      `<rect width="100" height="100" rx="${icon.radius}" fill="${PALETTE.tile}"/>` +
      `<g transform="translate(${t.x} ${t.y}) scale(${t.scale})">${leaves(PALETTE.tileLeaf, PALETTE.tileSprout)}</g>` +
      `</g>`
  );
}

/** Full-bleed square for platforms that apply their own mask (maskable, Apple touch) */
export function fullBleedSvg(px, markHeight) {
  return svgDoc(
    px,
    `<rect width="100" height="100" fill="${PALETTE.tile}"/>` +
      `<g transform="${placeMark(markHeight)}">${leaves(PALETTE.tileLeaf, PALETTE.tileSprout)}</g>`
  );
}

/** White silhouette on transparent: Android only uses the alpha channel of badge icons */
export function silhouetteSvg(px, markHeight) {
  return svgDoc(px, `<g transform="${placeMark(markHeight)}">${leaves('#ffffff', '#ffffff')}</g>`);
}

/** Bare two-tone mark on transparent (light palette): favicon.ico fallback */
export function markSvg(px) {
  return svgDoc(
    px,
    `<g transform="${placeMark(FAVICON_MARK_HEIGHT)}">${leaves(PALETTE.leafLight, PALETTE.sproutLight)}</g>`
  );
}

/** Favicon: the bare mark, recolored for dark browser chrome */
export function faviconSvg() {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<style>.l{fill:${PALETTE.leafLight}}.s{fill:${PALETTE.sproutLight}}` +
    `@media (prefers-color-scheme:dark){.l{fill:${PALETTE.leafDark}}.s{fill:${PALETTE.sproutDark}}}</style>` +
    `<g transform="${placeMark(FAVICON_MARK_HEIGHT)}"><path class="s" d="${mark.leafShort}"/><path class="l" d="${mark.leafLong}"/></g>` +
    `</svg>\n`
  );
}

/** Full lockup (mark + wordmark) for docs, e.g. the README header */
export function lockupSvg(onDark) {
  const { lockup, wordmark } = geometry;
  const leaf = onDark ? PALETTE.leafDark : PALETTE.leafLight;
  const sprout = onDark ? PALETTE.sproutDark : PALETTE.sproutLight;
  const ink = onDark ? PALETTE.inkDark : PALETTE.inkLight;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lockup.width} ${lockup.height}" role="img" aria-label="${geometry.name}">` +
    `<title>${geometry.name}</title>` +
    `<g transform="translate(${lockup.mark.x} ${lockup.mark.y}) scale(${lockup.mark.scale})">${leaves(leaf, sprout)}</g>` +
    `<path fill="${ink}" transform="translate(${lockup.wordmark.x} ${lockup.wordmark.y})" d="${wordmark.path}"/>` +
    `</svg>\n`
  );
}

const png = (svg) => sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();

/** Multi-size ICO with PNG-encoded entries (supported by every browser that reads .ico) */
async function icoFromSvg(sizes, render) {
  const images = await Promise.all(
    sizes.map(async (size) => ({ size, data: await png(render(size)) }))
  );
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach(({ size, data }, i) => {
    const o = i * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, o);
    directory.writeUInt8(size >= 256 ? 0 : size, o + 1);
    directory.writeUInt16LE(1, o + 4);
    directory.writeUInt16LE(32, o + 6);
    directory.writeUInt32LE(data.length, o + 8);
    directory.writeUInt32LE(offset, o + 12);
    offset += data.length;
  });
  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

const ANDROID_DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

export function targets() {
  const web = (file) => path.join(frontendDir, 'public', file);
  const list = [
    { out: web('favicon.svg'), text: faviconSvg },
    { out: web('favicon.ico'), ico: [16, 32, 48] },
    { out: web('apple-touch-icon-180x180.png'), svg: () => fullBleedSvg(180, 0.6) },
    { out: web('pwa-192x192.png'), svg: () => tileSvg(192) },
    { out: web('pwa-512x512.png'), svg: () => tileSvg(512) },
    { out: web('pwa-maskable-192x192.png'), svg: () => fullBleedSvg(192, MASKABLE_MARK_HEIGHT) },
    { out: web('pwa-maskable-512x512.png'), svg: () => fullBleedSvg(512, MASKABLE_MARK_HEIGHT) },
    { out: web('badge-96x96.png'), svg: () => silhouetteSvg(96, 0.74) },
    { out: path.join(repoDir, 'docs/brand/logo-on-light.svg'), text: () => lockupSvg(false) },
    { out: path.join(repoDir, 'docs/brand/logo-on-dark.svg'), text: () => lockupSvg(true) },
    { out: path.join(repoDir, 'faq/public/favicon.svg'), text: faviconSvg, optional: true },
    {
      out: path.join(repoDir, 'faq/public/brand-icon.svg'),
      text: () => `${tileSvg(64)}\n`,
      optional: true,
    },
  ];

  const res = path.join(repoDir, 'twa/app/src/main/res');
  for (const [density, k] of Object.entries(ANDROID_DENSITIES)) {
    const px = (dp) => Math.round(dp * k);
    list.push(
      {
        out: path.join(res, `mipmap-${density}/ic_launcher.png`),
        svg: () => tileSvg(px(48)),
        optional: true,
      },
      {
        out: path.join(res, `mipmap-${density}/ic_maskable.png`),
        svg: () => fullBleedSvg(px(82), MASKABLE_MARK_HEIGHT),
        optional: true,
      },
      {
        out: path.join(res, `drawable-${density}/splash.png`),
        svg: () => tileSvg(px(300), { scale: 0.44 }),
        optional: true,
      },
      {
        out: path.join(res, `drawable-${density}/ic_notification_icon.png`),
        svg: () => silhouetteSvg(px(24), 0.8),
        optional: true,
      }
    );
  }
  return list;
}

const exists = (p) =>
  access(p).then(
    () => true,
    () => false
  );

async function main() {
  let written = 0;
  for (const target of targets()) {
    const dir = path.dirname(target.out);
    if (target.optional && !(await exists(dir))) {
      console.log(`[brand-assets] skip (missing ${path.relative(repoDir, dir)})`);
      continue;
    }
    await mkdir(dir, { recursive: true });
    let data;
    if (target.text) data = target.text();
    else if (target.ico) data = await icoFromSvg(target.ico, (size) => markSvg(size));
    else data = await png(target.svg());
    await writeFile(target.out, data);
    written += 1;
    console.log(`[brand-assets] ${path.relative(repoDir, target.out)} (${data.length} bytes)`);
  }
  console.log(`[brand-assets] done: ${written} files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error('[brand-assets] failed:', error);
    process.exit(1);
  });
}
