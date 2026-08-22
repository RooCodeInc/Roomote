# feature-demo render template

A reference Remotion composition for feature-demo videos. At demo time the
agent copies this directory into the sandbox work dir and may adapt the copy
(branding, caption styling, layout, presets) — see `../SKILL.md`.

The stable contract is `props/timeline.json` (emitted by the capture runner)
and `props/narration.json` (emitted by the narration scripts): compositions
render those; adaptations change how they look, not what they mean.

Worth preserving when adapting — each encodes a bug class found the hard way:

- **Counter-scaled cursor/ripple/annotations** (`DemoStage.tsx`,
  `Annotations.tsx`): overlays are children of the window transform container
  with a `1/S` counter-scale on their chrome, so they stay glued to page
  coordinates at constant on-screen size under a preset `baseScale`.
- **Unconditional edge clamps** (`DemoStage.tsx`): the same pair of translate
  bounds means "keep covering the stage" when the scaled window exceeds it
  and "stay inside the stage" when it does not — the two just swap order —
  so clamping to their min/max is correct in both regimes. Do not gate the
  clamps on window size; the gated version let a nearly-stage-height window
  drift into the caption band.
- **Window-clipped annotations** (`Annotations.tsx`): the annotation layer is
  clipped to the window rect (same 16px radius as the video panel) so a
  spotlight dim covers exactly the recording — never the backdrop or the
  caption band — and each annotation lives strictly inside its beat's
  caption window, because its anchor rect is only valid for the scroll
  position it was measured at.
- **Timeline-driven interpolation**: all motion eases between capture-emitted
  keys. Do not invent motion that is not in the timeline — it will drift
  from the recording.

This directory is excluded from the repo's typecheck/lint/knip on purpose:
it is not part of the package graph and runs only from a work-dir copy with
its own pinned `npm install`.
