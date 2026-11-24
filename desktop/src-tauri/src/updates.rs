use serde::Serialize;
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_updater::{Update, UpdaterExt};

#[derive(Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum Phase {
    #[default]
    Idle,
    Checking,
    Current,
    Available,
    Downloading,
    Ready,
    Error,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    phase: Phase,
    version: Option<String>,
    progress: Option<u64>,
    message: Option<String>,
}

#[derive(Default)]
pub struct UpdateState {
    status: UpdateStatus,
    candidate: Option<Update>,
    download: Option<Vec<u8>>,
}

pub type StateLock = Mutex<UpdateState>;

fn notify(app: &AppHandle, state: &UpdateState) {
    let _ = app.emit("update-status", &state.status);
}

#[tauri::command]
pub fn update_status(state: State<'_, StateLock>) -> UpdateStatus {
    state.lock().unwrap().status.clone()
}

pub fn check_on_startup(app: AppHandle) {
    tauri::async_runtime::spawn(async move { check_updates(app).await });
}

#[tauri::command]
pub async fn check_updates(app: AppHandle) {
    let managed = app.state::<StateLock>();
    {
        let mut state = managed.lock().unwrap();
        if matches!(
            state.status.phase,
            Phase::Checking | Phase::Downloading | Phase::Ready
        ) {
            return;
        }
        state.status = UpdateStatus {
            phase: Phase::Checking,
            ..Default::default()
        };
        state.candidate = None;
        notify(&app, &state);
    }
    let result = match app
        .updater_builder()
        .timeout(Duration::from_secs(180))
        .build()
    {
        Ok(updater) => updater.check().await,
        Err(error) => Err(error),
    };
    let mut state = managed.lock().unwrap();
    match result {
        Ok(Some(update)) if update.download_url.scheme() == "https" => {
            state.status.phase = Phase::Available;
            state.status.version = Some(update.version.clone());
            state.candidate = Some(update);
        }
        Ok(None) => state.status.phase = Phase::Current,
        _ => {
            state.status.phase = Phase::Error;
            state.status.message =
                Some("Could not check GitHub Releases for updates. Try again in a moment.".into());
        }
    }
    notify(&app, &state);
}

#[tauri::command]
pub async fn download_update(app: AppHandle) -> Result<(), String> {
    let managed = app.state::<StateLock>();
    let update = {
        let mut state = managed.lock().unwrap();
        if state.status.phase != Phase::Available {
            return Err("Check for an available update first.".into());
        }
        let update = state
            .candidate
            .take()
            .ok_or("Check for an available update first.")?;
        state.status.phase = Phase::Downloading;
        state.status.message = None;
        notify(&app, &state);
        update
    };
    let mut received = 0_u64;
    let result = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                if let Some(total) = total.filter(|total| *total > 0) {
                    let progress = (received * 100 / total).min(100);
                    let mut state = managed.lock().unwrap();
                    if state.status.progress != Some(progress) {
                        state.status.progress = Some(progress);
                        notify(&app, &state);
                    }
                }
            },
            || {},
        )
        .await;
    let mut state = managed.lock().unwrap();
    state.candidate = Some(update);
    match result {
        Ok(bytes) => {
            state.download = Some(bytes);
            state.status.phase = Phase::Ready;
        }
        Err(_) => {
            state.status.phase = Phase::Available;
            state.status.message = Some("The update download or signature check failed. You can retry or download it from Releases.".into());
        }
    }
    notify(&app, &state);
    Ok(())
}

#[tauri::command]
pub fn cancel_update(app: AppHandle, managed: State<'_, StateLock>) {
    let mut state = managed.lock().unwrap();
    if state.status.phase == Phase::Ready {
        state.download = None;
        state.status.phase = Phase::Available;
        notify(&app, &state);
    }
}

pub fn install_on_exit(app: &AppHandle) -> Result<(), String> {
    let managed = app.state::<StateLock>();
    let (update, bytes) = {
        let mut state = managed.lock().unwrap();
        let Some(bytes) = state.download.take() else {
            return Ok(());
        };
        let update = state
            .candidate
            .take()
            .ok_or("Check for the update again.")?;
        (update, bytes)
    };
    #[cfg(not(windows))]
    let result = update.install(&bytes).map_err(|error| error.to_string());
    #[cfg(windows)]
    let result = update
        .verify(&bytes)
        .map_err(|error| error.to_string())
        .and_then(|()| {
            stage_portable_update(&bytes, &update.signature).map_err(|error| error.to_string())
        });
    if let Err(error) = result {
        let mut state = managed.lock().unwrap();
        state.status.phase = Phase::Available;
        state.status.message = Some("The app could not install the update. Check that the app's location is writable or download it from Releases.".into());
        state.candidate = Some(update);
        notify(app, &state);
        return Err(error);
    }
    Ok(())
}

#[cfg(windows)]
const UPDATE_PREFIX: &str = ".taildesk-update-";
#[cfg(windows)]
const UPDATE_HELPER: &str = "taildesk-update-helper.exe";
#[cfg(windows)]
const UPDATE_PAYLOAD: &str = "verified-update.exe";
#[cfg(windows)]
const UPDATE_SIGNATURE: &str = "verified-update.sig";

#[cfg(windows)]
fn stage_portable_update(bytes: &[u8], signature: &str) -> std::io::Result<()> {
    use std::{fs, io::Write, os::windows::process::CommandExt, process::Command};
    let current = std::env::current_exe()?;
    let folder = tempfile::Builder::new()
        .prefix(UPDATE_PREFIX)
        .tempdir_in(current.parent().unwrap())?;
    let helper = folder.path().join(UPDATE_HELPER);
    let mut payload = fs::File::create(folder.path().join(UPDATE_PAYLOAD))?;
    payload.write_all(bytes)?;
    payload.sync_all()?;
    fs::write(folder.path().join(UPDATE_SIGNATURE), signature)?;
    fs::copy(&current, &helper)?;
    Command::new(helper)
        .arg("--complete-portable-update")
        .arg(current.file_name().unwrap())
        .creation_flags(0x08000000)
        .spawn()?;
    let _ = folder.keep();
    Ok(())
}

#[cfg(windows)]
fn verify_portable_payload(folder: &std::path::Path) -> Option<()> {
    use base64::{engine::general_purpose::STANDARD, Engine};
    use minisign_verify::{PublicKey, Signature};
    use std::{fs, io::Read};

    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).ok()?;
    let key = config["plugins"]["updater"]["pubkey"].as_str()?;
    let key = String::from_utf8(STANDARD.decode(key).ok()?).ok()?;
    let key = PublicKey::decode(&key).ok()?;
    let signature = fs::read(folder.join(UPDATE_SIGNATURE)).ok()?;
    let signature = String::from_utf8(STANDARD.decode(signature).ok()?).ok()?;
    let signature = Signature::decode(&signature).ok()?;
    let mut verifier = key.verify_stream(&signature).ok()?;
    let mut file = fs::File::open(folder.join(UPDATE_PAYLOAD)).ok()?;
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).ok()?;
        if count == 0 {
            break;
        }
        verifier.update(&buffer[..count]);
    }
    verifier.finalize().ok()
}

#[cfg(windows)]
pub fn run_portable_helper() -> Option<i32> {
    use std::{
        ffi::OsStr,
        fs,
        path::{Component, Path},
        thread,
    };
    let mut args = std::env::args_os().skip(1);
    if args.next().as_deref() != Some(OsStr::new("--complete-portable-update")) {
        return None;
    }
    let mut install = || {
        let target = args.next()?;
        let mut components = Path::new(&target).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return None;
        }
        let helper = std::env::current_exe().ok()?;
        let folder = helper.parent()?;
        if helper.file_name()? != UPDATE_HELPER
            || !folder
                .file_name()?
                .to_string_lossy()
                .starts_with(UPDATE_PREFIX)
        {
            return None;
        }
        let destination = folder.parent()?.join(target);
        let payload = folder.join(UPDATE_PAYLOAD);
        let result = verify_portable_payload(folder).is_some()
            && (0..100).any(|_| {
                if fs::rename(&payload, &destination).is_ok() {
                    return true;
                }
                thread::sleep(Duration::from_millis(100));
                false
            });
        let _ = fs::write(
            folder.join("finished"),
            if result { "installed" } else { "failed" },
        );
        Some(if result { 0 } else { 1 })
    };
    Some(install().unwrap_or(1))
}

#[cfg(windows)]
pub fn clean_portable_helpers() -> Option<&'static str> {
    use std::fs;
    let executable = std::env::current_exe().ok()?;
    let mut failed = false;
    for entry in fs::read_dir(executable.parent()?).ok()?.flatten() {
        if !entry
            .file_name()
            .to_string_lossy()
            .starts_with(UPDATE_PREFIX)
            || !entry.file_type().is_ok_and(|kind| kind.is_dir())
        {
            continue;
        }
        let folder = entry.path();
        let Ok(outcome) = fs::read_to_string(folder.join("finished")) else {
            continue;
        };
        failed |= outcome == "failed";
        for file in [UPDATE_HELPER, UPDATE_PAYLOAD, UPDATE_SIGNATURE, "finished"] {
            let _ = fs::remove_file(folder.join(file));
        }
        let _ = fs::remove_dir(folder);
    }
    failed.then_some(
        "The last portable update could not replace the app. Check that its folder is writable.",
    )
}
