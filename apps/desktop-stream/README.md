# Roomote desktop stream

`roomote-desktop-stream` is a small Rust service for streaming an existing X11
desktop from a Roomote sandbox. It runs one FFmpeg encoder shared by all
viewers and serves low-latency fragmented MP4 with H.264 video (audio capture
is available but disabled by default). The browser uses its native media pipeline, so decoding can use client
hardware acceleration without a custom JavaScript codec.

The service is intended to run behind an authenticated Roomote Live Preview
port. It does not implement its own public authentication and must not be
exposed as an unauthenticated port.

## Local benchmark

Synthetic video and audio make the full encode, transport, and browser decode
path testable without an X server or PulseAudio:

```bash
ROOMOTE_DESKTOP_STREAM_CAPTURE_MODE=test \
ROOMOTE_DESKTOP_STREAM_AUDIO_MODE=test \
cargo run --manifest-path apps/desktop-stream/Cargo.toml
```

Open `http://127.0.0.1:6080`, start playback, and inspect `/metrics`. The player
reports measured rendered FPS and startup-to-first-frame time; encoder progress
reports output FPS and bitrate. These measurements describe the current host
and configuration, not a general 1080p60 or 1-vCPU guarantee.

### Reference 1-vCPU benchmark

A sandbox-local benchmark pinned the Rust service and Ubuntu FFmpeg 6.1 to one
CPU while capturing a continuously animated 1920x1080 X11 Chromium window at a
60 FPS target with PulseAudio/AAC enabled. The encoder reported about 60.3 FPS
at 6.09 Mbps, while the actual headless Chromium client rendered 47.5 FPS,
reported 66 cumulative dropped frames, and decoded its first frame after 2.32
seconds. FFmpeg used about 40% of the one allowed CPU over a 10-second `/proc`
sample and about 276 MiB RSS.

The same run measured browser-event-to-XTest-flush latency at 0.95 ms average
and 1.69 ms maximum on the local host. That is not input-to-photon latency; the
prototype does not yet embed capture timestamps in frames. The benchmark proves
the 1080p60 encoder target and synchronized audio path under that fixture, but
does not prove delivered 1080p60 or parity with proprietary implementations.

The benchmark client was headless Chromium with SwiftShader and GPU compositing
disabled, so it could not validate client hardware decoding. A broader manual
affinity run pinned Xvfb, source Chromium, PulseAudio, Rust/FFmpeg, and the
client Chromium process tree to one CPU; it delivered 44.5 browser-rendered FPS
at 5.93 Mbps with a 1.42-second first frame. The task sandbox does not expose a
provider-level cgroup or VM CPU control, so this constrains the user-space media
pipeline but is not a verified whole-VM 1-vCPU benchmark.

## Production inputs

The defaults capture `:99.0` at 1920x1080, 60 fps, 6 Mbps, with audio disabled.
Set these variables as needed:

- `ROOMOTE_DESKTOP_STREAM_DISPLAY` for the existing X11 display
- `ROOMOTE_DESKTOP_STREAM_WIDTH` and `ROOMOTE_DESKTOP_STREAM_HEIGHT` for the
  initial screen size; a viewer can send a `resize` control event and the
  service resizes the X screen through RandR and restarts the encoder. This
  requires an X server with dynamic screen sizes (TigerVNC's Xvnc); Xvfb only
  offers its configured mode
- `ROOMOTE_DESKTOP_STREAM_FPS`
- `ROOMOTE_DESKTOP_STREAM_VIDEO_BITRATE_KBPS`
- `ROOMOTE_DESKTOP_STREAM_AUDIO_MODE=pulse` to capture a PulseAudio source
- `ROOMOTE_DESKTOP_STREAM_PULSE_SOURCE`, usually a sink monitor such as
  `roomote_stream.monitor`
- `ROOMOTE_DESKTOP_STREAM_MAX_CLIENTS` to cap viewers (default 0, unlimited).
  Viewers share one encoder: the service splits FFmpeg's fragmented MP4 into
  the init segment and keyframe-aligned fragments and fans them out, so each
  viewer costs bandwidth, not another encode. A viewer that stops reading is
  dropped rather than allowed to stall the encoder; the encoder itself stops
  a few seconds after the last viewer leaves. A new control connection always
  supersedes the previous one, and only the current controller can resize the
  screen

The control WebSocket accepts the authenticated Roomote preview-proxy marker,
a same-origin request, or the single origin named by
`ROOMOTE_DESKTOP_STREAM_ALLOWED_CONTROL_ORIGIN`. The worker sets that variable
to the Roomote app origin because the sandbox auth proxy validates the
task-scoped preview token and then strips its marker on WebSocket upgrades,
leaving only the browser `Origin`. It is a single exact origin, never a
wildcard, and it does not replace task-scoped preview authentication.

The sandbox application must render into the selected X11 display. For audio,
route application output into the selected PulseAudio sink and capture its
monitor. The worker image includes Xvfb, PulseAudio, and an FFmpeg build with
X11 and PulseAudio inputs, but does not start a desktop session automatically.
