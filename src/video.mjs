#!/usr/bin/env node
/**
 * Prepare a video for Instagram.
 *
 *   npm run video -- input/clip.mov --kind reel
 *   npm run video -- input/clip.mov --kind slide      # a slide inside a carousel
 *
 * No copy is ever drawn on a video — that is the house rule, and it is why
 * this file only crops and encodes. The words that came with the clip go in
 * the caption instead.
 *
 * ffmpeg ships with the agent (ffmpeg-static), so nothing needs installing
 * system-wide and the encode is identical on every machine.
 *
 * Flags:
 *   --kind reel|slide   target format          (default: reel)
 *   --out <dir>         output root            (default: out)
 *   --trim <seconds>    cut to length from the start
 *   --focus <pos>       crop anchor: centre | top | bottom
 *   --audio <file>      burn a track in, replacing the clip's own sound
 *
 * On --audio: Instagram's own music library is not reachable from the
 * publishing API — no catalogue tracks, no trending sounds. Burning a file in
 * here is the only way a Reel published through the API can carry music, and
 * it buys none of the discoverability a trending sound does. Use it for your
 * own or licensed audio; anything else gets muted by Instagram's matching.
 */
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const VIDEO_RE = /\.(mp4|mov|m4v|webm)$/i;

/**
 * Instagram's two video shapes.
 *
 * A carousel crops every item to the aspect of its first slide, so a video
 * riding inside a carousel has to match the carousel — 4:5 — or it gets cut.
 * The API also refuses carousel video longer than a minute.
 */
export const KINDS = {
  reel: { w: 1080, h: 1920, maxSeconds: 900 },
  slide: { w: 1080, h: 1350, maxSeconds: 60 },
};

const CROP_Y = { centre: '(ih-oh)/2', center: '(ih-oh)/2', top: '0', bottom: 'ih-oh' };

/** Probe duration, size and frame rate without a separate ffprobe binary. */
export async function inspect(file) {
  // ffmpeg reports stream details on stderr and exits non-zero with no output
  // target, so the error path is the normal path here.
  const out = await run(ffmpegPath, ['-hide_banner', '-i', file]).catch((e) => e);
  const text = `${out.stderr ?? ''}`;
  if (!/Stream .*Video:/.test(text)) {
    throw new Error(`не удалось прочитать видео: ${path.basename(file)} — файл повреждён или это не видео`);
  }
  const d = text.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  const size = text.match(/Video:.*?, (\d+)x(\d+)/);
  const fps = text.match(/(\d+(?:\.\d+)?) fps/);
  return {
    seconds: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : null,
    width: size ? +size[1] : null,
    height: size ? +size[2] : null,
    fps: fps ? +fps[1] : null,
    hasAudio: /Stream .*Audio:/.test(text),
  };
}

/**
 * Crop to the target shape and encode to what Instagram accepts.
 *
 * H.264 high profile in yuv420p with AAC audio and the moov atom moved to the
 * front — without faststart the API has to pull the whole file before it can
 * read the header, and large uploads time out.
 */
export async function prepVideo(src, dest, { kind = 'reel', trim = null, focus = 'centre', audio = null } = {}) {
  const target = KINDS[kind];
  if (!target) throw new Error(`unknown kind "${kind}" — use ${Object.keys(KINDS).join(', ')}`);

  const info = await inspect(src);
  const y = CROP_Y[focus] ?? CROP_Y.centre;
  const limit = trim ?? (info.seconds > target.maxSeconds ? target.maxSeconds : null);
  const sound = audio ? 'burned' : info.hasAudio ? 'original' : 'none';

  const args = [
    '-y', '-i', src,
    ...(audio ? ['-i', audio] : []),
    ...(limit ? ['-t', String(limit)] : []),
    '-vf', [
      `scale=${target.w}:${target.h}:force_original_aspect_ratio=increase`,
      `crop=${target.w}:${target.h}:(iw-ow)/2:${y}`,
    ].join(','),
    // With a track supplied, take video from the clip and sound from the track,
    // and stop at whichever runs out first.
    ...(audio ? ['-map', '0:v:0', '-map', '1:a:0', '-shortest'] : []),
    '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2',
    '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', '30', '-g', '60',
    ...(sound === 'none' ? ['-an'] : ['-c:a', 'aac', '-b:a', '128k', '-ar', '48000', '-ac', '2']),
    '-movflags', '+faststart',
    dest,
  ];
  await run(ffmpegPath, args, { maxBuffer: 1 << 26 });

  // A poster frame, so the clip can be reviewed alongside the rendered slides.
  const poster = dest.replace(/\.mp4$/, '.jpg');
  await run(ffmpegPath, ['-y', '-i', dest, '-frames:v', '1', '-q:v', '3', poster]);

  return { ...info, trimmedTo: limit, sound, out: dest, poster };
}

/* ------------------------------------------------------------------ main -- */

function parseArgs(argv) {
  const args = { src: null, kind: 'reel', out: 'out', trim: null, focus: 'centre', audio: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--kind') args.kind = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--trim') args.trim = Number(argv[++i]);
    else if (a === '--focus') args.focus = argv[++i];
    else if (a === '--audio') args.audio = argv[++i];
    else if (!a.startsWith('--')) args.src = a;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.src) {
    console.error('usage: npm run video -- <файл> [--kind reel|slide] [--out dir] [--trim сек] [--focus centre|top|bottom] [--audio файл]');
    process.exit(1);
  }

  const src = path.resolve(ROOT, args.src);
  const base = path.basename(src).replace(/\.[^.]+$/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const outDir = path.resolve(ROOT, args.out);
  await fs.mkdir(outDir, { recursive: true });

  // No per-clip subfolder: a video is a slide like any other, and it belongs
  // next to the numbered photos in the same post's out/ directory, not
  // tucked away where it won't get noticed. The source name is folded into
  // the filename instead, since that's what would otherwise have named the
  // subfolder — still collision-safe with nothing extra to look inside.
  const dest = path.join(outDir, `${base}-${args.kind}.mp4`);
  const r = await prepVideo(src, dest, args);

  const target = KINDS[args.kind];
  console.log(`\n  ${path.basename(src)} → ${path.relative(ROOT, dest)}`);
  console.log(`  исходник: ${r.width}×${r.height}, ${r.seconds?.toFixed(1)} с, ${r.fps ?? '?'} fps${r.hasAudio ? ', со звуком' : ', без звука'}`);
  const sound = { burned: 'вшитый трек', original: 'родной звук клипа', none: 'без звука' }[r.sound];
  console.log(`  результат: ${target.w}×${target.h}${r.trimmedTo ? `, обрезано до ${r.trimmedTo} с` : ''}, ${sound}`);
  if (r.sound === 'burned') {
    console.log('  ! Вшитый трек не даёт привязки к звуку в Instagram и не попадает в ленту по нему.');
    console.log('    Трендовый звук ставится только вручную из приложения.');
  }
  if (r.trimmedTo && !args.trim) {
    console.log(`  ! ${args.kind === 'slide' ? 'В карусели видео не длиннее 60 с' : 'Слишком длинно'} — лишнее отрезано с конца.`);
  }
  console.log(`  кадр для превью: ${path.relative(ROOT, r.poster)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(`\n  ошибка: ${e.message}\n`); process.exit(1); });
}
