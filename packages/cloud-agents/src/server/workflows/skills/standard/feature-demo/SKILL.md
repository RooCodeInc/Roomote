---
name: feature-demo
description: Produce a polished, Screen Studio-style demo video of a product feature — recorded live in the sandbox browser, with smooth zooms, cursor effects, captions, and optional voice-over narration.
---

<role>
You produce short, polished feature-demo videos: a real recording of the
product driven live in the browser, narrated as a flowing story. The camera
reads the page the way a person does — scrolling, mostly wide — and zooms in
only when an interaction happens (cursor glide, click ripple). Captions
carry the narration on screen, and when the deployment has narration
configured, a voice-over speaks each line as its visual arrives.

Use this skill when the user asks for a demo video, walkthrough recording,
or promo clip of a feature. It is NOT for verification screencasts of a code
change — that is `capture-visual-proof`.
</role>

<architecture>
The narrative drives the visuals. The demo is planned as a spoken story
first; narration is synthesized (or, captions-only, each line's speaking
time is estimated) BEFORE capture, and the capture runner conducts the
browser to it — each beat holds for exactly as long as its line takes to
speak, and clip start times are stamped at the moment each zoom lands. The
runner also logs, on the same clock, where the cursor is, when clicks land,
and the resolved rectangle of every focused element, so a zoom can never
drift from its element and nothing needs retiming afterwards.

Pipeline: plan the narrative → author script → narrate → capture (browser,
delegated, paced to the narrative) → trim opening → render → verify →
upload.

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
<name>Scope and plan the demo (advisor)</name>
<actions>
<action>Delegate the creative plan to the `advisor` subagent with the Task tool — it runs the planning model at deeper reasoning and can read the repository to study the feature. Give it a complete brief: the user's request, the surface to record (URL), the relevant source paths for the feature's UI, the beat vocabulary and cinematography rules from step 2 verbatim, and the narration style rules. Ask it to write the NARRATION FIRST — a flowing spoken story of 4-7 conversational lines (roughly 8-20 words each) that a founder might say while walking a friend through the feature: open with why it matters, walk the what and how, land on the payoff. Then, for each line, the visual that accompanies it: the element to scroll into view (with a proposed resilient CSS selector from source) or, only where the story calls for actually clicking or typing, the interaction. Return that plus which preset(s) fit. A good demo is 25-45 seconds; the narration should carry it — sparse label-style narration makes a hollow video.</action>
<action>Treat the advisor's plan as internal guidance, not finished work: the advisor cannot run commands or see the live page, so its selectors are educated guesses from source. You own verification (step 2) and every artifact. If the advisor returns empty output, retry once with a tighter brief, then plan directly yourself.</action>
<action>Pick presets: `wide` (1920x1080) is the default; add `vertical` (1080x1920) only when the user wants a social/short-form cut.</action>
<action>If the surface needs the app running, make sure the environment is up first (dev server reachable) before capturing.</action>
</actions>
</step>

<step number="2">
<name>Author the demo script</name>
<actions>
<action>Write `/tmp/feature-demo/demo-script.json`: `{ "url": string, "viewport": { "w": 1280, "h": 800 }, "beats": [...] }`. Beat actions:
- `{ "a": "show", "sel": css, "caption": "..." }` — THE DEFAULT NARRATED MOVE: scroll the subject into view and speak over it, camera wide. No zoom, no cursor.
- `{ "a": "wait", "ms": n }` / `{ "a": "hold", "ms": n }` — let the page settle / linger.
- `{ "a": "scrollTo", "sel": css, "ms": n }` — plain scroll with no narration attached.
- `{ "a": "focus", "sel": css, "scale": 1.3-1.9, "moveMs": ~700, "caption": "..." }` — glide the cursor to the element and zoom in. ONLY as the wind-up for an interaction the story actually performs. The renderer caps the zoom at the largest scale that keeps the whole window on the stage (roughly 1.16 in the wide preset with captions), so the push-in is deliberately gentle no matter what you ask for; the cursor glide and the framing shift toward the target carry the moment.
- `{ "a": "click", "sel": css, "holdMs": ~300 }` — real click with ripple.
- `{ "a": "type", "sel": css, "text": "..." }` — real typing.
- `{ "a": "reset", "ms": ~600 }` — pull back after an interaction (partial by design; pass `"full": true` only for the closing shot).</action>
<action>Cinematography: the camera mostly stays wide and MOVES BY SCROLLING — that is how a person actually reads a page, and constant zooming reads as artificial. Zoom (`focus`) only when the demo is about to click or type, so the zoom communicates "watch this interaction," and pull back (`reset`) right after. Most demos want zero to two zooms total; a demo with no interaction should have none.</action>
<action>Keep the opening tight: one short `wait` for page load, then get moving. Dead opening seconds are trimmed automatically, but do not rely on it.</action>
<action>Captions ARE the narration, verbatim — what the viewer reads is exactly what the voice says, and narrated demos highlight each word as it is spoken. Write them as full conversational sentences (roughly 8-20 words): contractions are good, symbols and clause pileups are not. They appear on screen while spoken and wrap to two lines.</action>
<action>Caption display can be tuned declaratively with a top-level `"captionStyle"` object in the demo script — `{ "position": "top"|"bottom", "accent": cssColor, "pill": boolean, "sizeScale": number }` — controlling placement, the active-word highlight color, the pill background (off = bare text with a drop shadow), and a font-size multiplier. Use it for brand-fit requests ("captions on top", "highlight in our green"); deeper caption redesigns go through the render-template adaptation path in step 6.</action>
<action>Selectors must be resilient: prefer ids, stable data attributes, or unique semantic tags over deep CSS chains. How you gain confidence before capture depends on the surface:
- Repository-backed surface (the app's own UI): grep the component/template source for each proposed selector and confirm it exists — cheap and worth doing every time.
- External public page named by the user: there is no local source to grep, and the browser is reachable only through the single capture delegation (the `proof-runner` takes one brief per task and keeps its configured surface, so a separate pre-flight is not available). Author best-effort resilient selectors — landmark roles, headings, obvious ids the advisor inferred; avoid deep chains — and rely on capture's own validation: the runner resolves every selector live and fails loudly naming any that do not resolve. Use that named failure to correct the script and re-capture within the one allowed retry (step 3).</action>
</actions>
</step>

<step number="3">
<name>Narrate first (the narrative drives the visuals)</name>
<actions>
<action>Synthesize the narration BEFORE capture: `SCRIPT=/tmp/feature-demo/demo-script.json node "$HOME/.agents/skills/feature-demo/scripts/build-narration.mjs"`. This posts the caption lines to the Roomote control plane, which holds the TTS credentials — no provider key exists in this sandbox, and you must never ask for one. It writes `/tmp/feature-demo/vo/*.mp3` and `/tmp/feature-demo/narration.json` with each line's measured duration and per-word timings (used by the renderer to highlight the word being spoken); during capture, each beat then holds exactly as long as its line takes to speak, and clip start times are stamped as the visuals land. No retiming happens afterwards.</action>
<action>Exit code 3 means narration is not configured on this deployment: proceed captions-only — capture paces each captioned beat from the caption's estimated speaking time instead, so the demo still reads at narrative pace. Mention in the final report that voice-over is available if an admin connects ElevenLabs under Settings → Integrations.</action>
</actions>
</step>

<step number="4">
<name>Capture (delegated browser work)</name>
<actions>
<action>Stage the capture runner where the delegated runtime can see it — home-directory paths do not survive the delegation boundary, so always copy first:

`mkdir -p /tmp/feature-demo && cp "$HOME/.agents/skills/feature-demo/capture/capture.mjs" /tmp/feature-demo/capture.mjs`

The runner also reads `/tmp/feature-demo/narration.json` (written in step 3) on its own; captions-only runs simply will not have one.</action>
<action>Browser automation is the proof-runner subagent's exclusive surface — do not load `agent-browser` or run the capture yourself. Delegate with the Task tool to `proof-runner`, telling it the script path (`/tmp/feature-demo/demo-script.json`), the output dir (`/tmp/feature-demo/work`), and the staged runner path (`/tmp/feature-demo/capture.mjs`), and to report the runner's printed summary plus `ls -la /tmp/feature-demo/work`. The staged runner is proof-runner's one sanctioned script exception — an agent-browser orchestrator that shells the `agent-browser` CLI for every browser action — and its own instructions define the exact integrity-verified command it must use to execute it. Do not dictate the `node` invocation yourself; the proof-runner owns that.</action>
<action>If the harness has no proof-runner registered, report a blocker (`proof runtime unavailable`) instead of driving the browser from this skill.</action>
<action>Expected outputs: `/tmp/feature-demo/work/recording.mp4` and `/tmp/feature-demo/work/timeline.json`. Verify both exist and that `ffprobe` reports a duration close to the timeline's `durationSeconds` (the runner itself fails loudly when the recording is much shorter than the interaction). One retry on failure; then report blocked with the runner's error.</action>
<action>The runner records headless with an imperceptible frame ticker, which is deterministic and captures at wall-clock rate on ordinary pages. It stops any existing agent-browser daemon first so the beats and the recorder share one page.</action>
<action>If a recording comes back much shorter than the interaction, the runner fails loudly. GPU-backed surfaces (WebGL/WebGPU, 3D, games) do not present frames to the headless compositor and cannot be recorded here — report `webgl surface stalls recording` naming the surface rather than retrying. If `record stop` itself reports an ffmpeg error, the sandbox is likely a stale snapshot with an outdated runtime ffmpeg (`stale sandbox runtime`).</action>
</actions>
</step>

<step number="5">
<name>Trim the opening</name>
<actions>
<action>Run `WORK_DIR=/tmp/feature-demo/work node "$HOME/.agents/skills/feature-demo/scripts/fit-timing.mjs"`. Because capture was paced to the narrative, there is nothing to retime — this only cuts the dead opening hold (page-load settle) so the demo starts immediately, shifting timeline, captions, and clip starts together. Check its printed line schedule for sanity.</action>
</actions>
</step>

<step number="6">
<name>Render</name>
<actions>
<action>Assemble the render project in the work dir:
- `cp -R "$HOME/.agents/skills/feature-demo/render" /tmp/feature-demo/render`
- `cp /tmp/feature-demo/work/timeline.json /tmp/feature-demo/work/narration.json /tmp/feature-demo/render/props/` (skip narration.json if captions-only; the checked-in placeholder `{ "clips": [] }` is already correct)
- `mkdir -p /tmp/feature-demo/render/public && cp /tmp/feature-demo/work/recording.mp4 /tmp/feature-demo/render/public/`
- `cp -R /tmp/feature-demo/vo /tmp/feature-demo/render/public/vo` (narrated demos only; the mp3s were written next to the script in step 3)</action>
<action>Adapt the copied composition when the default look does not fit the request — different backdrop, caption treatment, brand colors, an extra preset, a layout change. Before writing Remotion code, install just the Remotion agent skills relevant to editing an existing composition and read them for current API guidance: `cd /tmp/feature-demo/render && npx -y skills add remotion-dev/skills --skill remotion-markup --skill remotion-render --skill remotion-docs --yes` (markup, render, and doc lookup — not the full bundle, which also carries create/maps/saas/upgrade skills you do not need here). Preserve the pieces that encode hard-won correctness unless you have a reason not to: the zoom transform with its counter-scaled cursor, the zoom cap and edge clamps (which keep the window either wholly on the stage or fully covering it, never cropped with backdrop showing down one side), and the timeline-driven keyframe interpolation.</action>
<action>Provide the dependencies. The image pre-installs the render project's node_modules (Remotion + React) at `/opt/feature-demo/render/node_modules`, keyed off this same pinned `package.json`, so normally you reuse them with no network install: `cp -R /opt/feature-demo/render/node_modules /tmp/feature-demo/render/node_modules`. Then run `cd /tmp/feature-demo/render && npm install` only if you adapted the composition to add dependencies (it reconciles just the delta), or if the baked modules are absent (older sandbox snapshot), in which case it does a full install.</action>
<action>Render with the image's baked headless shell:

`npx remotion render src/index.ts Demo-wide out/demo-wide.mp4 --browser-executable="${REMOTION_HEADLESS_SHELL_PATH:-/opt/remotion/headless-shell}" --log=error`

Run this with a GENEROUS command timeout (10 minutes) on the first attempt: a narrative-length cut is 750+ frames rendering in software on a small container, which routinely exceeds the default two-minute command window — a timeout there is wasted work, not a render failure. If the binary does not exist (older sandbox snapshot), run `npx remotion browser ensure` once and render without the flag. Repeat for `Demo-vertical` when the vertical preset was requested.</action>
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
