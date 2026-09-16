use std::{
    collections::{HashMap, HashSet},
    env,
    net::{IpAddr, SocketAddr},
    path::PathBuf,
    process::Stdio,
    str::FromStr,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
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
};
use tokio_util::io::ReaderStream;
use x11rb::{
    connection::Connection,
    protocol::{
        xproto::{
            BUTTON_PRESS_EVENT, BUTTON_RELEASE_EVENT, ConnectionExt as XprotoConnectionExt,
            KEY_PRESS_EVENT, KEY_RELEASE_EVENT, MOTION_NOTIFY_EVENT, Window,
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
        let max_clients = parse_env("ROOMOTE_DESKTOP_STREAM_MAX_CLIENTS", 1_usize)?;

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

    fn ffmpeg_args(&self) -> Vec<String> {
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
                "-draw_mouse".into(),
                "1".into(),
                "-framerate".into(),
                self.fps.to_string(),
                "-video_size".into(),
                format!("{}x{}", self.width, self.height),
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
                    self.width, self.height, self.fps
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
    active_clients: AtomicUsize,
    total_clients: AtomicU64,
    bytes_served: AtomicU64,
    progress: Mutex<EncoderProgress>,
    browser: Mutex<BrowserTelemetry>,
    input_latency: Mutex<InputLatency>,
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

#[derive(Clone)]
struct AppState {
    config: Arc<Config>,
    metrics: Arc<Metrics>,
    control_connected: Arc<AtomicBool>,
    started_at: Instant,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ControlEvent {
    PointerMove { x: f64, y: f64 },
    PointerButton { button: u8, down: bool },
    Wheel { delta_x: f64, delta_y: f64 },
    Key { code: String, down: bool },
    ReleaseAll,
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
        })
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
            InputAction::Motion { .. } => {}
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

impl From<&Config> for PublicConfig {
    fn from(config: &Config) -> Self {
        Self {
            capture_mode: config.capture_mode,
            audio_mode: config.audio_mode,
            audio_enabled: config.audio_mode != AudioMode::Disabled,
            width: config.width,
            height: config.height,
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
}

struct ClientGuard(Arc<Metrics>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.0.active_clients.fetch_sub(1, Ordering::Relaxed);
    }
}

struct ControlConnectionGuard(Arc<AtomicBool>);

impl Drop for ControlConnectionGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
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
    let state = AppState {
        config: Arc::new(config),
        metrics: Arc::new(Metrics::default()),
        control_connected: Arc::new(AtomicBool::new(false)),
        started_at: Instant::now(),
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
    Json(PublicConfig::from(state.config.as_ref()))
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    if !state.config.ffmpeg.is_file() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            format!("ffmpeg is unavailable at {}", state.config.ffmpeg.display()),
        );
    }
    if state.config.capture_mode == CaptureMode::X11
        && let Err(error) = X11Controller::connect(
            &state.config.display,
            state.config.width,
            state.config.height,
        )
    {
        return (StatusCode::SERVICE_UNAVAILABLE, error);
    }
    (StatusCode::OK, "ok".into())
}

async fn metrics(State(state): State<AppState>) -> Json<MetricsResponse> {
    Json(MetricsResponse {
        uptime_seconds: state.started_at.elapsed().as_secs(),
        active_clients: state.metrics.active_clients.load(Ordering::Relaxed),
        total_clients: state.metrics.total_clients.load(Ordering::Relaxed),
        bytes_served: state.metrics.bytes_served.load(Ordering::Relaxed),
        control_connected: state.control_connected.load(Ordering::Relaxed),
        encoder: state.metrics.progress.lock().unwrap().clone(),
        browser: state.metrics.browser.lock().unwrap().clone(),
        browser_to_x_input_latency: state.metrics.input_latency.lock().unwrap().clone(),
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
    if state
        .control_connected
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Relaxed)
        .is_err()
    {
        return (
            StatusCode::CONFLICT,
            "another remote control client is active",
        )
            .into_response();
    }

    websocket
        .max_message_size(4 * 1024)
        .on_upgrade(move |socket| control_socket(socket, state))
}

async fn control_socket(mut socket: WebSocket, state: AppState) {
    let _connection_guard = ControlConnectionGuard(state.control_connected.clone());
    let mut controller = match X11Controller::connect(
        &state.config.display,
        state.config.width,
        state.config.height,
    ) {
        Ok(controller) => controller,
        Err(error) => {
            let payload = serde_json::json!({ "error": error }).to_string();
            let _ = socket.send(Message::Text(payload.into())).await;
            return;
        }
    };
    let _ = socket.send(Message::Text("{\"ready\":true}".into())).await;

    while let Some(message) = socket.next().await {
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
    let reserved = state.metrics.active_clients.fetch_update(
        Ordering::Relaxed,
        Ordering::Relaxed,
        |clients| (clients < state.config.max_clients).then_some(clients + 1),
    );
    if reserved.is_err() {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            "desktop stream is at capacity",
        )
            .into_response();
    }

    let guard = ClientGuard(state.metrics.clone());
    state.metrics.total_clients.fetch_add(1, Ordering::Relaxed);

    let mut command = Command::new(&state.config.ffmpeg);
    command
        .args(state.config.ffmpeg_args())
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            drop(guard);
            return (
                StatusCode::SERVICE_UNAVAILABLE,
                format!("failed to start ffmpeg: {error}"),
            )
                .into_response();
        }
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
        while let Some(chunk) = chunks.next().await {
            match chunk {
                Ok(chunk) => {
                    stream_metrics.bytes_served.fetch_add(chunk.len() as u64, Ordering::Relaxed);
                    yield Ok::<_, std::io::Error>(chunk);
                }
                Err(error) => {
                    yield Err(error);
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
        let args = test_config().ffmpeg_args();
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
        let args = config.ffmpeg_args();
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
        let args = config.ffmpeg_args();
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
