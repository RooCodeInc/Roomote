// Annotation layer: capture-anchored highlight boxes and callout chips drawn
// over the recording. Rendered INSIDE the window transform container (like
// the cursor and click ripple) so boxes stay glued to page coordinates, with
// chrome counter-scaled by 1/S so stroke widths and chip text keep constant
// on-screen size under a preset baseScale.
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
  style?: 'box' | 'callout';
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
    <>
      {annotations.map((a, i) => {
        const fadeIn = clamp((t - a.start) / 0.25, 0, 1);
        const fadeOut = clamp((a.end - t) / 0.25, 0, 1);
        const opacity = Math.min(fadeIn, fadeOut);
        if (opacity <= 0) return null;

        const left = a.box.x * baseW;
        const top = a.box.y * baseH;
        const width = a.box.w * baseW;
        const height = a.box.h * baseH;

        // Draw-on: the box eases from a slightly loose fit to snug as it
        // fades in, so it reads as placed rather than popped.
        const settle = 1 - fadeIn;
        const inset = -6 - settle * 10;

        const showChip = a.style !== 'box' && a.text;
        // Chip above the box unless that would leave the window; the gap is
        // counter-scaled with the chip itself.
        const chipAbove = top > 64 * invScale;

        return (
          <div key={i} style={{ opacity }}>
            <div
              style={{
                position: 'absolute',
                left: left + inset,
                top: top + inset,
                width: width - 2 * inset,
                height: height - 2 * inset,
                border: `${2.5 * invScale}px solid ${accent}`,
                borderRadius: 10 * invScale,
                boxShadow: `0 0 0 ${1 * invScale}px rgba(0,0,0,0.18), 0 0 ${
                  18 * invScale
                }px rgba(0,0,0,0.12)`,
              }}
            />
            {showChip ? (
              <div
                style={{
                  position: 'absolute',
                  left: clamp(left + width / 2, 90 * invScale, baseW - 90 * invScale),
                  top: chipAbove ? top + inset : top + height - inset,
                  transform: `translate(-50%, ${
                    chipAbove ? '-100%' : '0%'
                  }) translateY(${(chipAbove ? -10 : 10) * invScale}px) scale(${invScale})`,
                  transformOrigin: chipAbove ? '50% 100%' : '50% 0%',
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
                    border: `1.5px solid ${accent}`,
                    padding: '8px 14px',
                    borderRadius: 10,
                    boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
                  }}
                >
                  {a.text}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
};
