import { OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';
import timeline from '../props/timeline.json';
import narration from '../props/narration.json';
import type { CaptionStyle } from './presets';

type WordTiming = { text: string; start: number; end: number };

type NarrationClip = {
  startSeconds: number;
  durationSeconds: number;
  words?: WordTiming[] | null;
};

// Declarative caption styling the demo script may set (merged over the
// preset defaults): where the caption sits, the active-word accent color,
// whether the pill background renders, and a font-size multiplier.
type CaptionStyleOverride = {
  position?: 'top' | 'bottom';
  accent?: string;
  pill?: boolean;
  sizeScale?: number;
};

export const FPS = timeline.fps;
export const DEMO_SECONDS = timeline.durationSeconds;

type Vec = { x: number; y: number };

const smooth = (t: number) => t * t * (3 - 2 * t);
const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

function lerpNum(keys: { t: number; v: number }[], t: number): number {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t)
      return a.v + (b.v - a.v) * smooth((t - a.t) / Math.max(b.t - a.t, 1e-6));
  }
  return keys[keys.length - 1].v;
}
function lerpVec(keys: { t: number; v: Vec }[], t: number): Vec {
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (t >= a.t && t <= b.t) {
      const p = smooth((t - a.t) / Math.max(b.t - a.t, 1e-6));
      return { x: a.v.x + (b.v.x - a.v.x) * p, y: a.v.y + (b.v.y - a.v.y) * p };
    }
  }
  return keys[keys.length - 1].v;
}

const Cursor: React.FC<{ invScale: number }> = ({ invScale }) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      transform: `scale(${invScale})`,
      transformOrigin: '0 0',
      filter: 'drop-shadow(0 3px 6px rgba(0,0,0,0.45))',
    }}
  >
    <svg width={34} height={34} viewBox="0 0 24 24" fill="none">
      <path
        d="M4 2 L4 20 L9 15 L12.5 22.5 L15.5 21 L12 13.5 L19 13.5 Z"
        fill="#fff"
        stroke="#1a1a1a"
        strokeWidth={1.4}
        strokeLinejoin="round"
      />
    </svg>
  </div>
);

// The polished demo "window": recorded video on a rounded panel, with the
// zoom/cursor/ripple/caption effects driven by the captured timeline. Laid
// out for whatever canvas size the preset asks for.
export const DemoStage: React.FC<{
  canvasW: number;
  canvasH: number;
  pad: number;
  caption: CaptionStyle;
  centerPull: number;
  baseScale: number;
}> = ({ canvasW, canvasH, pad, caption, centerPull, baseScale }) => {
  const frame = useCurrentFrame();
  const t = frame / FPS;

  const capStyle = ((timeline as { captionStyle?: CaptionStyleOverride })
    .captionStyle ?? {}) as CaptionStyleOverride;
  const capAtTop = capStyle.position === 'top';
  const capFontSize = caption.fontSize * (capStyle.sizeScale ?? 1);

  // Captions live in a reserved band on the backdrop (below the window by
  // default) so they never overlay the recorded content — the window is
  // inset anyway, so the space is already paid for. The band fits two
  // caption lines plus the pill padding and the caption's edge offset.
  const hasCaptions = timeline.captions.length > 0;
  const captionBand = hasCaptions
    ? Math.round(caption.bottom + capFontSize * 2 * 1.25 + 28 + 24)
    : 0;

  // The stage is the canvas minus the caption band; the window lays out and
  // zooms strictly within it.
  const stageTop = capAtTop ? captionBand : 0;
  const stageH = canvasH - captionBand;

  const SHOT_W = timeline.video.width;
  const SHOT_H = timeline.video.height;
  const usableH = captionBand > 0 ? stageH - pad : canvasH - 2 * pad;
  const BASE_W = Math.round(
    Math.min(canvasW - 2 * pad, (usableH * SHOT_W) / SHOT_H),
  );
  const BASE_H = Math.round((BASE_W * SHOT_H) / SHOT_W);
  const WIN_X = (canvasW - BASE_W) / 2;
  const WIN_Y = stageTop + (stageH - BASE_H) / 2;

  const sRaw = baseScale + (lerpNum(timeline.scaleKeys, t) - 1);
  // Coverage floor: the caption band shrinks the window, so a scripted zoom
  // (e.g. the default 1.5x) can crop the window vertically without covering
  // the canvas width — backdrop gutters on both sides. Whenever the scale
  // passes the vertical-cropping threshold, smoothly floor the effective
  // scale at full-width coverage: the view is always either a floating
  // uncropped window or a full-bleed zoom, never a cropped hybrid.
  const sCrop = stageH / BASE_H; // where vertical cropping begins
  // Overshoot coverage by a hair: at exactly canvasW / BASE_W, floating-point
  // rounding can leave BASE_W * S one ulp short of canvasW, which skips the
  // edge clamp below and lets the raw center-pull expose a side gutter.
  const sCover = canvasW / BASE_W + 0.002; // horizontal coverage, plus slack
  const floorP = clamp((sRaw - sCrop) / 0.15, 0, 1);
  const S = sRaw + Math.max(0, sCover - sRaw) * floorP;
  const focal = lerpVec(timeline.focalKeys, t);
  const cursor = lerpVec(timeline.cursorKeys, t);

  const focal0x = WIN_X + focal.x * BASE_W;
  const focal0y = WIN_Y + focal.y * BASE_H;
  const k = clamp((S - 1) / 1.1, 0, 1) * centerPull;
  const desiredTx = (canvasW / 2 - focal0x) * k;
  const desiredTy = (stageTop + stageH / 2 - focal0y) * k;
  // Edge-clamp: while zoomed, the scaled window must keep covering the whole
  // stage so no backdrop shows through — and must stay OUT of the caption
  // band. With transform-origin at the focal point, the scaled window spans
  //   left  = WIN_X + Tx - focal.x * BASE_W * (S - 1)
  //   top   = WIN_Y + Ty - focal.y * BASE_H * (S - 1)
  // so covering [0, canvasW] x [stageTop, stageTop + stageH] bounds T:
  const txMax = focal.x * BASE_W * (S - 1) - WIN_X;
  const txMin = canvasW - WIN_X + focal.x * BASE_W * (S - 1) - BASE_W * S;
  const tyMax = stageTop - WIN_Y + focal.y * BASE_H * (S - 1);
  const tyMin =
    stageTop + stageH - WIN_Y + focal.y * BASE_H * (S - 1) - BASE_H * S;
  // Only clamp an axis when the scaled window exceeds the stage on it; a
  // smaller-than-stage window (vertical band preset) stays centered instead
  // of being shoved into a corner.
  const Tx =
    BASE_W * S >= canvasW - 0.5
      ? clamp(desiredTx, Math.min(txMin, txMax), Math.max(txMin, txMax))
      : desiredTx;
  const Ty =
    BASE_H * S >= stageH - 0.5
      ? clamp(desiredTy, Math.min(tyMin, tyMax), Math.max(tyMin, tyMax))
      : desiredTy;
  const invScale = 1 / S;

  return (
    <>
      {/* The window's drop shadow lives OUTSIDE the stage clip (an outer
          box-shadow paints only beyond the border-box, so this transparent
          proxy adds nothing else): clipped inside the stage it shears into a
          hard line at the stage edge, visible on a light backdrop. */}
      <div
        style={{
          position: 'absolute',
          left: WIN_X,
          top: WIN_Y,
          width: BASE_W,
          height: BASE_H,
          transform: `translate(${Tx}px, ${Ty}px) scale(${S})`,
          transformOrigin: `${focal.x * 100}% ${focal.y * 100}%`,
          borderRadius: 16,
          boxShadow: '0 40px 90px rgba(0,0,0,0.4)',
        }}
      />
      {/* Stage clip: while zoomed, the scaled window necessarily extends
          past the stage rect; clipping here keeps the caption band clean. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          top: stageTop,
          width: canvasW,
          height: stageH,
          overflow: 'hidden',
        }}
      >
      <div
        style={{
          position: 'absolute',
          left: WIN_X,
          top: WIN_Y - stageTop,
          width: BASE_W,
          height: BASE_H,
          transform: `translate(${Tx}px, ${Ty}px) scale(${S})`,
          transformOrigin: `${focal.x * 100}% ${focal.y * 100}%`,
        }}
      >
        <div
          style={{
            width: BASE_W,
            height: BASE_H,
            borderRadius: 16,
            overflow: 'hidden',
            border: '1px solid rgba(255,255,255,0.09)',
          }}
        >
          <OffthreadVideo
            src={staticFile(timeline.video.path)}
            startFrom={Math.round(
              ((timeline.video as { startFromSeconds?: number })
                .startFromSeconds ?? 0) * FPS,
            )}
            playbackRate={
              (timeline.video as { playbackRate?: number }).playbackRate ?? 1
            }
            style={{ width: BASE_W, height: BASE_H, display: 'block' }}
          />
        </div>

        {timeline.clicks.map((c, i) => {
          const dt = t - c.t;
          if (dt < 0 || dt > 0.6) return null;
          const p = dt / 0.6;
          const size = 12 + smooth(p) * 90;
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: c.at.x * BASE_W,
                top: c.at.y * BASE_H,
                width: size * invScale,
                height: size * invScale,
                marginLeft: (-size / 2) * invScale,
                marginTop: (-size / 2) * invScale,
                borderRadius: '50%',
                border: `${3 * invScale}px solid rgba(201,242,77,0.9)`,
                opacity: 1 - p,
              }}
            />
          );
        })}

        <div
          style={{
            position: 'absolute',
            left: cursor.x * BASE_W,
            top: cursor.y * BASE_H,
          }}
        >
          <Cursor invScale={invScale} />
        </div>
      </div>
      </div>

      {timeline.captions.map((cap, i) => {
        const fadeIn = clamp((t - cap.start) / 0.25, 0, 1);
        const fadeOut = clamp((cap.end - t) / 0.25, 0, 1);
        const opacity = Math.min(fadeIn, fadeOut);
        if (opacity <= 0) return null;

        const atTop = capAtTop;
        const accent = capStyle.accent ?? '#fff';
        const pill = capStyle.pill !== false;
        const fontSize = capFontSize;

        // Spoken-word highlight: captions and narration clips are 1:1 in
        // order, and word times are relative to the clip's start. Without
        // word timings (captions-only mode) the caption renders plain.
        const clip = (narration.clips as NarrationClip[])[i];
        const words = clip?.words ?? null;
        const tInClip = clip ? t - clip.startSeconds : 0;

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              ...(atTop ? { top: caption.bottom } : { bottom: caption.bottom }),
              display: 'flex',
              justifyContent: 'center',
              opacity,
              transform: `translateY(${(1 - fadeIn) * (atTop ? -12 : 12)}px)`,
            }}
          >
            <div
              style={{
                fontFamily:
                  'SF Pro Display, -apple-system, Segoe UI, Roboto, sans-serif',
                fontSize,
                fontWeight: 600,
                color: '#fff',
                maxWidth: `${caption.maxWidthPct}%`,
                textAlign: 'center',
                lineHeight: 1.25,
                ...(pill
                  ? {
                      background: 'rgba(15,17,24,0.72)',
                      border: '1px solid rgba(255,255,255,0.08)',
                      padding: '14px 26px',
                      borderRadius: 14,
                      backdropFilter: 'blur(6px)',
                    }
                  : {
                      textShadow:
                        '0 2px 10px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9)',
                    }),
              }}
            >
              {words
                ? words.map((word, wi) => {
                    const spoken = tInClip >= word.start;
                    const active = spoken && tInClip < word.end + 0.08;
                    return (
                      <span
                        key={wi}
                        style={{
                          color: active
                            ? accent
                            : spoken
                              ? 'rgba(255,255,255,0.92)'
                              : 'rgba(255,255,255,0.45)',
                          textShadow: active
                            ? `0 0 14px ${accent}`
                            : undefined,
                        }}
                      >
                        {word.text}
                        {wi < words.length - 1 ? ' ' : ''}
                      </span>
                    );
                  })
                : cap.text}
            </div>
          </div>
        );
      })}
    </>
  );
};
