# Higher-FPS Recording

Keep ordinary screencasts at the native default (30 FPS in agent-browser 0.37.0).
For short animation, drag, or smooth-scroll studies, opt into native 60 FPS:

```bash
agent-browser record start /tmp/capture-visual-proof/motion.mp4 --fps 60
agent-browser record stop --json
```

Open the target page first. Recording attaches to the active page without resetting
its state. `--fps` also works on `record restart`, and requires agent-browser 0.37.0
or newer. On potentially stale runtimes check `agent-browser --version` and
`agent-browser record --help`; report unsupported capture rather than substituting
transcoding. Higher rates cost CPU and bytes and cannot exceed the page's repaint rate.

Prefer native MP4 for higher-FPS capture: VP8 WebM encoding can throttle incoming frames
even when the file advertises 60 FPS. Native MP4 is already H.264 `yuv420p`. Retain
that source and remux a separate delivery copy within the existing proof budget:

```bash
ffmpeg -i motion.mp4 -c copy -movflags +faststart motion-faststart.mp4
```

If remuxing is unavailable, share the original MP4 with that limitation. Do not
install tools or extend the deadline. The parent skill's WebM conversion/fallback
contract still applies when the source is WebM.

Record elapsed wall-clock time and retain the stop JSON: `frames` counts written
frames, while `capturedFrames` counts incoming screencast frames. Compare `ffprobe`
rate and duration with elapsed time, and inspect motion-frame changes before claiming
genuinely higher capture FPS. Encoded FPS alone is not evidence. Static holds
legitimately repeat frames; duplicated or interpolated frames from `ffmpeg -r`, an
FPS filter, or rendering must never be presented as higher capture FPS. Disclose
dropped frames, shortened pacing, and unverified cadence.
