/**
 * Choose where the copy goes on a photo.
 *
 * Not "top third, on the left" — that was one photograph's answer, not a rule.
 * The job is to find the spot that actually looks right on this frame: empty
 * enough that nothing is covered, even enough that the type stays legible, and
 * placed so the slide reads as composed rather than as text dropped on a photo.
 *
 * Five things are measured for every candidate box, and the frame decides which
 * one wins:
 *
 *   detail      how much is going on under the box — a face and hands score
 *               high, sky and a plain wall score near zero
 *   evenness    how uniform the ground is; busy-but-flat gradients still read
 *   contrast    how far the ground sits from the type's own colour
 *   balance     whether the box sits away from the subject's visual mass, so
 *               the two sides of the frame hold each other up
 *   thirds      how close the box lands to a rule-of-thirds line
 *
 * No model and no network: Sobel energy plus integral images, a few
 * milliseconds per photo.
 */
import sharp from 'sharp';

/** Working resolution for the analysis. Detail survives; the cost does not. */
const SAMPLE_W = 200;

async function maps(file) {
  const img = sharp(file).greyscale().resize({ width: SAMPLE_W });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  // Sobel magnitude — high on edges, near zero on flat sky.
  const detail = new Float32Array(w * h);
  const at = (x, y) => data[y * w + x];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1) +
        at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1);
      const gy =
        -at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1) +
        at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1);
      detail[y * w + x] = Math.min(1, Math.hypot(gx, gy) / 500);
    }
  }

  // Where the subject sits, as the centre of mass of all that detail. Text
  // placed away from it is what makes a slide feel balanced rather than piled.
  let mass = 0, mx = 0, my = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = detail[y * w + x];
      mass += d; mx += d * (x / w); my += d * (y / h);
    }
  }
  const subject = mass > 0 ? { x: mx / mass, y: my / mass } : { x: 0.5, y: 0.5 };

  const lum = new Float32Array(w * h);
  const lum2 = new Float32Array(w * h);
  for (let i = 0; i < data.length; i++) {
    const v = data[i] / 255;
    lum[i] = v; lum2[i] = v * v;
  }

  return {
    w, h, subject,
    detailSum: integral(detail, w, h),
    lumSum: integral(lum, w, h),
    lum2Sum: integral(lum2, w, h),
  };
}

/** Summed-area table, padded by one row/column so box sums need no bounds checks. */
function integral(src, w, h) {
  const S = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      S[(y + 1) * (w + 1) + (x + 1)] = S[y * (w + 1) + (x + 1)] + row;
    }
  }
  return S;
}

function boxMean(S, w, x0, y0, x1, y1) {
  const W = w + 1;
  const area = Math.max(1, (x1 - x0) * (y1 - y0));
  return (S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0]) / area;
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/** Distance to the nearest rule-of-thirds line, on one axis. */
function toThird(v) {
  return Math.min(Math.abs(v - 1 / 3), Math.abs(v - 2 / 3));
}

/**
 * Score one candidate box for one type colour.
 * Lower is better. Every term is roughly 0..1 before weighting.
 */
function score(m, box, tone) {
  const { w, h } = m;
  const px = (v, span) => Math.max(0, Math.min(span, Math.round(v * span)));
  const x0 = px(box.x, w), x1 = px(box.x + box.w, w);
  const y0 = px(box.y, h), y1 = px(box.y + box.h, h);

  // Sample a little wider than the type itself: copy needs quiet around it,
  // not just under it, or it ends up tucked against the subject's outline.
  const pad = Math.round(0.022 * w);
  const detail = boxMean(m.detailSum, w,
    Math.max(0, x0 - pad), Math.max(0, y0 - pad),
    Math.min(w, x1 + pad), Math.min(h, y1 + pad));

  const lum = boxMean(m.lumSum, w, x0, y0, x1, y1);
  const variance = Math.max(0, boxMean(m.lum2Sum, w, x0, y0, x1, y1) - lum * lum);
  const evenness = clamp01(Math.sqrt(variance) / 0.22);

  // How far the ground sits from the type's colour. The vignette can buy some
  // of this back, so it is a preference rather than a hard cut.
  const inkLum = tone === 'dark' ? 0.17 : 1;
  const contrast = clamp01(1 - Math.abs(lum - inkLum) / 0.55);

  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  // Sit away from the subject's mass, but not so far that the box falls off
  // into a corner — the penalty fades out once there is real separation.
  const dist = Math.hypot(cx - m.subject.x, cy - m.subject.y);
  const balance = clamp01(1 - dist / 0.48);

  const thirds = clamp01((toThird(cx) + toThird(cy)) / 0.34);

  // Hugging the safe edge looks like a mistake even when the pixels are empty.
  const edge = clamp01(1 - Math.min(box.x, box.y, 1 - box.x - box.w, 1 - box.y - box.h) / 0.075);

  return {
    total: detail * 3.6 + evenness * 0.9 + contrast * 1.5 + balance * 0.8 + thirds * 0.35 + edge * 0.6,
    detail, lum, evenness, contrast, balance,
  };
}

/**
 * Pick the best text box for a photo, trying both type colours and keeping
 * whichever the frame supports better.
 *
 * `box` is normalised {x, y, w, h} in 0..1 of the rendered canvas — analysis
 * runs on the already-cropped frame, so the box the analyser picks is the box
 * the viewer sees.
 */
export async function findTextBox(file, opts = {}) {
  const { boxW = 0.46, boxH = 0.16, margin = 0.075, step = 0.02, tone = 'auto' } = opts;

  const m = await maps(file);
  const tones = tone === 'auto' ? ['light', 'dark'] : [tone];

  const all = [];
  for (let y = margin; y + boxH <= 1 - margin; y += step) {
    for (let x = margin; x + boxW <= 1 - margin; x += step) {
      const box = { x, y, w: boxW, h: boxH };
      for (const t of tones) all.push({ ...box, ...score(m, box, t), tone: t });
    }
  }
  all.sort((a, b) => a.total - b.total);

  // Geometry cannot tell flat sky from a flat shirt — both read as empty, and
  // the second one covers the subject. So the analyser offers the strongest
  // few placements that are actually far apart, and the agent looks at the
  // rendered slide to make the call that needs eyes.
  const options = [];
  for (const c of all) {
    const far = options.every((o) => Math.hypot(o.x - c.x, o.y - c.y) > 0.18);
    if (far) options.push(c);
    if (options.length === 4) break;
  }

  return { ...options[0], options, subject: m.subject };
}

/**
 * Measure one box that was chosen by hand.
 *
 * A pinned box still needs its ground read — which type colour it can carry and
 * how much vignette it wants. Taking those from the automatic pick instead
 * would describe a spot the copy is not sitting on.
 */
export async function measureBox(file, box, tone = 'auto') {
  const m = await maps(file);
  const full = { x: box.x, y: box.y, w: box.w ?? 0.46, h: box.h ?? 0.16 };
  if (tone !== 'auto') return { ...full, ...score(m, full, tone), tone };

  const light = score(m, full, 'light');
  const dark = score(m, full, 'dark');
  return light.contrast <= dark.contrast
    ? { ...full, ...light, tone: 'light' }
    : { ...full, ...dark, tone: 'dark' };
}

/** Round a box for readable JSON without losing placement accuracy. */
export function roundBox(b) {
  const r = (v) => Math.round(v * 1000) / 1000;
  return { x: r(b.x), y: r(b.y), w: r(b.w), h: r(b.h) };
}
