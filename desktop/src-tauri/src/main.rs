#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runtime;
mod settings;
mod updates;

use serde::{Deserialize, Serialize};
use settings::{Settings, Tunnel};
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{ChildStdin, Command, Stdio},
    sync::{LazyLock, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, State, WebviewWindow, WindowEvent,
};
use tauri_plugin_clipboard_manager::ClipboardExt;

const TAILSCALE_DOWNLOAD: &str = "https://tailscale.com/download";
const TAILSCALE_FUNNEL: &str = "https://tailscale.com/docs/features/tailscale-funnel#enable-funnel";
const CHATGPT_PLUGINS: &str = "https://chatgpt.com/plugins";
const GEMINI: &str = "https://gemini.google.com/";
const CLOUDFLARED: &str = "https://developers.cloudflare.com/tunnel/downloads/";
const RELEASES: &str = "https://github.com/j1seki/TailDeskCommanderMCP/releases/latest";
const MAX_ACTIVITY: usize = 300;

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Check {
    #[default]
    Waiting,
    Passed,
    Failed,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Client {
    Chatgpt,
    Gemini,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostics {
    https: Check,
    chatgpt_oauth: Check,
    chatgpt_mcp: Check,
    gemini_oauth: Check,
    gemini_mcp: Check,
}

#[derive(Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    #[default]
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    phase: Phase,
    tailscale_installed: bool,
    cloudflared_installed: bool,
    version: String,
    active_tunnel: Option<Tunnel>,
    diagnostics: Diagnostics,
    can_hide: bool,
    url: Option<String>,
    client_id: Option<String>,
    gemini_client_id: Option<String>,
    setup_url: Option<String>,
    message: Option<String>,
    settings: Settings,
    started_at: Option<u64>,
}

#[derive(Default)]
struct Gateway {
    snapshot: Snapshot,
    credentials_path: Option<PathBuf>,
    gemini_credentials_path: Option<PathBuf>,
    child_input: Option<ChildStdin>,
    quitting: bool,
    activity: VecDeque<Activity>,
    next_activity_id: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Activity {
    id: u64,
    timestamp: u64,
    level: String,
    source: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum GatewayEvent {
    Gateway {
        url: String,
        credentials_path: PathBuf,
        client_id: String,
        gemini_credentials_path: PathBuf,
        gemini_client_id: String,
    },
    Ready,
    Enable {
        setup_url: String,
    },
    Error {
        message: String,
    },
    Diagnostic {
        component: String,
        status: Check,
        provider: Option<Client>,
    },
    Log {
        level: String,
        source: String,
        message: String,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Credentials {
    client_secret: String,
    login_password: String,
}

type GatewayState = Mutex<Gateway>;

fn notify(app: &AppHandle, state: &Gateway) {
    let _ = app.emit("gateway-state", &state.snapshot);
}

fn timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn record(
    app: &AppHandle,
    state: &mut Gateway,
    level: &str,
    source: &str,
    message: impl Into<String>,
) {
    state.next_activity_id += 1;
    if state.activity.len() >= MAX_ACTIVITY {
        state.activity.pop_front();
    }
    let entry = Activity {
        id: state.next_activity_id,
        timestamp: timestamp(),
        level: level.into(),
        source: source.into(),
        message: message.into(),
    };
    let _ = app.emit("gateway-activity", &entry);
    state.activity.push_back(entry);
}

fn find_tailscale() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    for dir in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        if let Some(path) = std::env::var_os(dir) {
            let file = PathBuf::from(path).join("Tailscale").join("tailscale.exe");
            if file.is_file() {
                return Some(file);
            }
        }
    }
    #[cfg(target_os = "macos")]
    for location in [
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    ] {
        let file = PathBuf::from(location);
        if file.is_file() {
            return Some(file);
        }
    }
    which::which("tailscale").ok()
}

fn find_cloudflared() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    for path in [
        "/usr/local/bin/cloudflared",
        "/opt/homebrew/bin/cloudflared",
    ] {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    which::which("cloudflared").ok()
}

fn worker(app: &AppHandle, tunnel: PathBuf, settings: Settings) -> Result<(), String> {
    let runtime = runtime::prepare(app)?;
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let mut command = Command::new(runtime.join(executable));
    command
        .current_dir(&runtime)
        .arg(runtime.join("scripts").join("chatgpt-mcp.mjs"))
        .arg("--desktop")
        .env("TAILSCALE_BE_CLI", "1")
        .env_remove("NODE_OPTIONS")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    match settings.tunnel {
        Tunnel::Tailscale => command
            .env("DC_MCP_TUNNEL", "tailscale")
            .env("DC_CHATGPT_TAILSCALE", tunnel),
        Tunnel::Cloudflare => command
            .env("DC_MCP_TUNNEL", "cloudflare")
            .env("DC_MCP_CLOUDFLARED", tunnel),
    };
    if let Some(port) = settings.funnel_port {
        command.env("DC_CHATGPT_FUNNEL_PORT", port.to_string());
    } else {
        command.env_remove("DC_CHATGPT_FUNNEL_PORT");
    }
    if settings.callback_uri.is_empty() {
        command.env_remove("DC_CHATGPT_REDIRECT_URI");
    } else {
        command.env("DC_CHATGPT_REDIRECT_URI", settings.callback_uri);
    }
    #[cfg(windows)]
    std::os::windows::process::CommandExt::creation_flags(&mut command, 0x08000000); // CREATE_NO_WINDOW

    let managed = app.state::<GatewayState>();
    let mut child = {
        let mut state = managed.lock().unwrap();
        if state.snapshot.phase == Phase::Stopping {
            return Ok(());
        }
        record(
            app,
            &mut state,
            "info",
            "App",
            "Bundled runtime ready. Starting the MCP gateway.",
        );
        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start the bundled server: {e}"))?;
        state.child_input = child.stdin.take();
        child
    };
    let output = child.stdout.take().unwrap();
    let events_app = app.clone();
    let events = thread::spawn(move || {
        let managed = events_app.state::<GatewayState>();
        for line in BufReader::new(output).lines().map_while(Result::ok) {
            let Ok(event) = serde_json::from_str::<GatewayEvent>(&line) else {
                continue;
            };
            let mut state = managed.lock().unwrap();
            if state.snapshot.phase == Phase::Stopping {
                continue;
            }
            match event {
                GatewayEvent::Gateway {
                    url,
                    credentials_path,
                    client_id,
                    gemini_credentials_path,
                    gemini_client_id,
                } => {
                    state.snapshot.url = Some(url);
                    state.snapshot.client_id = Some(client_id);
                    state.snapshot.gemini_client_id = Some(gemini_client_id);
                    state.credentials_path = Some(credentials_path);
                    state.gemini_credentials_path = Some(gemini_credentials_path);
                }
                GatewayEvent::Ready => {
                    state.snapshot.phase = Phase::Running;
                    state.snapshot.started_at = Some(timestamp());
                    state.snapshot.setup_url = None;
                    state.snapshot.message = None;
                    record(
                        &events_app,
                        &mut state,
                        "info",
                        "Tunnel",
                        "The public HTTPS route is active.",
                    );
                }
                GatewayEvent::Enable { setup_url } => {
                    state.snapshot.setup_url = Some(setup_url);
                    record(
                        &events_app,
                        &mut state,
                        "warning",
                        "Funnel",
                        "Tailscale is waiting for browser approval.",
                    );
                }
                GatewayEvent::Error { message } => state.snapshot.message = Some(message),
                GatewayEvent::Diagnostic {
                    component,
                    status,
                    provider,
                } => {
                    let diagnostics = &mut state.snapshot.diagnostics;
                    match (component.as_str(), provider) {
                        ("https", None) => diagnostics.https = status,
                        ("oauth", Some(Client::Chatgpt)) => diagnostics.chatgpt_oauth = status,
                        ("oauth", Some(Client::Gemini)) => diagnostics.gemini_oauth = status,
                        ("mcp", Some(Client::Chatgpt)) => diagnostics.chatgpt_mcp = status,
                        ("mcp", Some(Client::Gemini)) => diagnostics.gemini_mcp = status,
                        _ => continue,
                    }
                }
                GatewayEvent::Log {
                    level,
                    source,
                    message,
                } => {
                    record(&events_app, &mut state, &level, &source, message);
                    continue;
                }
            }
            notify(&events_app, &state);
        }
    });

    let mut stopping_since = None;
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if managed.lock().unwrap().snapshot.phase == Phase::Stopping {
            let started = stopping_since.get_or_insert_with(Instant::now);
            if started.elapsed() > Duration::from_secs(18) {
                let _ = child.kill();
            }
        }
        thread::sleep(Duration::from_millis(120));
    };
    let _ = events.join();
    if status.success() {
        Ok(())
    } else {
        Err(format!("The gateway exited with {status}."))
    }
}

#[tauri::command]
fn gateway_state(app: AppHandle, managed: State<'_, GatewayState>) -> Snapshot {
    let mut state = managed.lock().unwrap();
    state.snapshot.tailscale_installed = find_tailscale().is_some();
    state.snapshot.cloudflared_installed = find_cloudflared().is_some();
    notify(&app, &state);
    state.snapshot.clone()
}

#[tauri::command]
fn start_gateway(app: AppHandle, managed: State<'_, GatewayState>) -> Result<(), String> {
    let mut state = managed.lock().unwrap();
    if !matches!(state.snapshot.phase, Phase::Stopped | Phase::Error) || state.quitting {
        return Ok(());
    }
    let settings = state.snapshot.settings.clone();
    let tunnel = match settings.tunnel {
        Tunnel::Tailscale => {
            find_tailscale().ok_or("Install Tailscale and sign in on this computer first.")?
        }
        Tunnel::Cloudflare => find_cloudflared()
            .ok_or("Install cloudflared and put it on PATH, then reopen the app.")?,
    };
    state.snapshot.phase = Phase::Starting;
    state.snapshot.active_tunnel = Some(settings.tunnel);
    state.snapshot.diagnostics = Diagnostics::default();
    state.snapshot.message = None;
    state.snapshot.setup_url = None;
    state.snapshot.url = None;
    state.snapshot.client_id = None;
    state.snapshot.gemini_client_id = None;
    state.credentials_path = None;
    state.gemini_credentials_path = None;
    record(
        &app,
        &mut state,
        "info",
        "App",
        "Preparing the bundled runtime.",
    );
    notify(&app, &state);
    drop(state);

    thread::spawn(move || {
        let result = worker(&app, tunnel, settings);
        let managed = app.state::<GatewayState>();
        let mut state = managed.lock().unwrap();
        let stopping = state.snapshot.phase == Phase::Stopping;
        let quitting = state.quitting;
        state.child_input.take();
        state.snapshot.phase = Phase::Stopped;
        state.snapshot.started_at = None;
        if stopping {
            state.snapshot.message = None;
            state.snapshot.setup_url = None;
            record(&app, &mut state, "info", "App", "Connection stopped.");
        } else if let Err(error) = result {
            state.snapshot.phase = Phase::Error;
            let detail = state.snapshot.message.get_or_insert(error).clone();
            record(&app, &mut state, "error", "App", detail);
        }
        notify(&app, &state);
        drop(state);
        if quitting {
            finish_exit(&app);
        }
    });
    Ok(())
}

fn finish_exit(app: &AppHandle) {
    let app = app.clone();
    thread::spawn(move || {
        if let Err(error) = updates::install_on_exit(&app) {
            let managed = app.state::<GatewayState>();
            let mut state = managed.lock().unwrap();
            state.quitting = false;
            record(
                &app,
                &mut state,
                "error",
                "Updates",
                format!("Update installation failed. {error}"),
            );
            notify(&app, &state);
            drop(state);
            show_window(&app);
            return;
        }
        app.exit(0);
    });
}

fn stop(app: &AppHandle, quitting: bool) {
    let managed = app.state::<GatewayState>();
    let mut state = managed.lock().unwrap();
    if state.quitting {
        return;
    }
    state.quitting |= quitting;
    if matches!(
        state.snapshot.phase,
        Phase::Starting | Phase::Running | Phase::Stopping
    ) {
        state.snapshot.phase = Phase::Stopping;
        if state.child_input.is_some() {
            record(
                app,
                &mut state,
                "info",
                "App",
                "Stopping the connection and closing the tunnel.",
            );
        }
        state.child_input.take();
        notify(app, &state);
    } else if quitting {
        drop(state);
        finish_exit(app);
    }
}

#[tauri::command]
fn stop_gateway(app: AppHandle) {
    stop(&app, false);
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    stop(&app, true);
}

#[tauri::command]
fn revoke_client(managed: State<'_, GatewayState>, provider: Client) -> Result<(), String> {
    let mut state = managed.lock().unwrap();
    if state.snapshot.phase != Phase::Running {
        return Err("Start the connection before revoking access.".into());
    }
    let child = state
        .child_input
        .as_mut()
        .ok_or("The connection is closing.")?;
    let message = serde_json::json!({ "action": "revoke", "provider": provider });
    writeln!(child, "{message}").map_err(|_| "Could not reach the gateway.".into())
}

#[tauri::command]
fn update_settings(
    app: AppHandle,
    managed: State<'_, GatewayState>,
    settings: Settings,
) -> Result<Settings, String> {
    let folder = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    let mut state = managed.lock().unwrap();
    let saved = settings.save(&folder)?;
    state.snapshot.settings = saved.clone();
    record(&app, &mut state, "info", "App", "Settings saved.");
    notify(&app, &state);
    Ok(saved)
}

#[tauri::command]
fn gateway_activity(managed: State<'_, GatewayState>) -> Vec<Activity> {
    managed.lock().unwrap().activity.iter().cloned().collect()
}

#[tauri::command]
fn clear_activity(app: AppHandle, managed: State<'_, GatewayState>) {
    let mut state = managed.lock().unwrap();
    state.activity.clear();
    let _ = app.emit("gateway-activity-cleared", state.next_activity_id);
}

#[tauri::command]
fn copy_value(app: AppHandle, managed: State<'_, GatewayState>, field: &str) -> Result<(), String> {
    let state = managed.lock().unwrap();
    let value = match field {
        "url" => state.snapshot.url.clone(),
        "clientId" => state.snapshot.client_id.clone(),
        "geminiClientId" => state.snapshot.gemini_client_id.clone(),
        "activity" => Some(
            state
                .activity
                .iter()
                .map(|entry| {
                    let date = time::OffsetDateTime::from_unix_timestamp_nanos(
                        i128::from(entry.timestamp) * 1_000_000,
                    )
                    .ok()
                    .and_then(|date| {
                        date.format(&time::format_description::well_known::Rfc3339)
                            .ok()
                    })
                    .unwrap_or_default();
                    let message = redact_activity(&entry.message);
                    format!("{date} [{}] {}: {}", entry.level, entry.source, message)
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        "operator" if cfg!(target_os = "linux") => {
            Some("sudo tailscale set --operator=\"$USER\"".into())
        }
        "clientSecret" | "loginPassword" | "geminiClientSecret" | "geminiLoginPassword" => {
            let path = if field.starts_with("gemini") {
                &state.gemini_credentials_path
            } else {
                &state.credentials_path
            }
            .as_ref()
            .ok_or("Start the connection first.")?;
            let content = fs::read(path).map_err(|_| "Could not read the local credentials.")?;
            let credentials: Credentials = serde_json::from_slice(&content)
                .map_err(|_| "Could not read the local credentials.")?;
            Some(if matches!(field, "clientSecret" | "geminiClientSecret") {
                credentials.client_secret
            } else {
                credentials.login_password
            })
        }
        _ => None,
    };
    let value = value.ok_or("Start the connection first.")?;
    app.clipboard().write_text(value).map_err(|e| e.to_string())
}

fn redact_activity(message: &str) -> String {
    static PRIVATE: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(
        r#"(?i)https?://[^\s<>\"']+|(?:[a-z0-9-]+\.)+(?:ts\.net|trycloudflare\.com)\b|\b[a-z0-9_-]{32,}(?:\.[a-z0-9_-]+)*\b"#,
    ).unwrap()
    });
    PRIVATE.replace_all(message, "[redacted]").into_owned()
}

#[cfg(test)]
#[test]
fn redacts_urls_tunnel_hosts_and_credential_shaped_values() {
    let message = "https://demo.example.ts.net/mcp on temporary.trycloudflare.com uses P9gRnCH70ROwNN7CL5D6Qw1IkX98YS77lc9nUvbnvjg";
    assert_eq!(
        redact_activity(message),
        "[redacted] on [redacted] uses [redacted]"
    );
}

#[tauri::command]
fn open_link(managed: State<'_, GatewayState>, link: &str) -> Result<(), String> {
    let state = managed.lock().unwrap();
    let url = match link {
        "tailscale" => TAILSCALE_DOWNLOAD,
        "funnel" => TAILSCALE_FUNNEL,
        "chatgpt" => CHATGPT_PLUGINS,
        "gemini" => GEMINI,
        "cloudflared" => CLOUDFLARED,
        "releases" => RELEASES,
        "enable" => state
            .snapshot
            .setup_url
            .as_deref()
            .filter(|url| url.starts_with("https://login.tailscale.com/"))
            .ok_or("Tailscale has not provided a setup link.")?,
        _ => return Err("Unknown link.".into()),
    };
    let launcher = if cfg!(windows) {
        "explorer.exe"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    Command::new(launcher)
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_window(window: WebviewWindow, managed: State<'_, GatewayState>) -> Result<(), String> {
    if managed.lock().unwrap().snapshot.can_hide {
        window.hide()
    } else {
        window.minimize()
    }
    .map_err(|e| e.to_string())
}

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn main() {
    #[cfg(windows)]
    if let Some(code) = updates::run_portable_helper() {
        std::process::exit(code);
    }
    tauri::Builder::default()
        .manage(GatewayState::default())
        .manage(updates::StateLock::default())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            gateway_state,
            start_gateway,
            stop_gateway,
            quit_app,
            revoke_client,
            update_settings,
            gateway_activity,
            clear_activity,
            copy_value,
            open_link,
            hide_window,
            updates::update_status,
            updates::check_updates,
            updates::download_update,
            updates::cancel_update
        ])
        .setup(|app| {
            let show =
                MenuItem::with_id(app, "show", "Open Desktop Commander", true, None::<&str>)?;
            let stop_item = MenuItem::with_id(app, "stop", "Stop connection", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &stop_item, &quit])?;
            let tray = TrayIconBuilder::with_id("desktop-commander")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Desktop Commander Connect")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_window(app),
                    "stop" => stop(app, false),
                    "quit" => stop(app, true),
                    _ => (),
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app);
            let managed = app.state::<GatewayState>();
            let mut state = managed.lock().unwrap();
            state.snapshot.can_hide = tray.is_ok();
            state.snapshot.tailscale_installed = find_tailscale().is_some();
            state.snapshot.cloudflared_installed = find_cloudflared().is_some();
            state.snapshot.version = app.package_info().version.to_string();
            match app
                .path()
                .app_config_dir()
                .map_err(|e| e.to_string())
                .and_then(|dir| Settings::load(&dir))
            {
                Ok(settings) => state.snapshot.settings = settings,
                Err(error) => record(
                    app.handle(),
                    &mut state,
                    "warning",
                    "App",
                    format!("Saved settings could not be loaded. Using defaults. {error}"),
                ),
            }
            #[cfg(windows)]
            if let Some(message) = updates::clean_portable_helpers() {
                record(app.handle(), &mut state, "warning", "Updates", message);
            }
            if state.snapshot.settings.auto_check_updates {
                updates::check_on_startup(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let managed = window.app_handle().state::<GatewayState>();
                let state = managed.lock().unwrap();
                let hide = state.snapshot.can_hide && state.snapshot.settings.close_to_tray;
                drop(state);
                api.prevent_close();
                if hide {
                    let _ = window.hide();
                } else {
                    stop(window.app_handle(), true);
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("could not initialize Desktop Commander Connect")
        .run(|app, event| {
            if let RunEvent::ExitRequested {
                api, code: None, ..
            } = event
            {
                api.prevent_exit();
                stop(app, true);
            }
        });
}
