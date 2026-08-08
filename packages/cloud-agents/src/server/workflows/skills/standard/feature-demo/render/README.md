# feature-demo render template

A reference Remotion composition for feature-demo videos. At demo time the
agent copies this directory into the sandbox work dir and may adapt the copy
(branding, caption styling, layout, presets) — see `../SKILL.md`.

The stable contract is `props/timeline.json` (emitted by the capture runner)
and `props/narration.json` (emitted by the narration scripts): compositions
render those; adaptations change how they look, not what they mean.

Worth preserving when adapting — each encodes a bug class found the hard way:

- **Counter-scaled cursor/ripple** (`DemoStage.tsx`): cursor and ripple are
  children of the zoom-transform container with a `1/S` counter-scale, so
  they stay glued to page coordinates at constant size through any zoom.
- **Edge-clamp guard** (`DemoStage.tsx`): the translate that keeps backdrop
  from showing behind the window must only clamp an axis when the scaled
  window exceeds the canvas on that axis; clamping a smaller-than-canvas
  window (vertical presets) shoves it into a corner.
- **Timeline-driven interpolation**: all motion eases between capture-emitted
  keys. Do not invent motion that is not in the timeline — it will drift
  from the recording.

This directory is excluded from the repo's typecheck/lint/knip on purpose:
it is not part of the package graph and runs only from a work-dir copy with
its own pinned `npm install`.
