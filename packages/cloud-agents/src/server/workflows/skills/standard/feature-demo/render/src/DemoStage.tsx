import { OffthreadVideo, staticFile, useCurrentFrame } from 'remotion';
import timeline from '../props/timeline.json';
import type { CaptionStyle } from './presets';

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

  const SHOT_W = timeline.video.width;
  const SHOT_H = timeline.video.height;
  const BASE_W = Math.round(
    Math.min(canvasW - 2 * pad, ((canvasH - 2 * pad) * SHOT_W) / SHOT_H),
  );
  const BASE_H = Math.round((BASE_W * SHOT_H) / SHOT_W);
  const WIN_X = (canvasW - BASE_W) / 2;
  const WIN_Y = (canvasH - BASE_H) / 2;

  const S = baseScale + (lerpNum(timeline.scaleKeys, t) - 1);
  const focal = lerpVec(timeline.focalKeys, t);
  const cursor = lerpVec(timeline.cursorKeys, t);

  const focal0x = WIN_X + focal.x * BASE_W;
  const focal0y = WIN_Y + focal.y * BASE_H;
  const k = clamp((S - 1) / 1.1, 0, 1) * centerPull;
  const desiredTx = (canvasW / 2 - focal0x) * k;
  const desiredTy = (canvasH / 2 - focal0y) * k;
  // The edge-clamp keeps the backdrop from showing behind the window — but
  // only makes sense when the scaled window is larger than the canvas on that
  // axis (16:9 presets). For a vertical band the window is smaller than the
  // canvas, so there is nothing to clamp: keep it centered instead of letting
  // the clamp shove it into a corner.
  const txMax = WIN_X + focal.x * BASE_W * (S - 1);
  const txMin = canvasW - WIN_X - focal.x * BASE_W - BASE_W * (1 - focal.x) * S;
  const tyMax = WIN_Y + focal.y * BASE_H * (S - 1);
  const tyMin = canvasH - WIN_Y - focal.y * BASE_H - BASE_H * (1 - focal.y) * S;
  const Tx =
    BASE_W * S >= canvasW
      ? clamp(desiredTx, Math.min(txMin, txMax), Math.max(txMin, txMax))
      : desiredTx;
  const Ty =
    BASE_H * S >= canvasH
      ? clamp(desiredTy, Math.min(tyMin, tyMax), Math.max(tyMin, tyMax))
      : desiredTy;
  const invScale = 1 / S;

  return (
    <>
      <div
        style={{
          position: 'absolute',
          left: WIN_X,
          top: WIN_Y,
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
            boxShadow: '0 40px 90px rgba(0,0,0,0.55)',
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

      {timeline.captions.map((cap, i) => {
        const fadeIn = clamp((t - cap.start) / 0.25, 0, 1);
        const fadeOut = clamp((cap.end - t) / 0.25, 0, 1);
        const opacity = Math.min(fadeIn, fadeOut);
        if (opacity <= 0) return null;
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: caption.bottom,
              display: 'flex',
              justifyContent: 'center',
              opacity,
              transform: `translateY(${(1 - fadeIn) * 12}px)`,
            }}
          >
            <div
              style={{
                fontFamily:
                  'SF Pro Display, -apple-system, Segoe UI, Roboto, sans-serif',
                fontSize: caption.fontSize,
                fontWeight: 600,
                color: '#fff',
                maxWidth: `${caption.maxWidthPct}%`,
                textAlign: 'center',
                lineHeight: 1.25,
                background: 'rgba(15,17,24,0.72)',
                border: '1px solid rgba(255,255,255,0.08)',
                padding: '14px 26px',
                borderRadius: 14,
                backdropFilter: 'blur(6px)',
              }}
            >
              {cap.text}
            </div>
          </div>
        );
      })}
    </>
  );
};
