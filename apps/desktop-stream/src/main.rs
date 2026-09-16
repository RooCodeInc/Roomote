use std::{
    collections::{HashMap, HashSet},
    env,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    process::Stdio,
    str::FromStr,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::Instant,
};

use async_stream::stream as async_stream;
use axum::{
    Json, Router,
    body::Body,
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, HeaderValue, StatusCode, Uri, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpListener,
    process::Command,
    sync::watch,
};
use tokio_util::io::ReaderStream;
use x11rb::{
    connection::Connection,
    protocol::{
        randr::{self, ConnectionExt as RandrConnectionExt},
        xproto::{
            BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ConfigureWindowAux,
            ConnectionExt as XprotoConnectionExt, KEY_PRESS_EVENT, KEY_RELEASE_EVENT,
            MOTION_NOTIFY_EVENT, MapState, Window,
        },
        xtest::ConnectionExt as XtestConnectionExt,
    },
    rust_connection::RustConnection,
};

const PLAYER_HTML: &str = include_str!("player.html");

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum CaptureMode {
    X11,
    Test,
}

impl FromStr for CaptureMode {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "x11" => Ok(Self::X11),
            "test" => Ok(Self::Test),
            _ => Err(format!("unsupported capture mode: {value}")),
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum AudioMode {
    Disabled,
    Pulse,
    Test,
}

impl FromStr for AudioMode {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "disabled" => Ok(Self::Disabled),
            "pulse" => Ok(Self::Pulse),
            "test" => Ok(Self::Test),
            _ => Err(format!("unsupported audio mode: {value}")),
        }
    }
}

/// Current X screen dimensions. The initial size comes from configuration;
/// viewers may resize the screen through the control channel so the desktop
/// matches their viewport instead of being letterboxed.
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
struct ScreenSize {
    width: u16,
    height: u16,
}

const MIN_SCREEN_DIMENSION: u16 = 320;
const MAX_SCREEN_DIMENSION: u16 = 4_096;
/// Upper bound on total screen pixels a viewer may request. It matches the
/// web client's budget (1080p worth of pixels with a little slack) so a raw
/// control client cannot demand a 16 MP capture at 60 FPS.
const MAX_SCREEN_PIXELS: u32 = 1_920 * 1_200;

impl ScreenSize {
    /// Validates a viewer-requested size: both dimensions must land within the
    /// supported range and are rounded down to even numbers because the
    /// encoder's 4:2:0 output needs even dimensions.
    fn from_request(width: u16, height: u16) -> Result<Self, String> {
        let width = width & !1;
        let height = height & !1;
        if !(MIN_SCREEN_DIMENSION..=MAX_SCREEN_DIMENSION).contains(&width)
            || !(MIN_SCREEN_DIMENSION..=MAX_SCREEN_DIMENSION).contains(&height)
        {
            return Err(format!(
                "screen size must be {MIN_SCREEN_DIMENSION}-{MAX_SCREEN_DIMENSION} pixels in each dimension"
            ));
        }
        if u32::from(width) * u32::from(height) > MAX_SCREEN_PIXELS {
            return Err(format!(
                "screen size must not exceed {MAX_SCREEN_PIXELS} pixels in total"
            ));
        }
        Ok(Self { width, height })
    }

    /// Physical size reported to X11 for a nominal 96 DPI screen.
    fn millimeters(self) -> (u32, u32) {
        let to_mm = |pixels: u16| (f64::from(pixels) * 25.4 / 96.0).round() as u32;
        (to_mm(self.width), to_mm(self.height))
    }
}

#[derive(Clone, Debug)]
struct Config {
    address: SocketAddr,
    ffmpeg: PathBuf,
    capture_mode: CaptureMode,
    audio_mode: AudioMode,
    display: String,
    pulse_source: String,
    allowed_control_origin: Option<String>,
    width: u16,
    height: u16,
    fps: u16,
    video_bitrate_kbps: u32,
    audio_bitrate_kbps: u16,
    max_clients: usize,
}

impl Config {
    fn from_env() -> Result<Self, String> {
        let host = env::var("ROOMOTE_DESKTOP_STREAM_HOST").unwrap_or_else(|_| "0.0.0.0".into());
        let port = parse_env("ROOMOTE_DESKTOP_STREAM_PORT", 6080_u16)?;
        let address = SocketAddr::new(
            host.parse::<IpAddr>()
                .map_err(|error| format!("invalid ROOMOTE_DESKTOP_STREAM_HOST: {error}"))?,
            port,
        );
        let width = parse_env("ROOMOTE_DESKTOP_STREAM_WIDTH", 1920_u16)?;
        let height = parse_env("ROOMOTE_DESKTOP_STREAM_HEIGHT", 1080_u16)?;
        let fps = parse_env("ROOMOTE_DESKTOP_STREAM_FPS", 60_u16)?;
        let video_bitrate_kbps = parse_env("ROOMOTE_DESKTOP_STREAM_VIDEO_BITRATE_KBPS", 6_000_u32)?;
        let audio_bitrate_kbps = parse_env("ROOMOTE_DESKTOP_STREAM_AUDIO_BITRATE_KBPS", 128_u16)?;
        let max_clients = parse_env("ROOMOTE_DESKTOP_STREAM_MAX_CLIENTS", 2_usize)?;

        if width == 0
            || height == 0
            || width > 8_192
            || height > 8_192
            || fps == 0
            || fps > 120
            || video_bitrate_kbps == 0
            || max_clients == 0
        {
            return Err(
                "width/height must be 1-8192, fps must be 1-120, and video bitrate/max clients must be positive".into(),
            );
        }

        Ok(Self {
            address,
            ffmpeg: env::var_os("ROOMOTE_DESKTOP_STREAM_FFMPEG")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("/usr/bin/ffmpeg")),
            capture_mode: env::var("ROOMOTE_DESKTOP_STREAM_CAPTURE_MODE")
                .unwrap_or_else(|_| "x11".into())
                .parse()?,
            audio_mode: env::var("ROOMOTE_DESKTOP_STREAM_AUDIO_MODE")
                .unwrap_or_else(|_| "disabled".into())
                .parse()?,
            display: env::var("ROOMOTE_DESKTOP_STREAM_DISPLAY")
                .or_else(|_| env::var("DISPLAY"))
                .unwrap_or_else(|_| ":99.0".into()),
            pulse_source: env::var("ROOMOTE_DESKTOP_STREAM_PULSE_SOURCE")
                .unwrap_or_else(|_| "@DEFAULT_MONITOR@".into()),
            allowed_control_origin: env::var("ROOMOTE_DESKTOP_STREAM_ALLOWED_CONTROL_ORIGIN")
                .ok()
                .map(|value| value.trim_end_matches('/').to_ascii_lowercase()),
            width,
            height,
            fps,
            video_bitrate_kbps,
            audio_bitrate_kbps,
            max_clients,
        })
    }

    fn initial_screen(&self) -> ScreenSize {
        ScreenSize {
            width: self.width,
            height: self.height,
        }
    }

    fn ffmpeg_args(&self, screen: ScreenSize) -> Vec<String> {
        let mut args = vec![
            "-hide_banner".into(),
            "-loglevel".into(),
            "error".into(),
            "-nostdin".into(),
        ];

        match self.capture_mode {
            CaptureMode::X11 => args.extend([
                "-thread_queue_size".into(),
                "8".into(),
                "-f".into(),
                "x11grab".into(),
                // The viewer's own cursor is shown locally, so do not paint the
                // sandbox cursor into the video where it would trail behind.
                "-draw_mouse".into(),
                "0".into(),
                "-framerate".into(),
                self.fps.to_string(),
                "-video_size".into(),
                format!("{}x{}", screen.width, screen.height),
                "-i".into(),
                self.display.clone(),
            ]),
            CaptureMode::Test => args.extend([
                "-re".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                format!(
                    "testsrc2=size={}x{}:rate={}",
                    screen.width, screen.height, self.fps
                ),
            ]),
        }

        match self.audio_mode {
            AudioMode::Disabled => {}
            AudioMode::Pulse => args.extend([
                "-thread_queue_size".into(),
                "512".into(),
                "-f".into(),
                "pulse".into(),
                "-i".into(),
                self.pulse_source.clone(),
            ]),
            AudioMode::Test => args.extend([
                "-re".into(),
                "-f".into(),
                "lavfi".into(),
                "-i".into(),
                "sine=frequency=880:sample_rate=48000".into(),
            ]),
        }

        args.extend([
            "-map".into(),
            "0:v:0".into(),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-threads".into(),
            "1".into(),
            "-tune".into(),
            "zerolatency".into(),
            "-profile:v".into(),
            "baseline".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-x264-params".into(),
            format!("keyint={}:min-keyint={}:scenecut=0", self.fps, self.fps),
            "-b:v".into(),
            format!("{}k", self.video_bitrate_kbps),
            "-maxrate".into(),
            format!("{}k", self.video_bitrate_kbps),
            "-bufsize".into(),
            format!("{}k", self.video_bitrate_kbps / 2),
        ]);

        if self.audio_mode != AudioMode::Disabled {
            args.extend([
                "-map".into(),
                "1:a:0".into(),
                "-c:a".into(),
                "aac".into(),
                "-b:a".into(),
                format!("{}k", self.audio_bitrate_kbps),
                "-ar".into(),
                "48000".into(),
                "-ac".into(),
                "2".into(),
                "-af".into(),
                "aresample=async=1:first_pts=0".into(),
            ]);
        }

        args.extend([
            "-f".into(),
            "mp4".into(),
            "-movflags".into(),
            "empty_moov+default_base_moof+frag_keyframe".into(),
            "-frag_duration".into(),
            "100000".into(),
            "-flush_packets".into(),
            "1".into(),
            "-progress".into(),
            "pipe:2".into(),
            "pipe:1".into(),
        ]);
        args
    }
}

fn parse_env<T>(name: &str, default: T) -> Result<T, String>
where
    T: FromStr,
    T::Err: std::fmt::Display,
{
    match env::var(name) {
        Ok(value) => value
            .parse()
            .map_err(|error| format!("invalid {name}: {error}")),
        Err(_) => Ok(default),
    }
}

#[derive(Clone, Debug, Default, Serialize)]
struct EncoderProgress {
    frame: u64,
    fps: f64,
    bitrate_kbps: f64,
    output_time_ms: u64,
    speed: f64,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct BrowserTelemetry {
    rendered_fps: Option<f64>,
    startup_ms: Option<f64>,
    decoded_bytes: Option<u64>,
    dropped_frames: Option<u64>,
}

#[derive(Default)]
struct Metrics {
    total_clients: AtomicU64,
    bytes_served: AtomicU64,
    progress: Mutex<EncoderProgress>,
    browser: Mutex<BrowserTelemetry>,
    input_latency: Mutex<InputLatency>,
    /// Last pointer position applied through XTest, in screen pixels.
    last_motion: Mutex<Option<(i16, i16)>>,
}

#[derive(Clone, Debug, Default, Serialize)]
struct InputLatency {
    samples: u64,
    last_ms: f64,
    average_ms: f64,
    max_ms: f64,
}

impl InputLatency {
    fn record(&mut self, latency_ms: f64) {
        self.average_ms =
            ((self.average_ms * self.samples as f64) + latency_ms) / (self.samples + 1) as f64;
        self.samples += 1;
        self.last_ms = latency_ms;
        self.max_ms = self.max_ms.max(latency_ms);
    }
}

/// A running per-viewer encoder. Tracked out of band so it can be killed
/// even when its viewer has stopped reading the response, which otherwise
/// blocks the encoder on a full pipe and pins the viewer slot forever.
#[derive(Clone, Debug)]
struct EncoderHandle {
    id: u64,
    pid: u32,
    /// Milliseconds since service start when the viewer last consumed data.
    /// A viewer that stops reading leaves ffmpeg blocked on a full pipe; such
    /// encoders are the first to be evicted for a new viewer.
    last_progress_ms: Arc<AtomicU64>,
}

/// A viewer that has not consumed any stream data for this long is stalled.
const STALLED_VIEWER_MS: u64 = 3_000;

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    metrics: Arc<Metrics>,
    control_connected: Arc<AtomicBool>,
    started_at: Instant,
    /// Current screen size, updated by viewer resize requests.
    screen: Arc<RwLock<ScreenSize>>,
    /// Bumped whenever the screen is resized so running encoders, which
    /// captured at the old size, stop and let the viewer reconnect.
    stream_generation: Arc<watch::Sender<u64>>,
    /// Encoders currently serving viewers, oldest first.
    encoders: Arc<Mutex<Vec<EncoderHandle>>>,
    next_encoder_id: Arc<AtomicU64>,
    /// Bumped when a new control client connects so the previous one is
    /// released: the newest viewer always wins control.
    control_generation: Arc<watch::Sender<u64>>,
}

impl AppState {
    fn screen(&self) -> ScreenSize {
        *self.screen.read().unwrap()
    }

    fn now_ms(&self) -> u64 {
        self.started_at.elapsed().as_millis() as u64
    }

    /// Registers an encoder. When the viewer limit is reached, stalled
    /// viewers (ones no longer reading their stream) are evicted first so an
    /// abandoned tab can never pin the desktop. Healthy viewers are never
    /// evicted: two live viewers reloading into each other would otherwise
    /// fight forever, so the newcomer is refused instead.
    fn register_encoder(&self, pid: u32) -> Result<EncoderHandle, ()> {
        let now = self.now_ms();
        let handle = EncoderHandle {
            id: self.next_encoder_id.fetch_add(1, Ordering::Relaxed),
            pid,
            last_progress_ms: Arc::new(AtomicU64::new(now)),
        };
        let evicted = {
            let mut encoders = self.encoders.lock().unwrap();
            let limit = self.config.max_clients.max(1);
            let mut evicted = Vec::new();
            if encoders.len() >= limit {
                let (stalled, healthy): (Vec<_>, Vec<_>) =
                    encoders.drain(..).partition(|encoder| {
                        now.saturating_sub(encoder.last_progress_ms.load(Ordering::Relaxed))
                            > STALLED_VIEWER_MS
                    });
                *encoders = healthy;
                evicted = stalled;
            }
            if encoders.len() >= limit {
                return Err(());
            }
            encoders.push(handle.clone());
            evicted
        };
        for encoder in evicted {
            kill_encoder(encoder);
        }
        Ok(handle)
    }

    fn unregister_encoder(&self, id: u64) {
        self.encoders
            .lock()
            .unwrap()
            .retain(|encoder| encoder.id != id);
    }

    /// Kills every running encoder, for example after a screen resize, so
    /// viewers reconnect at the new size even if one had stopped reading.
    fn stop_encoders(&self) {
        let encoders = std::mem::take(&mut *self.encoders.lock().unwrap());
        for encoder in encoders {
            kill_encoder(encoder);
        }
    }

    fn active_clients(&self) -> usize {
        self.encoders.lock().unwrap().len()
    }
}

/// Sends SIGKILL to an encoder by pid. The response stream that owns the
/// child reaps it once it is polled again; a viewer that never reads again
/// simply ends when its connection closes.
fn kill_encoder(encoder: EncoderHandle) {
    tokio::spawn(async move {
        let _ = Command::new("kill")
            .args(["-KILL", &encoder.pid.to_string()])
            .status()
            .await;
    });
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ControlEvent {
    PointerMove {
        x: f64,
        y: f64,
    },
    PointerButton {
        button: u8,
        down: bool,
    },
    Wheel {
        delta_x: f64,
        delta_y: f64,
    },
    Key {
        code: String,
        down: bool,
    },
    ReleaseAll,
    /// Resize the X screen to match the viewer's viewport.
    Resize {
        width: u16,
        height: u16,
    },
}

#[derive(Debug, Deserialize)]
struct ControlEnvelope {
    sent_at_ms: Option<u64>,
    #[serde(flatten)]
    event: ControlEvent,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InputAction {
    Motion { x: i16, y: i16 },
    Key { keycode: u8, down: bool },
    Button { button: u8, down: bool },
}

#[derive(Default)]
struct HeldInputs {
    keys: HashSet<u8>,
    buttons: HashSet<u8>,
}

impl HeldInputs {
    fn drain_release_actions(&mut self) -> Vec<InputAction> {
        let mut actions = self
            .keys
            .drain()
            .map(|keycode| InputAction::Key {
                keycode,
                down: false,
            })
            .collect::<Vec<_>>();
        actions.extend(self.buttons.drain().map(|button| InputAction::Button {
            button,
            down: false,
        }));
        actions
    }
}

struct X11Controller {
    connection: RustConnection,
    root: Window,
    keycodes: HashMap<u32, u8>,
    held: HeldInputs,
    width: u16,
    height: u16,
    metrics: Option<Arc<Metrics>>,
}

impl X11Controller {
    fn connect(display: &str, width: u16, height: u16) -> Result<Self, String> {
        let (connection, screen_number) = x11rb::connect(Some(display))
            .map_err(|error| format!("failed to connect to X11 display {display}: {error}"))?;
        let setup = connection.setup();
        let root = setup
            .roots
            .get(screen_number)
            .ok_or_else(|| format!("X11 display {display} has no screen {screen_number}"))?
            .root;
        let min_keycode = setup.min_keycode;
        let count = setup.max_keycode - min_keycode + 1;
        let mapping = connection
            .get_keyboard_mapping(min_keycode, count)
            .map_err(|error| format!("failed to request X11 keyboard mapping: {error}"))?
            .reply()
            .map_err(|error| format!("failed to read X11 keyboard mapping: {error}"))?;
        let keysyms_per_keycode = usize::from(mapping.keysyms_per_keycode);
        let mut keycodes = HashMap::new();
        for (offset, symbols) in mapping.keysyms.chunks(keysyms_per_keycode).enumerate() {
            let keycode = min_keycode.saturating_add(offset as u8);
            for &keysym in symbols {
                if keysym != 0 {
                    keycodes.entry(keysym).or_insert(keycode);
                }
            }
        }

        Ok(Self {
            connection,
            root,
            keycodes,
            held: HeldInputs::default(),
            width,
            height,
            metrics: None,
        })
    }

    /// Current pointer position on the root window.
    fn pointer_position(&self) -> Result<(i16, i16), String> {
        let reply = self
            .connection
            .query_pointer(self.root)
            .map_err(|error| format!("failed to query X11 pointer: {error}"))?
            .reply()
            .map_err(|error| format!("failed to read X11 pointer: {error}"))?;
        Ok((reply.root_x, reply.root_y))
    }

    /// Resizes the X screen through RandR. Xvfb only offers its configured
    /// mode, so this needs an X server with dynamic screen sizes such as
    /// TigerVNC's Xvnc.
    /// Current root window size as reported by the X server.
    fn screen_size(&self) -> Result<ScreenSize, String> {
        let geometry = self
            .connection
            .get_geometry(self.root)
            .map_err(|error| format!("failed to request X11 root geometry: {error}"))?
            .reply()
            .map_err(|error| format!("failed to read X11 root geometry: {error}"))?;
        Ok(ScreenSize {
            width: geometry.width,
            height: geometry.height,
        })
    }

    fn set_screen_size(&mut self, size: ScreenSize) -> Result<(), String> {
        if size.width == self.width && size.height == self.height {
            return Ok(());
        }
        let x11 =
            |error: x11rb::errors::ConnectionError| format!("X11 RandR request failed: {error}");
        let reply = |error: x11rb::errors::ReplyError| format!("X11 RandR reply failed: {error}");
        let resources = self
            .connection
            .randr_get_screen_resources_current(self.root)
            .map_err(x11)?
            .reply()
            .map_err(reply)?;

        // Drive the first output that has a CRTC (Xvnc exposes one, VNC-0).
        let mut target = None;
        for &output in &resources.outputs {
            let info = self
                .connection
                .randr_get_output_info(output, resources.config_timestamp)
                .map_err(x11)?
                .reply()
                .map_err(reply)?;
            let crtc = if info.crtc != 0 {
                Some(info.crtc)
            } else {
                info.crtcs.first().copied()
            };
            if let Some(crtc) = crtc {
                target = Some((output, crtc));
                break;
            }
        }
        let Some((output, crtc)) = target else {
            return Err("X11 server exposes no RandR output to resize".into());
        };

        // Reuse a mode of the requested size or register a new one. Xvnc
        // ignores the timings; they only need to be self-consistent.
        let existing = resources
            .modes
            .iter()
            .find(|mode| mode.width == size.width && mode.height == size.height)
            .map(|mode| mode.id);
        let mode = match existing {
            Some(mode) => mode,
            None => {
                let name = format!("{}x{}_roomote", size.width, size.height);
                let htotal = size.width + 32;
                let vtotal = size.height + 20;
                let mode_info = randr::ModeInfo {
                    id: 0,
                    width: size.width,
                    height: size.height,
                    dot_clock: u32::from(htotal) * u32::from(vtotal) * 60,
                    hsync_start: size.width + 8,
                    hsync_end: size.width + 16,
                    htotal,
                    hskew: 0,
                    vsync_start: size.height + 3,
                    vsync_end: size.height + 6,
                    vtotal,
                    name_len: name.len() as u16,
                    mode_flags: randr::ModeFlag::HSYNC_POSITIVE | randr::ModeFlag::VSYNC_POSITIVE,
                };
                let mode = self
                    .connection
                    .randr_create_mode(self.root, mode_info, name.as_bytes())
                    .map_err(x11)?
                    .reply()
                    .map_err(reply)?
                    .mode;
                self.connection
                    .randr_add_output_mode(output, mode)
                    .map_err(x11)?
                    .check()
                    .map_err(|error| format!("X11 server rejected the new screen mode: {error}"))?;
                mode
            }
        };

        // Same order as xrandr: park the CRTC so the framebuffer can shrink,
        // resize the framebuffer, then bring the CRTC back at the new mode.
        let (mm_width, mm_height) = size.millimeters();
        self.connection
            .randr_set_crtc_config(
                crtc,
                x11rb::CURRENT_TIME,
                resources.config_timestamp,
                0,
                0,
                0,
                randr::Rotation::ROTATE0,
                &[],
            )
            .map_err(x11)?
            .reply()
            .map_err(reply)?;
        self.connection
            .randr_set_screen_size(self.root, size.width, size.height, mm_width, mm_height)
            .map_err(x11)?
            .check()
            .map_err(|error| format!("X11 server rejected screen resize: {error}"))?;
        let status = self
            .connection
            .randr_set_crtc_config(
                crtc,
                x11rb::CURRENT_TIME,
                resources.config_timestamp,
                0,
                0,
                mode,
                randr::Rotation::ROTATE0,
                &[output],
            )
            .map_err(x11)?
            .reply()
            .map_err(reply)?;
        if status.status != randr::SetConfig::SUCCESS {
            return Err(format!(
                "X11 server rejected the resized output configuration: {:?}",
                status.status
            ));
        }
        self.width = size.width;
        self.height = size.height;
        self.fit_windows_to_screen(size);
        Ok(())
    }

    /// There is no window manager on the sandbox display, so top-level
    /// windows keep whatever size they were created with. Resize the mapped
    /// ones to fill the new screen, the way a maximizing window manager
    /// would, so the application follows the viewer's panel. Failures are
    /// logged and ignored: the screen resize itself already succeeded.
    fn fit_windows_to_screen(&self, size: ScreenSize) {
        let tree = match self
            .connection
            .query_tree(self.root)
            .map(|cookie| cookie.reply())
        {
            Ok(Ok(tree)) => tree,
            Ok(Err(error)) => {
                eprintln!("failed to list X11 windows after resize: {error}");
                return;
            }
            Err(error) => {
                eprintln!("failed to list X11 windows after resize: {error}");
                return;
            }
        };
        for window in tree.children {
            let attributes = match self
                .connection
                .get_window_attributes(window)
                .map(|cookie| cookie.reply())
            {
                Ok(Ok(attributes)) => attributes,
                _ => continue,
            };
            if attributes.override_redirect || attributes.map_state != MapState::VIEWABLE {
                continue;
            }
            let values = ConfigureWindowAux::new()
                .x(0)
                .y(0)
                .width(u32::from(size.width))
                .height(u32::from(size.height));
            match self
                .connection
                .configure_window(window, &values)
                .map(|cookie| cookie.check())
            {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    eprintln!("failed to fit X11 window {window} to the screen: {error}");
                }
                Err(error) => {
                    eprintln!("failed to fit X11 window {window} to the screen: {error}");
                }
            }
        }
        let _ = self.connection.flush();
    }

    fn apply(&mut self, event: ControlEvent) -> Result<(), String> {
        let actions = validate_control_event(event, self.width, self.height, |keysym| {
            self.keycodes.get(&keysym).copied()
        })?;
        for action in actions {
            self.apply_action(action)?;
        }
        self.connection
            .flush()
            .map_err(|error| format!("failed to flush X11 input: {error}"))
    }

    fn release_all(&mut self) {
        for action in self.held.drain_release_actions() {
            let _ = self.inject(action);
        }
        let _ = self.connection.flush();
    }

    fn apply_action(&mut self, action: InputAction) -> Result<(), String> {
        match action {
            InputAction::Key { keycode, down } => {
                if down && !self.held.keys.insert(keycode) {
                    return Ok(());
                }
                if !down && !self.held.keys.remove(&keycode) {
                    return Ok(());
                }
            }
            InputAction::Button { button, down } => {
                if down && !self.held.buttons.insert(button) {
                    return Ok(());
                }
                if !down && !self.held.buttons.remove(&button) {
                    return Ok(());
                }
            }
            InputAction::Motion { x, y } => {
                if let Some(metrics) = &self.metrics {
                    *metrics.last_motion.lock().unwrap() = Some((x, y));
                }
            }
        }
        self.inject(action)
    }

    fn inject(&self, action: InputAction) -> Result<(), String> {
        let (event_type, detail, x, y) = match action {
            InputAction::Motion { x, y } => (MOTION_NOTIFY_EVENT, 0, x, y),
            InputAction::Key { keycode, down } => (
                if down {
                    KEY_PRESS_EVENT
                } else {
                    KEY_RELEASE_EVENT
                },
                keycode,
                0,
                0,
            ),
            InputAction::Button { button, down } => (
                if down {
                    BUTTON_PRESS_EVENT
                } else {
                    BUTTON_RELEASE_EVENT
                },
                button,
                0,
                0,
            ),
        };
        self.connection
            .xtest_fake_input(event_type, detail, 0, self.root, x, y, 0)
            .map_err(|error| format!("failed to inject X11 input: {error}"))?;
        Ok(())
    }
}

impl Drop for X11Controller {
    fn drop(&mut self) {
        self.release_all();
    }
}

fn validate_control_event<F>(
    event: ControlEvent,
    width: u16,
    height: u16,
    resolve_keycode: F,
) -> Result<Vec<InputAction>, String>
where
    F: Fn(u32) -> Option<u8>,
{
    match event {
        ControlEvent::PointerMove { x, y } => {
            if !x.is_finite()
                || !y.is_finite()
                || !(0.0..=1.0).contains(&x)
                || !(0.0..=1.0).contains(&y)
            {
                return Err("pointer coordinates must be finite values from 0 to 1".into());
            }
            Ok(vec![InputAction::Motion {
                x: (x * f64::from(width.saturating_sub(1))).round() as i16,
                y: (y * f64::from(height.saturating_sub(1))).round() as i16,
            }])
        }
        ControlEvent::PointerButton { button, down } => {
            let button = match button {
                0 => 1,
                1 => 2,
                2 => 3,
                3 => 8,
                4 => 9,
                _ => return Err("unsupported pointer button".into()),
            };
            Ok(vec![InputAction::Button { button, down }])
        }
        ControlEvent::Wheel { delta_x, delta_y } => {
            if !delta_x.is_finite() || !delta_y.is_finite() {
                return Err("wheel deltas must be finite".into());
            }
            let mut actions = Vec::new();
            append_wheel_actions(&mut actions, delta_y, 4, 5);
            append_wheel_actions(&mut actions, delta_x, 6, 7);
            Ok(actions)
        }
        ControlEvent::Resize { .. } => Err("resize must be handled by the control session".into()),
        ControlEvent::Key { code, down } => {
            if code.len() > 32 || !code.is_ascii() {
                return Err("invalid keyboard code".into());
            }
            let keysym = keysym_for_code(&code)
                .ok_or_else(|| format!("unsupported keyboard code: {code}"))?;
            let keycode = resolve_keycode(keysym).ok_or_else(|| {
                format!("keyboard code is unavailable on this X11 layout: {code}")
            })?;
            Ok(vec![InputAction::Key { keycode, down }])
        }
        ControlEvent::ReleaseAll => Ok(Vec::new()),
    }
}

fn append_wheel_actions(actions: &mut Vec<InputAction>, delta: f64, negative: u8, positive: u8) {
    let ticks = (delta.abs() / 100.0).ceil().clamp(0.0, 10.0) as usize;
    let button = if delta < 0.0 { negative } else { positive };
    for _ in 0..ticks {
        actions.push(InputAction::Button { button, down: true });
        actions.push(InputAction::Button {
            button,
            down: false,
        });
    }
}

fn keysym_for_code(code: &str) -> Option<u32> {
    if let Some(letter) = code.strip_prefix("Key").filter(|value| value.len() == 1) {
        return Some(u32::from(letter.as_bytes()[0].to_ascii_lowercase()));
    }
    if let Some(digit) = code.strip_prefix("Digit").filter(|value| value.len() == 1) {
        return Some(u32::from(digit.as_bytes()[0]));
    }
    if let Some(function) = code
        .strip_prefix('F')
        .and_then(|value| value.parse::<u32>().ok())
        && (1..=12).contains(&function)
    {
        return Some(0xffbd + function);
    }

    Some(match code {
        "Backquote" => b'`'.into(),
        "Minus" => b'-'.into(),
        "Equal" => b'='.into(),
        "BracketLeft" => b'['.into(),
        "BracketRight" => b']'.into(),
        "Backslash" => b'\\'.into(),
        "Semicolon" => b';'.into(),
        "Quote" => b'\''.into(),
        "Comma" => b','.into(),
        "Period" => b'.'.into(),
        "Slash" => b'/'.into(),
        "Space" => 0x20,
        "Backspace" => 0xff08,
        "Tab" => 0xff09,
        "Enter" => 0xff0d,
        "Escape" => 0xff1b,
        "Home" => 0xff50,
        "ArrowLeft" => 0xff51,
        "ArrowUp" => 0xff52,
        "ArrowRight" => 0xff53,
        "ArrowDown" => 0xff54,
        "PageUp" => 0xff55,
        "PageDown" => 0xff56,
        "End" => 0xff57,
        "Insert" => 0xff63,
        "Delete" => 0xffff,
        "ShiftLeft" => 0xffe1,
        "ShiftRight" => 0xffe2,
        "ControlLeft" => 0xffe3,
        "ControlRight" => 0xffe4,
        "CapsLock" => 0xffe5,
        "MetaLeft" => 0xffe7,
        "MetaRight" => 0xffe8,
        "AltLeft" => 0xffe9,
        "AltRight" => 0xffea,
        "Numpad0" => 0xffb0,
        "Numpad1" => 0xffb1,
        "Numpad2" => 0xffb2,
        "Numpad3" => 0xffb3,
        "Numpad4" => 0xffb4,
        "Numpad5" => 0xffb5,
        "Numpad6" => 0xffb6,
        "Numpad7" => 0xffb7,
        "Numpad8" => 0xffb8,
        "Numpad9" => 0xffb9,
        "NumpadMultiply" => 0xffaa,
        "NumpadAdd" => 0xffab,
        "NumpadSubtract" => 0xffad,
        "NumpadDecimal" => 0xffae,
        "NumpadDivide" => 0xffaf,
        "NumpadEnter" => 0xff8d,
        _ => return None,
    })
}

#[derive(Serialize)]
struct PublicConfig {
    capture_mode: CaptureMode,
    audio_mode: AudioMode,
    audio_enabled: bool,
    width: u16,
    height: u16,
    target_fps: u16,
    target_video_bitrate_kbps: u32,
    max_clients: usize,
}

impl PublicConfig {
    fn new(config: &Config, screen: ScreenSize) -> Self {
        Self {
            capture_mode: config.capture_mode,
            audio_mode: config.audio_mode,
            audio_enabled: config.audio_mode != AudioMode::Disabled,
            width: screen.width,
            height: screen.height,
            target_fps: config.fps,
            target_video_bitrate_kbps: config.video_bitrate_kbps,
            max_clients: config.max_clients,
        }
    }
}

#[derive(Serialize)]
struct MetricsResponse {
    uptime_seconds: u64,
    active_clients: usize,
    total_clients: u64,
    bytes_served: u64,
    control_connected: bool,
    encoder: EncoderProgress,
    browser: BrowserTelemetry,
    browser_to_x_input_latency: InputLatency,
    /// Last pointer position the control channel injected.
    last_injected_pointer: Option<(i16, i16)>,
    /// Pointer position the X server currently reports, when reachable.
    x_pointer: Option<(i16, i16)>,
}

struct ClientGuard {
    state: AppState,
    handle: EncoderHandle,
}

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.state.unregister_encoder(self.handle.id);
    }
}

/// Clears the control flag when the session that currently owns control
/// ends; a superseded session must not clear its successor's flag.
struct ControlConnectionGuard {
    connected: Arc<AtomicBool>,
    generation: u64,
    current: watch::Receiver<u64>,
}

impl Drop for ControlConnectionGuard {
    fn drop(&mut self) {
        if *self.current.borrow() == self.generation {
            self.connected.store(false, Ordering::Release);
        }
    }
}

#[tokio::main]
async fn main() {
    if env::args_os()
        .skip(1)
        .any(|argument| argument == "--help" || argument == "-h")
    {
        println!(
            "roomote-desktop-stream\n\nConfiguration is supplied through ROOMOTE_DESKTOP_STREAM_* environment variables."
        );
        return;
    }

    let config = Config::from_env().unwrap_or_else(|error| {
        eprintln!("desktop stream configuration error: {error}");
        std::process::exit(2);
    });
    let address = config.address;
    // A previous service instance may have resized the X screen; capture the
    // real size so encoders and pointer mapping match what is on screen.
    let mut screen = config.initial_screen();
    if config.capture_mode == CaptureMode::X11
        && let Ok(controller) = X11Controller::connect(&config.display, screen.width, screen.height)
        && let Ok(actual) = controller.screen_size()
    {
        screen = actual;
    }
    let state = AppState {
        config: Arc::new(config),
        metrics: Arc::new(Metrics::default()),
        control_connected: Arc::new(AtomicBool::new(false)),
        started_at: Instant::now(),
        screen: Arc::new(RwLock::new(screen)),
        stream_generation: Arc::new(watch::Sender::new(0)),
        encoders: Arc::new(Mutex::new(Vec::new())),
        next_encoder_id: Arc::new(AtomicU64::new(1)),
        control_generation: Arc::new(watch::Sender::new(0)),
    };
    let app = Router::new()
        .route("/", get(player))
        .route("/config", get(public_config))
        .route("/healthz", get(health))
        .route("/metrics", get(metrics))
        .route("/stream.mp4", get(stream))
        .route("/control", get(control))
        .route("/telemetry", post(telemetry))
        .with_state(state);

    let listener = TcpListener::bind(address).await.unwrap_or_else(|error| {
        eprintln!("failed to bind desktop stream on {address}: {error}");
        std::process::exit(1);
    });
    eprintln!("roomote-desktop-stream listening on http://{address}");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .unwrap_or_else(|error| {
            eprintln!("desktop stream server failed: {error}");
            std::process::exit(1);
        });
}

async fn shutdown_signal() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn player() -> impl IntoResponse {
    (
        [
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static(
                    "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src 'self'; connect-src 'self'",
                ),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        Html(PLAYER_HTML),
    )
}

async fn public_config(State(state): State<AppState>) -> Json<PublicConfig> {
    Json(PublicConfig::new(state.config.as_ref(), state.screen()))
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    if !state.config.ffmpeg.is_file() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("ffmpeg is unavailable at {}", state.config.ffmpeg.display()),
        );
    }
    let screen = state.screen();
    if state.config.capture_mode == CaptureMode::X11
        && let Err(error) =
            X11Controller::connect(&state.config.display, screen.width, screen.height)
    {
        return (StatusCode::SERVICE_UNAVAILABLE, error);
    }
    (StatusCode::OK, "ok".into())
}

async fn metrics(State(state): State<AppState>) -> Json<MetricsResponse> {
    Json(MetricsResponse {
        uptime_seconds: state.started_at.elapsed().as_secs(),
        active_clients: state.active_clients(),
        total_clients: state.metrics.total_clients.load(Ordering::Relaxed),
        bytes_served: state.metrics.bytes_served.load(Ordering::Relaxed),
        control_connected: state.control_connected.load(Ordering::Relaxed),
        encoder: state.metrics.progress.lock().unwrap().clone(),
        browser: state.metrics.browser.lock().unwrap().clone(),
        browser_to_x_input_latency: state.metrics.input_latency.lock().unwrap().clone(),
        last_injected_pointer: *state.metrics.last_motion.lock().unwrap(),
        x_pointer: query_x_pointer(&state.config),
    })
}

async fn telemetry(
    State(state): State<AppState>,
    Json(telemetry): Json<BrowserTelemetry>,
) -> StatusCode {
    *state.metrics.browser.lock().unwrap() = telemetry;
    StatusCode::NO_CONTENT
}

async fn control(
    websocket: WebSocketUpgrade,
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Response {
    if !has_allowed_origin(&headers, state.config.allowed_control_origin.as_deref()) {
        return (
            StatusCode::FORBIDDEN,
            "control websocket requires a same-origin request",
        )
            .into_response();
    }
    // The newest viewer wins: bump the generation so any previous control
    // session releases its held input and closes.
    // Subscribe before publishing our generation so a newer client that
    // connects between this point and the upgrade is not missed.
    let superseded = state.control_generation.subscribe();
    let mut generation = 0;
    state.control_generation.send_modify(|current| {
        *current += 1;
        generation = *current;
    });
    state.control_connected.store(true, Ordering::Release);

    websocket
        .max_message_size(4 * 1024)
        .on_upgrade(move |socket| control_socket(socket, state, generation, superseded))
}

async fn control_socket(
    mut socket: WebSocket,
    state: AppState,
    generation: u64,
    mut superseded: watch::Receiver<u64>,
) {
    // Consume our own generation bump; anything newer means a later client
    // already took control while this upgrade was pending.
    if *superseded.borrow_and_update() != generation {
        let _ = socket
            .send(Message::Text(
                "{\"error\":\"another viewer took control of the desktop\"}".into(),
            ))
            .await;
        let _ = socket.send(Message::Close(None)).await;
        return;
    }
    let _connection_guard = ControlConnectionGuard {
        connected: state.control_connected.clone(),
        generation,
        current: state.control_generation.subscribe(),
    };
    let screen = state.screen();
    let mut controller =
        match X11Controller::connect(&state.config.display, screen.width, screen.height) {
            Ok(mut controller) => {
                controller.metrics = Some(state.metrics.clone());
                controller
            }
            Err(error) => {
                let payload = serde_json::json!({ "error": error }).to_string();
                let _ = socket.send(Message::Text(payload.into())).await;
                return;
            }
        };
    let _ = socket.send(Message::Text("{\"ready\":true}".into())).await;

    loop {
        let message = tokio::select! {
            message = socket.next() => match message {
                Some(message) => message,
                None => break,
            },
            _ = superseded.changed() => {
                controller.release_all();
                let _ = socket
                    .send(Message::Text(
                        "{\"error\":\"another viewer took control of the desktop\"}".into(),
                    ))
                    .await;
                let _ = socket.send(Message::Close(None)).await;
                return;
            }
        };
        match message {
            Ok(Message::Text(payload)) => {
                match serde_json::from_str::<ControlEnvelope>(&payload) {
                    Ok(ControlEnvelope {
                        event: ControlEvent::ReleaseAll,
                        sent_at_ms,
                    }) => {
                        controller.release_all();
                        record_input_latency(&state.metrics, sent_at_ms);
                    }
                    Ok(ControlEnvelope {
                        event: ControlEvent::Resize { width, height },
                        ..
                    }) => {
                        let payload = if *superseded.borrow() != generation {
                            serde_json::json!({ "error": "another viewer took control of the desktop" }).to_string()
                        } else {
                            match resize_screen(&state, &mut controller, width, height) {
                                Ok(size) => serde_json::json!({ "resized": size }).to_string(),
                                Err(error) => serde_json::json!({ "error": error }).to_string(),
                            }
                        };
                        let _ = socket.send(Message::Text(payload.into())).await;
                    }
                    Ok(ControlEnvelope { event, sent_at_ms }) => {
                        if let Err(error) = controller.apply(event) {
                            let payload = serde_json::json!({ "error": error }).to_string();
                            let _ = socket.send(Message::Text(payload.into())).await;
                        } else {
                            record_input_latency(&state.metrics, sent_at_ms);
                        }
                    }
                    Err(error) => {
                        let payload = serde_json::json!({ "error": format!("invalid control event: {error}") }).to_string();
                        let _ = socket.send(Message::Text(payload.into())).await;
                    }
                }
            }
            Ok(Message::Close(_)) | Err(_) => break,
            Ok(Message::Binary(_)) => {
                let _ = socket
                    .send(Message::Text(
                        "{\"error\":\"binary control messages are unsupported\"}".into(),
                    ))
                    .await;
            }
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
        }
    }

    controller.release_all();
}

/// Applies a viewer resize: validates the size, resizes the X screen, records
/// the new size for future encoders and control sessions, and ends running
/// encoders so the viewer reconnects at the new size.
fn resize_screen(
    state: &AppState,
    controller: &mut X11Controller,
    width: u16,
    height: u16,
) -> Result<ScreenSize, String> {
    let size = ScreenSize::from_request(width, height)?;
    if size == state.screen() {
        return Ok(size);
    }
    controller.set_screen_size(size)?;
    *state.screen.write().unwrap() = size;
    state
        .stream_generation
        .send_modify(|generation| *generation += 1);
    state.stop_encoders();
    Ok(size)
}

/// Reads the X pointer through a short-lived connection for diagnostics.
fn query_x_pointer(config: &Config) -> Option<(i16, i16)> {
    if config.capture_mode != CaptureMode::X11 {
        return None;
    }
    let screen = ScreenSize {
        width: config.width,
        height: config.height,
    };
    X11Controller::connect(&config.display, screen.width, screen.height)
        .ok()
        .and_then(|controller| controller.pointer_position().ok())
}

fn record_input_latency(metrics: &Metrics, sent_at_ms: Option<u64>) {
    let Some(sent_at_ms) = sent_at_ms else {
        return;
    };
    let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH) else {
        return;
    };
    let latency_ms = now.as_secs_f64() * 1_000.0 - sent_at_ms as f64;
    if (0.0..=10_000.0).contains(&latency_ms) {
        metrics.input_latency.lock().unwrap().record(latency_ms);
    }
}

#[cfg(test)]
fn has_same_origin(headers: &HeaderMap) -> bool {
    has_allowed_origin(headers, None)
}

fn has_allowed_origin(headers: &HeaderMap, explicitly_allowed: Option<&str>) -> bool {
    // The authenticated preview proxy adds this marker only after validating
    // the task-scoped preview token. The browser Origin is the Roomote app,
    // not the separate preview host, so strict host equality cannot apply on
    // this path. The sandbox auth proxy strips the marker on WebSocket
    // upgrades, so the worker also passes the Roomote app origin as the
    // explicitly allowed control origin below.
    if headers.contains_key("x-roomote-forwarded-host") {
        return true;
    }

    let Some(origin) = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<Uri>().ok())
        .and_then(|uri| {
            uri.authority()
                .map(|authority| authority.as_str().to_ascii_lowercase())
        })
    else {
        return false;
    };

    if explicitly_allowed.is_some_and(|allowed| {
        allowed
            .strip_prefix("https://")
            .or_else(|| allowed.strip_prefix("http://"))
            .is_some_and(|authority| authority.eq_ignore_ascii_case(&origin))
    }) {
        return true;
    }

    [
        header::HOST.as_str(),
        "x-forwarded-host",
        "x-roomote-public-host",
    ]
    .into_iter()
    .filter_map(|name| headers.get(name))
    .filter_map(|value| value.to_str().ok())
    .flat_map(|value| value.split(','))
    .any(|value| value.trim().eq_ignore_ascii_case(&origin))
}

async fn stream(State(state): State<AppState>) -> Response {
    state.metrics.total_clients.fetch_add(1, Ordering::Relaxed);

    let mut generation = state.stream_generation.subscribe();
    generation.mark_unchanged();
    let mut command = Command::new(&state.config.ffmpeg);
    command
        .args(state.config.ffmpeg_args(state.screen()))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("failed to start ffmpeg: {error}"),
            )
                .into_response();
        }
    };
    let Some(pid) = child.id() else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "ffmpeg exited before streaming started",
        )
            .into_response();
    };
    // Registering evicts stalled viewers; healthy ones keep their slot.
    let Ok(handle) = state.register_encoder(pid) else {
        let _ = child.start_kill();
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "desktop stream is already being watched by the maximum number of viewers",
        )
            .into_response();
    };
    let progress = handle.last_progress_ms.clone();
    let progress_state = state.clone();
    let guard = ClientGuard {
        state: state.clone(),
        handle,
    };

    let stdout = child.stdout.take().expect("ffmpeg stdout is piped");
    let stderr = child.stderr.take().expect("ffmpeg stderr is piped");
    let progress_metrics = state.metrics.clone();
    tokio::spawn(async move {
        parse_progress(BufReader::new(stderr), progress_metrics).await;
    });

    let stream_metrics = state.metrics.clone();
    let body_stream = async_stream! {
        let _guard = guard;
        let mut chunks = ReaderStream::new(stdout);
        loop {
            tokio::select! {
                chunk = chunks.next() => {
                    match chunk {
                        Some(Ok(chunk)) => {
                            stream_metrics.bytes_served.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                            progress.store(progress_state.now_ms(), Ordering::Relaxed);
                            yield Ok::<_, std::io::Error>(chunk);
                        }
                        Some(Err(error)) => {
                            yield Err(error);
                            break;
                        }
                        None => break,
                    }
                }
                // The screen was resized: this encoder captures at the old
                // size, so stop it and let the viewer reconnect.
                _ = generation.changed() => {
                    let _ = child.start_kill();
                    break;
                }
            }
        }
        let _ = child.wait().await;
    };

    let mut response = Response::new(Body::from_stream(body_stream));
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, no-transform"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn parse_progress<R>(reader: BufReader<R>, metrics: Arc<Metrics>)
where
    R: tokio::io::AsyncRead + Unpin,
{
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let mut progress = metrics.progress.lock().unwrap();
        match key {
            "frame" => progress.frame = value.parse().unwrap_or(progress.frame),
            "fps" => progress.fps = value.parse().unwrap_or(progress.fps),
            "bitrate" => {
                progress.bitrate_kbps = value
                    .strip_suffix("kbits/s")
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(progress.bitrate_kbps)
            }
            "out_time_us" => {
                progress.output_time_ms = value
                    .parse::<u64>()
                    .map(|value| value / 1_000)
                    .unwrap_or(progress.output_time_ms)
            }
            "speed" => {
                progress.speed = value
                    .strip_suffix('x')
                    .and_then(|value| value.parse().ok())
                    .unwrap_or(progress.speed)
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_config() -> Config {
        Config {
            address: SocketAddr::new(IpAddr::V4(std::net::Ipv4Addr::LOCALHOST), 6080),
            ffmpeg: "/usr/bin/ffmpeg".into(),
            capture_mode: CaptureMode::X11,
            audio_mode: AudioMode::Disabled,
            display: ":99.0".into(),
            pulse_source: "roomote_stream.monitor".into(),
            allowed_control_origin: None,
            width: 1920,
            height: 1080,
            fps: 60,
            video_bitrate_kbps: 6_000,
            audio_bitrate_kbps: 128,
            max_clients: 1,
        }
    }

    #[test]
    fn builds_low_latency_x11_video_arguments() {
        let args = test_config().ffmpeg_args(test_config().initial_screen());
        assert!(args.windows(2).any(|pair| pair == ["-f", "x11grab"]));
        assert!(args.windows(2).any(|pair| pair == ["-preset", "ultrafast"]));
        assert!(args.windows(2).any(|pair| pair == ["-threads", "1"]));
        assert!(args.windows(2).any(|pair| pair == ["-tune", "zerolatency"]));
        assert!(
            args.windows(2)
                .any(|pair| pair == ["-frag_duration", "100000"])
        );
        assert!(!args.iter().any(|argument| argument == "-c:a"));
    }

    #[test]
    fn adds_pulse_audio_to_the_same_fragmented_mp4() {
        let mut config = test_config();
        config.audio_mode = AudioMode::Pulse;
        let args = config.ffmpeg_args(config.initial_screen());
        assert!(
            args.windows(3)
                .any(|values| values == ["-f", "pulse", "-i"])
        );
        assert!(args.windows(2).any(|pair| pair == ["-c:a", "aac"]));
        assert!(args.windows(2).any(|pair| pair == ["-map", "1:a:0"]));
    }

    #[test]
    fn synthetic_mode_is_deterministic_for_benchmarks() {
        let mut config = test_config();
        config.capture_mode = CaptureMode::Test;
        config.audio_mode = AudioMode::Test;
        let args = config.ffmpeg_args(config.initial_screen());
        assert!(
            args.iter()
                .any(|argument| argument == "testsrc2=size=1920x1080:rate=60")
        );
        assert!(
            args.iter()
                .any(|argument| argument == "sine=frequency=880:sample_rate=48000")
        );
    }

    #[test]
    fn maps_pointer_buttons_coordinates_and_wheel_with_bounds() {
        let motion = validate_control_event(
            ControlEvent::PointerMove { x: 0.5, y: 1.0 },
            1920,
            1080,
            |_| None,
        )
        .unwrap();
        assert_eq!(motion, vec![InputAction::Motion { x: 960, y: 1079 }]);

        let button = validate_control_event(
            ControlEvent::PointerButton {
                button: 2,
                down: true,
            },
            1920,
            1080,
            |_| None,
        )
        .unwrap();
        assert_eq!(
            button,
            vec![InputAction::Button {
                button: 3,
                down: true
            }]
        );

        let wheel = validate_control_event(
            ControlEvent::Wheel {
                delta_x: 0.0,
                delta_y: -250.0,
            },
            1920,
            1080,
            |_| None,
        )
        .unwrap();
        assert_eq!(wheel.len(), 6);
        assert_eq!(
            wheel[0],
            InputAction::Button {
                button: 4,
                down: true
            }
        );

        assert!(
            validate_control_event(
                ControlEvent::PointerMove { x: -0.1, y: 0.5 },
                1920,
                1080,
                |_| None,
            )
            .is_err()
        );
    }

    #[test]
    fn maps_browser_keyboard_codes_through_the_active_x11_layout() {
        let actions = validate_control_event(
            ControlEvent::Key {
                code: "KeyA".into(),
                down: true,
            },
            1280,
            720,
            |keysym| (keysym == u32::from(b'a')).then_some(38),
        )
        .unwrap();
        assert_eq!(
            actions,
            vec![InputAction::Key {
                keycode: 38,
                down: true
            }]
        );
        assert!(
            validate_control_event(
                ControlEvent::Key {
                    code: "LaunchCalculator".into(),
                    down: true,
                },
                1280,
                720,
                |_| None,
            )
            .is_err()
        );
    }

    #[test]
    fn disconnect_cleanup_releases_every_held_input_once() {
        let mut held = HeldInputs::default();
        held.keys.extend([37, 38]);
        held.buttons.extend([1, 3]);
        let actions = held.drain_release_actions();
        assert_eq!(actions.len(), 4);
        assert!(actions.contains(&InputAction::Key {
            keycode: 37,
            down: false
        }));
        assert!(actions.contains(&InputAction::Button {
            button: 1,
            down: false
        }));
        assert!(held.drain_release_actions().is_empty());
    }

    #[test]
    fn control_websocket_requires_matching_browser_origin() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ORIGIN,
            "https://desktop.preview.test".parse().unwrap(),
        );
        headers.insert(header::HOST, "desktop.preview.test".parse().unwrap());
        assert!(has_same_origin(&headers));

        headers.insert(header::ORIGIN, "https://attacker.test".parse().unwrap());
        assert!(!has_same_origin(&headers));
        headers.remove(header::ORIGIN);
        assert!(!has_same_origin(&headers));

        headers.insert(header::ORIGIN, "http://127.0.0.1:6006".parse().unwrap());
        assert!(has_allowed_origin(&headers, Some("http://127.0.0.1:6006")));

        headers.insert(
            "x-roomote-forwarded-host",
            "task-shared-desktop.preview.test".parse().unwrap(),
        );
        headers.insert(header::ORIGIN, "https://app.roomote.test".parse().unwrap());
        assert!(has_allowed_origin(&headers, None));
    }

    #[test]
    fn screen_size_requests_are_validated_and_snapped_to_even_dimensions() {
        assert_eq!(
            ScreenSize::from_request(1281, 721).unwrap(),
            ScreenSize {
                width: 1280,
                height: 720
            }
        );
        assert!(ScreenSize::from_request(200, 720).is_err());
        assert!(ScreenSize::from_request(1280, 5_000).is_err());
        // Each dimension is in range but the total exceeds the pixel budget.
        assert!(ScreenSize::from_request(4_096, 4_096).is_err());
        assert!(ScreenSize::from_request(1_920, 1_200).is_ok());
        assert_eq!(
            ScreenSize {
                width: 1920,
                height: 1080
            }
            .millimeters(),
            (508, 286)
        );
        let resize: ControlEnvelope =
            serde_json::from_str(r#"{"type":"resize","width":1280,"height":720}"#).unwrap();
        assert!(matches!(
            resize.event,
            ControlEvent::Resize {
                width: 1280,
                height: 720
            }
        ));
    }

    #[test]
    fn control_envelope_accepts_client_timing_without_weakening_event_validation() {
        let envelope: ControlEnvelope =
            serde_json::from_str(r#"{"type":"key","code":"KeyA","down":true,"sent_at_ms":123}"#)
                .unwrap();
        assert_eq!(envelope.sent_at_ms, Some(123));
        assert!(matches!(
            envelope.event,
            ControlEvent::Key {
                code,
                down: true
            } if code == "KeyA"
        ));
        assert!(
            serde_json::from_str::<ControlEnvelope>(
                r#"{"type":"key","code":"KeyA","down":true,"unexpected":1}"#
            )
            .is_err()
        );
    }
}
