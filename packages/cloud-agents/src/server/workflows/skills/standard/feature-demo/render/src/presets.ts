export type CaptionStyle = {
  fontSize: number;
  bottom: number;
  maxWidthPct: number;
};

export type Preset = {
  id: 'wide' | 'vertical';
  width: number;
  height: number;
  pad: number;
  caption: CaptionStyle;
  // How strongly a zoom pulls its focal point toward center. 0 keeps the
  // window fixed and punches in place (right for vertical bands).
  centerPull: number;
  // Baseline zoom so a preset never fully zooms out (keeps a vertical band
  // filled). Zooms add on top of it.
  baseScale: number;
};

// One capture feeds every preset; presets differ only in framing and caption
// emphasis. No title cards or branding — the narration + captions carry it.
export const PRESETS: Record<Preset['id'], Preset> = {
  wide: {
    id: 'wide',
    width: 1920,
    height: 1080,
    pad: 120,
    caption: { fontSize: 34, bottom: 70, maxWidthPct: 74 },
    centerPull: 0.9,
    baseScale: 1,
  },
  vertical: {
    id: 'vertical',
    width: 1080,
    height: 1920,
    pad: 90,
    caption: { fontSize: 46, bottom: 300, maxWidthPct: 86 },
    centerPull: 0,
    baseScale: 1.25,
  },
};

// Roomote brand lime (--background-new: oklch(0.911 0.185 117.691) in the
// web app theme, ≈ #c9f24d) with a subtle radial falloff for depth.
export const BACKDROP =
  'radial-gradient(120% 120% at 20% 0%, #d7f875 0%, #c9f24d 55%, #a9d33c 100%)';
