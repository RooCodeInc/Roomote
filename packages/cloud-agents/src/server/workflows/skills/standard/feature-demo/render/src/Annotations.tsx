// Annotation layer: capture-anchored attention cues drawn over the
// recording. Rendered INSIDE the window transform container (like the
// cursor and click ripple) so anchors stay glued to page coordinates, with
// chrome counter-scaled by 1/S so stroke widths and chip text keep constant
// on-screen size under a preset baseScale.
//
// The default style is `spotlight`: dim the rest of the window and leave
// the target bright. Attention comes from contrast, not from chrome drawn
// onto the page — boxes and labels over a dense real page read as stickers,
// which is why the outline styles are opt-in.
//
// Anchors are resolved at beat-settle time and are only valid for that
// scroll position, so each annotation lives strictly inside its beat's
// caption window — capture scopes the timing, the renderer only fades.

type Box = { x: number; y: number; w: number; h: number };

export type Annotation = {
  start: number;
  end: number;
  box: Box;
  text?: string;
  style?: 'spotlight' | 'box' | 'callout';
};

const clamp = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, v));

export const Annotations: React.FC<{
  annotations: Annotation[];
  t: number;
  baseW: number;
  baseH: number;
  invScale: number;
  accent: string;
}> = ({ annotations, t, baseW, baseH, invScale, accent }) => {
  return (
    // Clip to the window rect (same radius as the video panel) so the
    // spotlight dim covers exactly the recording, never the backdrop.
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: baseW,
        height: baseH,
        borderRadius: 16,
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {annotations.map((a, i) => {
        const fadeIn = clamp((t - a.start) / 0.35, 0, 1);
        const fadeOut = clamp((a.end - t) / 0.35, 0, 1);
        const opacity = Math.min(fadeIn, fadeOut);
        if (opacity <= 0) return null;

        // Breathing room around the measured content rect.
        const padX = 14;
        const padY = 10;
        const left = a.box.x * baseW - padX;
        const top = a.box.y * baseH - padY;
        const width = a.box.w * baseW + 2 * padX;
        const height = a.box.h * baseH + 2 * padY;

        const spotlight = a.style !== 'box' && a.style !== 'callout';
        const showChip = a.text && a.style !== 'box';
        // Chip sits on the dimmed area above the cutout, left-aligned with
        // it (or below when the target is near the top edge). Its rendered
        // width is estimated from the label (nowrap, so width tracks text)
        // to keep the right edge inside the window.
        const chipAbove = top > 72 * invScale;
        const chipW = ((a.text?.length ?? 0) * 17 * 0.56 + 28) * invScale;
        const chipLeft = clamp(left, 12, Math.max(12, baseW - 12 - chipW));

        return (
          <div key={i} style={{ opacity }}>
            {spotlight ? (
              // The cutout: a transparent rounded rect whose enormous
              // box-shadow dims everything else in the (clipped) window.
              <div
                style={{
                  position: 'absolute',
                  left,
                  top,
                  width,
                  height,
                  borderRadius: 12,
                  boxShadow: `0 0 0 ${Math.max(baseW, baseH) * 2}px rgba(9, 11, 16, 0.38)`,
                }}
              />
            ) : (
              <div
                style={{
                  position: 'absolute',
                  left,
                  top,
                  width,
                  height,
                  border: `${2.5 * invScale}px solid ${accent}`,
                  borderRadius: 12,
                  boxShadow: `0 0 ${18 * invScale}px rgba(0,0,0,0.12)`,
                }}
              />
            )}
            {showChip ? (
              <div
                style={{
                  position: 'absolute',
                  left: chipLeft,
                  top: chipAbove ? top : top + height,
                  transform: `translateY(${chipAbove ? '-100%' : '0%'}) translateY(${
                    (chipAbove ? -12 : 12) * invScale
                  }px) scale(${invScale})`,
                  transformOrigin: chipAbove ? '0% 100%' : '0% 0%',
                }}
              >
                <div
                  style={{
                    fontFamily:
                      'SF Pro Display, -apple-system, Segoe UI, Roboto, sans-serif',
                    fontSize: 17,
                    fontWeight: 600,
                    lineHeight: 1.2,
                    whiteSpace: 'nowrap',
                    color: '#fff',
                    background: 'rgba(15,17,24,0.92)',
                    borderLeft: `3px solid ${accent}`,
                    padding: '8px 14px',
                    borderRadius: 8,
                    boxShadow: '0 6px 18px rgba(0,0,0,0.3)',
                  }}
                >
                  {a.text}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
