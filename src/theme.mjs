/**
 * Slide CSS for the carousel renderer.
 *
 * The look comes from the reference carousels: the photo carries the slide
 * full bleed, a gradient vignette gives the type something to sit on, and the
 * copy is small and set in a neutral grotesque, placed where the frame has
 * room for it rather than in a fixed corner.
 *
 * Inter is the grotesque. The reference uses the iOS system face; Inter is the
 * closest neo-grotesque to it, and it is vendored in `fonts/`, so the slides
 * render identically on any machine and nothing is fetched at render time.
 */

/**
 * Instagram canvases, at the widest edge Instagram keeps.
 *
 * Uploads are downsampled to 1440px wide, so 1440 is the most detail that can
 * reach a viewer — the usual 1080 throws away a third of it for nothing. 4:5
 * is the default: it takes the most height in the feed.
 */
export const SIZES = {
  '4:5': { w: 1440, h: 1800 },
  '1:1': { w: 1440, h: 1440 },
  '9:16': { w: 1440, h: 2560 },
};

export const DEFAULT_SIZE = '4:5';

/**
 * Render at twice the output and scale down.
 *
 * Type and the vignette get supersampled, which is where clean edges come
 * from, and the photo is prepared at this resolution too so the browser never
 * has to enlarge it.
 */
export const SUPERSAMPLE = 2;

/** Copy sizes, as a share of canvas width — measured off the reference slides. */
export const TEXT_SIZES = { s: 0.021, m: 0.0245, l: 0.029 };

/**
 * Leading. Tight enough that a few lines read as a single block rather than a
 * list — shared with the renderer, which counts lines to know how much room the
 * copy needs before it goes looking for somewhere to put it.
 */
export const LINE_HEIGHT = 1.18;

export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The markup a spec's text fields understand:
 *
 *   *слово*   italic
 *   //        hard line break
 *
 * Everything else is plain text and is escaped. Deliberately thin: the
 * reference style is one weight of one face, and every extra bit of styling
 * moves the slides away from it.
 */
export function rich(s) {
  return esc(s)
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\s*\/\/\s*/g, '<br>');
}

export function baseCss({ w, h }) {
  return `
*{box-sizing:border-box;margin:0;padding:0}
:root{
  --ink:#2C2C2C;
  --font-grotesk:'Inter','Helvetica Neue',Helvetica,Arial,sans-serif;
}
html,body{background:#111;-webkit-font-smoothing:antialiased}
body{display:flex;flex-direction:column;align-items:center;gap:40px;padding:40px}

.slide{position:relative;width:${w}px;height:${h}px;overflow:hidden;background:#0d0d0d}

/* the photo carries the slide */
.bg{position:absolute;inset:0;z-index:1}
.bg img{width:100%;height:100%;object-fit:cover;display:block}

/*
 * Two-part vignette. The first layer is a soft pool under the copy, placed at
 * the text box so it darkens only what the text needs; the second is a gentle
 * edge falloff that frames the photo. Both stay low-contrast on purpose —
 * a visible grey panel would read as a sticker, not as light.
 */
.vig{
  position:absolute;inset:0;z-index:2;pointer-events:none;
  /* Edge falloff, on every frame whether or not it carries copy — it is part
     of the house look, not a device for holding type. */
  background:
    radial-gradient(128% 96% at 50% 42%,
      rgba(8,10,14,0) 52%,
      rgba(8,10,14,.16) 82%,
      rgba(8,10,14,.30) 100%);
}
/* The pool under the copy sits on top of the falloff, sized to what the ground
   needs (--vs) and present only where there is copy (--vp).
   It is meant to be all but invisible — you should not be able to point at
   where it starts. The type's own shadow does the rest of the work. */
.vig.pool{
  background:
    radial-gradient(105% 62% at var(--vx) var(--vy),
      rgba(8,10,14,calc(.16*var(--vs)*var(--vp))) 0%,
      rgba(8,10,14,calc(.10*var(--vs)*var(--vp))) 34%,
      rgba(8,10,14,calc(.03*var(--vs)*var(--vp))) 60%,
      rgba(8,10,14,0) 78%),
    radial-gradient(128% 96% at 50% 42%,
      rgba(8,10,14,0) 52%,
      rgba(8,10,14,.16) 82%,
      rgba(8,10,14,.30) 100%);
}
/* Light ground takes the same shape in reverse, so dark type keeps its footing. */
.vig.pool.inverted{
  background:
    radial-gradient(105% 62% at var(--vx) var(--vy),
      rgba(255,255,255,calc(.22*var(--vs)*var(--vp))) 0%,
      rgba(255,255,255,calc(.13*var(--vs)*var(--vp))) 36%,
      rgba(255,255,255,0) 76%),
    radial-gradient(128% 96% at 50% 42%,
      rgba(8,10,14,0) 55%,
      rgba(8,10,14,.22) 100%);
}

/* the copy */
.copy{
  position:absolute;z-index:3;
  left:calc(var(--bx) * ${w}px);
  top:calc(var(--by) * ${h}px);
  width:calc(var(--bw) * ${w}px);
  font-family:var(--font-grotesk);
  font-weight:400;
  font-size:calc(var(--fs) * ${w}px);
  line-height:${LINE_HEIGHT};
  letter-spacing:-.002em;
  color:#fff;
  text-wrap:pretty;
  text-shadow:0 1px 2px rgba(10,12,16,.30), 0 2px 22px rgba(10,12,16,.38);
}
.copy.dark{color:var(--ink);text-shadow:0 1px 2px rgba(255,255,255,.35), 0 2px 22px rgba(255,255,255,.45)}
.copy em{font-style:italic}
.copy .l2{display:block;margin-top:.85em;opacity:.92}

/* optional handle, bottom-left, same restraint as the copy */
.handle{
  position:absolute;z-index:3;left:calc(var(--pad) * ${w}px);bottom:calc(var(--pad) * ${w}px);
  font-family:var(--font-grotesk);font-weight:400;font-size:calc(.021 * ${w}px);
  letter-spacing:.06em;color:rgba(255,255,255,.72);
  text-shadow:0 1px 14px rgba(10,12,16,.45);
}
.handle.dark{color:rgba(44,44,44,.62);text-shadow:0 1px 14px rgba(255,255,255,.5)}

/* debug overlay: the chosen box and the 1:1 grid crop, drawn only with --guides */
.guides{position:absolute;inset:0;z-index:9;pointer-events:none;display:none}
.guides.on{display:block}
.guides .box{
  position:absolute;
  left:calc(var(--bx) * ${w}px);top:calc(var(--by) * ${h}px);
  width:calc(var(--bw) * ${w}px);height:calc(var(--bh) * ${h}px);
  outline:2px dashed rgba(0,200,255,.85);
}
.guides .sq{position:absolute;left:0;right:0;top:calc((${h}px - ${w}px)/2);height:${w}px;outline:2px dashed rgba(255,0,90,.5)}
`;
}
