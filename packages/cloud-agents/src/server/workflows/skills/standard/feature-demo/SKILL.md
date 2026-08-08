---
name: feature-demo
description: Produce a polished, Screen Studio-style demo video of a product feature — recorded live in the sandbox browser, with smooth zooms, cursor effects, captions, and optional voice-over narration.
---

<role>
You produce short, polished feature-demo videos: a real recording of the
product driven live in the browser, post-produced with smooth zoom-to-element
moves, a synthetic cursor, click ripples, captions, and (when the deployment
has narration configured) a voice-over that leads each visual beat.

Use this skill when the user asks for a demo video, walkthrough recording,
or promo clip of a feature. It is NOT for verification screencasts of a code
change — that is `capture-visual-proof`.
</role>

<architecture>
One demo script drives everything. The capture runner performs the real
browser interactions AND records, on the same clock, where the cursor is,
when clicks land, and the resolved rectangle of every focused element. The
renderer consumes that timeline, so a zoom can never drift from the element
it targets.

Pipeline: author script → capture (browser, delegated) → narrate (optional)
→ fit timing → render → verify → upload.

The bundled `render/` project is a **reference template**, not a fixed
pipeline stage: copy it to the work dir and adapt the copy freely (branding,
caption styling, layout, extra presets) when the demo calls for it. The
timeline JSON is the stable contract between capture and render — keep the
copy consuming it and any adaptation stays in sync with the recording.

All work happens under `/tmp/feature-demo/work` (the work dir). Nothing from
this pipeline is ever committed to the repository.
</architecture>

<workflow>

<step number="1">
<name>Scope the demo</name>
<actions>
<action>Identify the feature, the surface to record (running app in the sandbox, or a public page the user names), and 2-5 story beats. A good demo is 10-25 seconds of motion; more beats than that dilutes it.</action>
<action>Pick presets: `wide` (1920x1080) is the default; add `vertical` (1080x1920) only when the user wants a social/short-form cut.</action>
<action>If the surface needs the app running, make sure the environment is up first (dev server reachable) before capturing.</action>
</actions>
</step>

<step number="2">
<name>Author the demo script</name>
<actions>
<action>Write `/tmp/feature-demo/demo-script.json`: `{ "url": string, "viewport": { "w": 1280, "h": 800 }, "beats": [...] }`. Beat actions:
- `{ "a": "wait", "ms": n }` / `{ "a": "hold", "ms": n }` — let the page settle / linger.
- `{ "a": "scrollTo", "sel": css, "ms": n }` — scroll an element into view (the scroll shows in the recording).
- `{ "a": "focus", "sel": css, "scale": 1.3-1.9, "moveMs": ~700, "holdMs": 800-1200, "caption": "..." }` — glide the cursor to the element and zoom to it. Captions become the narration lines.
- `{ "a": "click", "sel": css, "holdMs": ~300 }` — real click with ripple.
- `{ "a": "type", "sel": css, "text": "..." }` — real typing.
- `{ "a": "reset", "ms": ~600 }` — pull back between beats (partial by design; pass `"full": true` only for the closing shot).</action>
<action>Keep the opening tight: one short `wait` for page load, then get moving. Dead opening seconds are trimmed automatically, but do not rely on it.</action>
<action>Write captions as short, conversational spoken lines (they double as the narration): contractions are good, symbols and long clauses are not. 3-9 words on screen; if the spoken wording should differ from the on-screen caption, put the spoken variants in `/tmp/feature-demo/lines.json` (array, one string per caption).</action>
<action>Selectors must be resilient: prefer ids, stable data attributes, or unique semantic tags over deep CSS chains. The capture fails loudly on a selector that resolves to nothing.</action>
</actions>
</step>

<step number="3">
<name>Capture (delegated browser work)</name>
<actions>
<action>Stage the capture runner where the delegated runtime can see it — home-directory paths do not survive the delegation boundary, so always copy first:

`mkdir -p /tmp/feature-demo && cp "$HOME/.agents/skills/feature-demo/capture/capture.mjs" /tmp/feature-demo/capture.mjs`</action>
<action>Browser automation is the proof-runner subagent's exclusive surface — do not load `agent-browser` or run the capture yourself. Delegate with the Task tool to `proof-runner`, telling it the script path (`/tmp/feature-demo/demo-script.json`), the output dir (`/tmp/feature-demo/work`), and the staged runner path (`/tmp/feature-demo/capture.mjs`), and to report the runner's printed summary plus `ls -la /tmp/feature-demo/work`. The staged runner is proof-runner's one sanctioned script exception — an agent-browser orchestrator that shells the `agent-browser` CLI for every browser action — and its own instructions define the exact integrity-verified command it must use to execute it. Do not dictate the `node` invocation yourself; the proof-runner owns that.</action>
<action>If the harness has no proof-runner registered, report a blocker (`proof runtime unavailable`) instead of driving the browser from this skill.</action>
<action>Expected outputs: `/tmp/feature-demo/work/recording.mp4` and `/tmp/feature-demo/work/timeline.json`. Verify both exist and that `ffprobe` reports a duration close to the timeline's `durationSeconds` (the runner itself fails loudly when the recording is much shorter than the interaction). One retry on failure; then report blocked with the runner's error.</action>
<action>If the runner fails with a recording much shorter than the interaction, diagnose by target: WebGL/canvas-heavy surfaces (games, 3D visualizations) can stall headless frame production for the whole page, so ordinary web UIs on the same sandbox record fine while that one surface collapses. Report the blocker as `webgl surface stalls headless recording`, naming the surface — do not burn retries. Separately, if `record stop` itself reports an ffmpeg error, the sandbox is likely a stale snapshot with an outdated runtime ffmpeg (`stale sandbox runtime`).</action>
</actions>
</step>

<step number="4">
<name>Narration (optional, degrades cleanly)</name>
<actions>
<action>Run `WORK_DIR=/tmp/feature-demo/work node "$HOME/.agents/skills/feature-demo/scripts/build-narration.mjs"` (add `LINES=/tmp/feature-demo/lines.json` if spoken lines differ from captions). This posts the caption text to the Roomote control plane, which holds the TTS credentials — no provider key exists in this sandbox, and you must never ask for one.</action>
<action>Exit code 3 means narration is not configured on this deployment: proceed captions-only, and mention in the final report that narration is available if an admin sets `R_ELEVENLABS_API_KEY` + `R_ELEVENLABS_VOICE_ID`.</action>
</actions>
</step>

<step number="5">
<name>Fit timing</name>
<actions>
<action>Run `WORK_DIR=/tmp/feature-demo/work node "$HOME/.agents/skills/feature-demo/scripts/fit-timing.mjs"`. It trims the dead opening, optionally paces the voice-over (pitch-preserving atempo), solves a video playback rate so each spoken line starts just before its zoom lands, and rewrites caption windows to match the audio. Captions-only demos still get the opening trim.</action>
<action>Check its printed schedule: no line should start before the previous one ends. If lines overlap or the rate hits the 0.75 floor, the narration is too long for the motion — shorten the lines or add holds to the script and recapture.</action>
</actions>
</step>

<step number="6">
<name>Render</name>
<actions>
<action>Assemble the render project in the work dir:
- `cp -R "$HOME/.agents/skills/feature-demo/render" /tmp/feature-demo/render`
- `cp /tmp/feature-demo/work/timeline.json /tmp/feature-demo/work/narration.json /tmp/feature-demo/render/props/` (skip narration.json if captions-only; the checked-in placeholder `{ "clips": [] }` is already correct)
- `mkdir -p /tmp/feature-demo/render/public && cp /tmp/feature-demo/work/recording.mp4 /tmp/feature-demo/render/public/`
- `cp -R /tmp/feature-demo/work/vo /tmp/feature-demo/render/public/vo` (narrated demos only)</action>
<action>Adapt the copied composition when the default look does not fit the request — different backdrop, caption treatment, brand colors, an extra preset, a layout change. Before writing Remotion code, install Remotion's official agent skills into the render copy and read them for current API guidance: `cd /tmp/feature-demo/render && npx -y skills add remotion-dev/skills`. Preserve the pieces that encode hard-won correctness unless you have a reason not to: the zoom transform with its counter-scaled cursor, the edge-clamp guard (only clamp an axis when the scaled window exceeds the canvas), and the timeline-driven keyframe interpolation.</action>
<action>`cd /tmp/feature-demo/render && npm install` (versions are pinned; takes a few minutes on first run).</action>
<action>Render with the image's baked headless shell:

`npx remotion render src/index.ts Demo-wide out/demo-wide.mp4 --browser-executable="${REMOTION_HEADLESS_SHELL_PATH:-/opt/remotion/headless-shell}" --log=error`

If that binary does not exist (older sandbox snapshot), run `npx remotion browser ensure` once and render without the flag. Repeat for `Demo-vertical` when the vertical preset was requested.</action>
</actions>
</step>

<step number="7">
<name>Verify honestly</name>
<actions>
<action>`ffprobe` the output: sane duration, a video stream, and an audio stream when narration was generated.</action>
<action>Extract 3-4 spread frames (`ffmpeg -ss <t> -i out/demo-wide.mp4 -frames:v 1 frame.png`) and review each whole frame: zoom landed on the right element, cursor glued to it, caption legible and correctly timed, no backdrop showing through mid-zoom, no broken page state in shot.</action>
<action>A defect in the video is a blocker to report, not something to ship quietly. One recapture/re-render attempt; then report blocked with what failed and the frames that show it.</action>
</actions>
</step>

<step number="8">
<name>Deliver</name>
<actions>
<action>Upload the mp4 via `manage_artifacts` (`action: upload`, `type: general`) plus one representative keyframe PNG. Treat only the returned `artifactId`/`viewUrl`/`rawUrl` values as canonical — never invent URLs.</action>
<action>In a PR body, embed under `## Screencasts` using the existing convention: the keyframe image (its signed `rawUrl`) hyperlinked to the video's `viewUrl`, with a one-line caption. In chat replies, share the keyframe via image attachment and the video `viewUrl` as a link (video files cannot be attached inline).</action>
<action>End with a sharing note: what the demo shows, which presets were rendered, and whether it is narrated or captions-only.</action>
</actions>
</step>

</workflow>

<rules>
<rule>Never load or invoke `agent-browser` (or any other browser automation) from this skill — capture is always delegated to the `proof-runner` subagent.</rule>
<rule>Never ask for, read, or handle TTS provider keys. Narration goes through the control-plane endpoint with the run token; a 404 there means captions-only.</rule>
<rule>All intermediate files live under `/tmp/feature-demo`. Never commit recordings, renders, node_modules, or props into the repository.</rule>
<rule>Adapt the work-dir copy of the render template, never the installed skill sources under `~/.agents/skills/feature-demo`. The timeline JSON schema is the stable contract: adaptations change how it is rendered, not what it means.</rule>
<rule>Report blockers honestly: a missing selector, a failed render, or a visibly broken frame is a blocker with evidence, not a reason to narrow the claim or ship a degraded video silently.</rule>
<rule>Voice, wording, and pacing choices belong to the user when they express them; defaults are: wide preset, captions as narration lines, conversational tone.</rule>
</rules>
