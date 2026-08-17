#!/usr/bin/env node
/**
 * Render an Instagram carousel from a spec file.
 *
 *   npm run render -- posts/mir-vsegda-za.json
 *
 * Each slide is a photo from `input/` cropped to the canvas, a gradient
 * vignette, and a line of copy placed where the frame has room for it.
 * Placement is measured from the photo itself (see `analyze.mjs`) unless the
 * spec pins a box.
 *
 * Output: numbered PNGs ready to post, a caption file, and a preview page.
 *
 * Flags:
 *   --out <dir>    output root                     (default: out)
 *   --size 4:5     canvas                          (4:5 | 1:1 | 9:16)
 *   --candidates   render every placement the analyser proposed, for a look
 *   --guides       draw the chosen text box and the 1:1 grid crop
 *   --jpg          write JPEG instead of PNG
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIZES, DEFAULT_SIZE, textSize, LINE_HEIGHT, SUPERSAMPLE, baseCss, rich, esc } from './theme.mjs';
import { findTextBox, measureBox, roundBox } from './analyze.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const run = promisify(execFile);

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * Vignette strength for a measured placement.
 *
 * Scaled to what the ground actually needs: a dark frame gets almost none, a
 * bright one gets enough to hold white type. A fixed strength either muddies
 * the dark frames or loses the type on the light ones.
 */
function vignetteFor(measured) {
  return measured.tone === 'dark'
    ? clamp((0.88 - measured.lum) * 2.6, 0.5, 1.8)
    : clamp((measured.lum - 0.12) * 2.6, 0.5, 1.8);
}

/**
 * How tall the copy will actually be, as a share of the canvas.
 *
 * The analyser needs the real footprint: reserving four lines' worth of space
 * for a two-line sentence pushes the box away from spots that would have fitted
 * it comfortably. Cyrillic in Inter averages close to half the point size per
 * glyph, which is near enough to count lines from.
 */
function textHeight(slide, boxW, size) {
  const fs = textSize(slide.size) * size.w;
  const perLine = Math.max(8, (boxW * size.w) / (fs * 0.5));
  const chars = [slide.text, slide.text2].filter(Boolean).join(' ').length;
  const lines = Math.max(1, Math.ceil(chars / perLine)) + (slide.text2 ? 1 : 0);
  return clamp((lines * LINE_HEIGHT * fs) / size.h, 0.05, 0.62);
}

/* ---------------------------------------------------------------- photos -- */

export const PHOTO_RE = /\.(jpe?g|png|webp|avif|heic|heif)$/i;

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Index everything under `input/`, subfolders included.
 *
 * Material for several posts can sit side by side — one folder per post —
 * so a shoot can be dropped in whole and worked through later:
 *
 *   input/kapstadt/IMG_4821.HEIC
 *   input/studio/IMG_5003.jpg
 *
 * A spec names a photo the way the file is named; case, spaces and punctuation
 * are ignored, so a phone's own filenames work untouched. Set `source` on the
 * spec to the post's folder and bare names resolve inside it, which keeps
 * `IMG_0001` in one shoot from colliding with `IMG_0001` in another.
 */
async function photoIndex() {
  const root = path.join(ROOT, 'input');

  const byPath = new Map();          // "kapstadt/img4821" -> file
  const byBase = new Map();          // "img4821" -> [file, …]

  async function walk(dir) {
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { await walk(full); continue; }
      if (!PHOTO_RE.test(e.name)) continue;

      const rel = path.relative(root, full).split(path.sep);
      const base = norm(rel.pop().replace(/\.[^.]+$/, ''));
      byPath.set([...rel.map(norm), base].join('/'), full);
      byBase.set(base, [...(byBase.get(base) ?? []), full]);
    }
  }
  await walk(root);

  return {
    get size() { return byPath.size; },
    /** Every name a spec could use, for the "no such photo" message. */
    names: () => [...byPath.keys()],
    /**
     * Resolve a spec's `photo`. Tries the post's own folder first, then the
     * name as a path, then the bare filename anywhere — and refuses to guess
     * when a bare name matches more than one shoot.
     */
    resolve(name, source) {
      const key = norm(name);
      if (source) {
        const scoped = byPath.get(`${norm(source)}/${key}`);
        if (scoped) return scoped;
      }
      const asPath = byPath.get(name.split('/').map(norm).join('/'));
      if (asPath) return asPath;

      const hits = byBase.get(key) ?? [];
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        throw new Error(`«${name}» есть в нескольких папках:\n    ` +
          hits.map((f) => path.relative(root, f)).join('\n    ') +
          '\n  Укажите папку в "source" или пишите путь: "папка/имя".');
      }
      return null;
    },
  };
}

/**
 * Tone curves.
 *
 * `base` is the house treatment and the default: brightness down a couple of
 * points and a touch of sharpening. Both are deliberately small — the point is
 * a slightly deeper, crisper frame that still looks like the photo you took,
 * not a filter.
 */
const GRADES = {
  base: { brightness: 0.96, sharpen: 0.8 },
  none: null,
  soft: { brightness: 0.98, sharpen: 0.5 },
  deep: { brightness: 0.93, saturation: 0.97, sharpen: 1.1 },
};

/**
 * Make sure sharp can actually open the file, and rescue it if not.
 *
 * iPhones shoot HEIC. sharp's bundled libvips normally decodes it, but that
 * depends on how the binary for a given platform was built, so it cannot be
 * assumed. When the decoder is missing, macOS can do the conversion itself:
 * `sips` is part of the system and reads HEIC natively. Converting to PNG
 * rather than JPEG keeps the rescue path lossless.
 */
async function ensureReadable(src, workDir) {
  try {
    await sharp(src).metadata();
    return src;
  } catch (err) {
    if (process.platform !== 'darwin') throw decodeError(src, err);
    const out = path.join(workDir, `${path.basename(src).replace(/\.[^.]+$/, '')}-converted.png`);
    try {
      await run('sips', ['-s', 'format', 'png', src, '--out', out]);
      return out;
    } catch {
      throw decodeError(src, err);
    }
  }
}

function decodeError(src, err) {
  return new Error(
    `не удалось открыть ${path.basename(src)}: ${err.message}\n` +
    '  Если это HEIC с айфона, снимайте в JPEG — Настройки → Камера → Форматы →\n' +
    '  «Наиболее совместимый», либо экспортируйте кадры в JPEG перед загрузкой.');
}

/**
 * Crop a photo to the canvas and grade it. Everything downstream — the
 * analysis and the render — works on this file, so the box the analyser picks
 * is the box the viewer sees.
 *
 * Prepared at the full render resolution and written as PNG. Handing the
 * browser a canvas-sized JPEG and letting it enlarge to the device pixels
 * costs real detail twice over: once to the browser's own scaling, once to
 * JPEG artefacts that the second encode then bakes in.
 */
async function prepPhoto(src, dest, { w, h }, { focus = 'centre', grade = 'base', workDir }) {
  src = await ensureReadable(src, workDir ?? path.dirname(dest));
  const position = focus === 'auto' ? sharp.strategy.attention : focus;
  const rw = w * SUPERSAMPLE, rh = h * SUPERSAMPLE;
  let img = sharp(src).rotate().resize(rw, rh, { fit: 'cover', position, kernel: 'lanczos3' });

  const g = GRADES[grade];
  if (g === undefined) throw new Error(`unknown grade "${grade}" — use ${Object.keys(GRADES).join(', ')}`);
  if (g) {
    const { sharpen, ...modulate } = g;
    if (Object.keys(modulate).length) img = img.modulate(modulate);
    // Sharpening happens at render resolution but is judged at output size, so
    // the radius scales with the supersample — otherwise it halves on the way
    // down and the "couple of points" turns into none.
    if (sharpen) img = img.sharpen({ sigma: sharpen * SUPERSAMPLE });
  }

  await img.png({ compressionLevel: 6 }).toFile(dest);
}

/* ------------------------------------------------------------------ html -- */

function slideHtml(s, i, cfg) {
  const box = s._box;
  const tone = s._tone;                       // 'light' = white type, 'dark' = ink
  const fs = textSize(s.size);
  const vs = s.vignette ?? s._vs ?? 1;        // vignette strength, 0 turns it off

  const vars = [
    `--bx:${box.x}`, `--by:${box.y}`, `--bw:${box.w}`, `--bh:${box.h}`,
    `--fs:${fs}`, `--pad:0.085`,
    `--vx:${((box.x + box.w / 2) * 100).toFixed(1)}%`,
    `--vy:${((box.y + box.h / 2) * 100).toFixed(1)}%`,
    `--vs:${vs}`, `--vp:${s.text ? 1 : 0}`,
  ].join(';');

  const copy = s.text
    ? `<div class="copy ${tone === 'dark' ? 'dark' : ''}">${rich(s.text)}${
        s.text2 ? `<span class="l2">${rich(s.text2)}</span>` : ''
      }</div>`
    : '';

  const handle = s.handle ?? (cfg.handle && i === cfg.slides.length - 1 ? cfg.handle : null);

  return `<div class="slide" style="${vars}">
  <div class="bg"><img src="${esc(s._url)}" alt=""></div>
  <div class="vig ${vs > 0 && s.text ? 'pool' : ''} ${tone === 'dark' ? 'inverted' : ''}"></div>
  ${copy}
  ${handle ? `<div class="handle ${tone === 'dark' ? 'dark' : ''}">${esc(handle)}</div>` : ''}
  <div class="guides ${cfg._guides ? 'on' : ''}"><div class="box"></div><div class="sq"></div></div>
</div>`;
}

function pageHtml(items, cfg, size) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<link rel="stylesheet" href="/fonts/fonts.css">
<style>${baseCss(size)}</style></head><body>
${items.map((it) => slideHtml(it.slide, it.index, cfg)).join('\n')}
</body></html>`;
}

/**
 * Expand the slides into what actually gets shot.
 *
 * Normally that is one frame per slide. With --candidates each slide with copy
 * is shot once per placement the analyser proposed, so the agent can look at
 * the real options side by side instead of guessing from coordinates.
 */
function renderItems(cfg, candidates) {
  const items = [];
  for (const [index, slide] of cfg.slides.entries()) {
    const opts = candidates && slide.text && !slide.box ? slide._options : null;
    if (!opts?.length) {
      items.push({ slide, index, name: String(index + 1).padStart(2, '0') });
      continue;
    }
    for (const [k, o] of opts.entries()) {
      items.push({
        index,
        name: `${String(index + 1).padStart(2, '0')}${'abcd'[k]}`,
        slide: { ...slide, _box: roundBox(o), _tone: o.tone, _vs: vignetteFor(o) },
      });
    }
  }
  return items;
}

/* ---------------------------------------------------------------- server -- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.avif': 'image/avif',
};

/**
 * Serve the agent folder over HTTP for the duration of the render.
 *
 * Chromium refuses to load webfonts cross-origin from `file://` URLs, and the
 * slides depend on the vendored Inter woff2 files — so the page is served
 * rather than opened from disk.
 */
async function serve(pageBody) {
  const server = http.createServer(async (req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (url === '/') {
      res.writeHead(200, { 'content-type': MIME['.html'] });
      return res.end(pageBody);
    }
    const file = path.join(ROOT, path.normalize(url).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
    try {
      await fs.access(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
      createReadStream(file).pipe(res);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, port: server.address().port };
}

/* ------------------------------------------------------------------ main -- */

function parseArgs(argv) {
  const args = { spec: null, out: 'out', size: null, guides: false, jpg: false, candidates: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--size') args.size = argv[++i];
    else if (a === '--guides') args.guides = true;
    else if (a === '--candidates') args.candidates = true;
    else if (a === '--jpg') args.jpg = true;
    else if (!a.startsWith('--')) args.spec = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.spec) {
    console.error('usage: npm run render -- <spec.json> [--out dir] [--size 4:5] [--candidates] [--guides] [--jpg]');
    process.exit(1);
  }

  const cfg = JSON.parse(await fs.readFile(path.resolve(args.spec), 'utf8'));
  const sizeKey = args.size ?? cfg.size ?? DEFAULT_SIZE;
  const size = SIZES[sizeKey];
  if (!size) throw new Error(`unknown size "${sizeKey}" — use ${Object.keys(SIZES).join(', ')}`);
  if (!Array.isArray(cfg.slides) || !cfg.slides.length) throw new Error('spec has no slides');
  if (cfg.slides.length > 20) {
    console.warn(`\n  ! ${cfg.slides.length} слайдов — Instagram принимает 20.`);
  }
  cfg._guides = args.guides;

  const slug = cfg.slug ?? path.basename(args.spec, '.json');
  const outDir = path.resolve(ROOT, args.out, slug);
  const workDir = path.join(outDir, '_photos');
  await fs.rm(outDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const photos = await photoIndex();

  // Prepare every photo, then measure where its copy can go.
  for (const [i, s] of cfg.slides.entries()) {
    if (!s.photo) throw new Error(`slide ${i + 1}: "photo" is required`);
    // Slide one is the title — it carries the whole post in the feed, so it is
    // set larger than the slides that follow unless the spec says otherwise.
    if (i === 0 && !s.size) s.size = 'l';
    const src = photos.resolve(s.photo, cfg.source) ??
      (await fs.access(path.resolve(ROOT, s.photo)).then(() => path.resolve(ROOT, s.photo), () => null));
    if (!src) {
      throw new Error(`слайд ${i + 1}: нет фотографии «${s.photo}» — положите файл в input/ или укажите путь.\n` +
        `  Есть в input/: ${photos.names().join(', ') || '(пусто)'}`);
    }

    const dest = path.join(workDir, `${String(i + 1).padStart(2, '0')}.png`);
    await prepPhoto(src, dest, size, { focus: s.focus, grade: s.grade ?? cfg.grade, workDir });
    s._url = `/${path.relative(ROOT, dest).split(path.sep).join('/')}`;

    if (s.text) {
      const boxW = s.box?.w ?? cfg.boxW ?? 0.46;
      const measured = await findTextBox(dest, {
        boxW,
        boxH: s.box?.h ?? textHeight(s, boxW, size),
        tone: s.tone && s.tone !== 'auto' ? s.tone : 'auto',
      });
      s._box = s.box ? { ...roundBox(measured), ...s.box } : roundBox(measured);
      s._options = measured.options;

      // A pinned box has to be read where it actually sits, not where the
      // analyser would have put it.
      const at = s.box
        ? await measureBox(dest, s._box, s.tone && s.tone !== 'auto' ? s.tone : 'auto')
        : measured;
      s._tone = at.tone;
      s._detail = at.detail;
      s._lum = at.lum;
      s._vs = vignetteFor(at);
    } else {
      s._box = { x: 0.085, y: 0.085, w: 0.46, h: 0.16 };
      s._tone = 'light';
    }
  }

  // Render.
  const items = renderItems(cfg, args.candidates);
  const { server, port } = await serve(pageHtml(items, cfg, size));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: size.w + 80, height: size.h + 80 },
      deviceScaleFactor: SUPERSAMPLE,
    });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);

    const ext = args.jpg ? 'jpg' : 'png';
    const files = [];
    for (const [i, el] of (await page.locator('.slide').all()).entries()) {
      const raw = await el.screenshot({ type: 'png' });
      const name = `${items[i].name}.${ext}`;
      const img = sharp(raw).resize(size.w, size.h, { kernel: 'lanczos3' });
      // PNG by default: Instagram re-encodes to JPEG on its side, and going
      // through a JPEG of our own first would stack one generation of loss on
      // top of another.
      await (args.jpg ? img.jpeg({ quality: 96, chromaSubsampling: '4:4:4', mozjpeg: true }) : img.png({ compressionLevel: 9 }))
        .toFile(path.join(outDir, name));
      files.push(name);
    }

    if (cfg.caption) await fs.writeFile(path.join(outDir, 'caption.txt'), `${cfg.caption}\n`);
    await fs.writeFile(path.join(outDir, 'preview.html'), previewHtml(cfg, files, size));

    console.log(`\n  ${slug} — ${files.length} слайд(ов) → ${path.relative(ROOT, outDir)}`);
    for (const [i, s] of cfg.slides.entries()) {
      const b = s._box;
      const where = s.text
        ? `текст ${(b.x * 100).toFixed(0)}%,${(b.y * 100).toFixed(0)}% · ${s._tone === 'dark' ? 'тёмный' : 'белый'}` +
          ` · виньетка ${(s.vignette ?? s._vs).toFixed(2)}` +
          (s.box ? ' · вручную' : ` · авто (детализация ${s._detail.toFixed(3)}, яркость ${s._lum.toFixed(2)})`)
        : 'без текста';
      console.log(`  ${String(i + 1).padStart(2, '0')}  ${where}`);
    }
    console.log(`\n  превью: ${path.relative(ROOT, path.join(outDir, 'preview.html'))}\n`);
  } finally {
    await browser.close();
    server.close();
  }
}

function previewHtml(cfg, files, size) {
  return `<!doctype html><meta charset="utf-8"><title>${esc(cfg.slug ?? 'carousel')}</title>
<style>
 body{margin:0;background:#111;color:#ddd;font:14px/1.6 -apple-system,system-ui,sans-serif;padding:28px}
 .row{display:flex;gap:18px;overflow-x:auto;padding-bottom:18px}
 .row img{height:${Math.round((520 / size.h) * size.w)}px;width:auto;border-radius:8px;flex:none}
 pre{white-space:pre-wrap;max-width:70ch;color:#bbb;background:#1a1a1a;padding:18px;border-radius:8px}
</style>
<div class="row">${files.map((f) => `<img src="${f}">`).join('')}</div>
${cfg.caption ? `<pre>${esc(cfg.caption)}</pre>` : ''}`;
}

main().catch((e) => { console.error(`\n  ошибка: ${e.message}\n`); process.exit(1); });
