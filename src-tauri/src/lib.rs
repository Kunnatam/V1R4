use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, WindowEvent};

// ── Window State Persistence ──────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug)]
struct WindowState {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn config_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".config").join("claude-voice").join("avatar.json"))
}

fn load_window_state() -> Option<WindowState> {
    let path = config_path()?;
    let data = fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn save_window_state(state: &WindowState) {
    if let Some(path) = config_path() {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(path, serde_json::to_string_pretty(state).unwrap_or_default());
    }
}

fn capture_window_state(window: &tauri::Window) -> Option<WindowState> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Some(WindowState {
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    })
}

fn capture_webview_window_state(window: &tauri::WebviewWindow) -> Option<WindowState> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Some(WindowState {
        x: pos.x as f64 / scale,
        y: pos.y as f64 / scale,
        width: size.width as f64 / scale,
        height: size.height as f64 / scale,
    })
}

// ── Toggle State (shared between JS and Rust) ────────────────────────

struct ToggleState {
    waveform: bool,
    subtitles: bool,
    muted: bool,
    voice: String,
    voice_cue_mode: String,
}

// ── Tauri Commands ────────────────────────────────────────────────────

/// Returns the global keystroke counter (macOS only).
/// The frontend tracks deltas to detect typing activity.
/// On Windows/Linux, returns 0 (no typing reactions — would require
/// a low-level keyboard hook for equivalent functionality).
#[tauri::command]
fn get_keystroke_count() -> u32 {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn CGEventSourceCounterForEventType(stateID: u32, eventType: u32) -> u32;
        }
        // stateID 0 = kCGEventSourceStateCombinedSessionState
        // eventType 10 = kCGEventKeyDown
        unsafe { CGEventSourceCounterForEventType(0, 10) }
    }

    #[cfg(not(target_os = "macos"))]
    { 0 }
}

/// Normalize a screen cursor position relative to overlay window center → (-1..1, -1..1)
fn normalize_cursor(app: &AppHandle, cursor_x: f64, cursor_y: f64) -> Option<(f64, f64)> {
    let window = app.get_webview_window("overlay")?;
    let win_pos = window.outer_position().ok()?;
    let win_size = window.outer_size().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0);

    let center_x = win_pos.x as f64 / scale + win_size.width as f64 / scale / 2.0;
    let center_y = win_pos.y as f64 / scale + win_size.height as f64 / scale / 2.0;

    let range = 500.0;
    let norm_x = ((cursor_x - center_x) / range).clamp(-1.0, 1.0);
    let norm_y = ((cursor_y - center_y) / range).clamp(-1.0, 1.0);
    Some((norm_x, norm_y))
}

/// Returns global cursor position relative to the overlay window center, normalized to -1..1.
#[tauri::command]
fn get_cursor_position(app: AppHandle) -> Option<(f64, f64)> {
    #[cfg(target_os = "macos")]
    {
        use core_graphics::event::CGEvent;
        use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
        let event = CGEvent::new(source).ok()?;
        let cursor = event.location();
        return normalize_cursor(&app, cursor.x, cursor.y);
    }

    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::WindowsAndMessaging::GetCursorPos;
        use windows::Win32::Foundation::POINT;
        let mut point = POINT::default();
        unsafe { let _ = GetCursorPos(&mut point); }
        return normalize_cursor(&app, point.x as f64, point.y as f64);
    }

    #[cfg(target_os = "linux")]
    {
        use x11rb::connection::Connection;
        use x11rb::protocol::xproto::ConnectionExt;
        // On Wayland-only systems, x11rb::connect fails and we return None
        // (avatar eyes stay centered — intentional graceful degradation)
        if let Ok((conn, screen_num)) = x11rb::connect(None) {
            let setup = conn.setup();
            let root = setup.roots[screen_num].root;
            if let Ok(reply) = conn.query_pointer(root) {
                if let Ok(pointer) = reply.reply() {
                    return normalize_cursor(&app, pointer.root_x as f64, pointer.root_y as f64);
                }
            }
        }
        return None;
    }

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    { None }
}

#[tauri::command]
fn set_toggle_state(app: AppHandle, waveform: bool, subtitles: bool) {
    if let Some(state) = app.try_state::<Mutex<ToggleState>>() {
        if let Ok(mut ts) = state.lock() {
            ts.waveform = waveform;
            ts.subtitles = subtitles;
        }
    }
}

/// Returns normalized direction from avatar window center to screen center (-1..1, -1..1).
/// Used to make gaze and lean point toward the user, not just the camera.
#[tauri::command]
fn get_viewer_direction(app: AppHandle) -> Option<(f64, f64)> {
    let window = app.get_webview_window("overlay")?;
    let win_pos = window.outer_position().ok()?;
    let win_size = window.outer_size().ok()?;
    let scale = window.scale_factor().unwrap_or(1.0);

    let monitor = window.current_monitor().ok()??;
    let mon_size = monitor.size();
    let mon_pos = monitor.position();

    // Window center (logical pixels)
    let win_cx = win_pos.x as f64 / scale + win_size.width as f64 / scale / 2.0;
    let win_cy = win_pos.y as f64 / scale + win_size.height as f64 / scale / 2.0;

    // Screen center (logical pixels)
    let screen_cx = mon_pos.x as f64 / scale + mon_size.width as f64 / scale / 2.0;
    let screen_cy = mon_pos.y as f64 / scale + mon_size.height as f64 / scale / 2.0;

    // Normalize by screen half-size
    let half_w = mon_size.width as f64 / scale / 2.0;
    let half_h = mon_size.height as f64 / scale / 2.0;

    let dx = ((screen_cx - win_cx) / half_w).clamp(-1.0, 1.0);
    let dy = ((screen_cy - win_cy) / half_h).clamp(-1.0, 1.0);

    Some((dx, dy))
}

#[tauri::command]
fn show_context_menu(app: AppHandle) {
    if let Some(window) = app.get_webview_window("overlay") {
        // Read toggle state for menu labels
        let (wf, st, muted, active_voice, cue_mode) = if let Some(state) = app.try_state::<Mutex<ToggleState>>() {
            if let Ok(ts) = state.lock() {
                (ts.waveform, ts.subtitles, ts.muted, ts.voice.clone(), ts.voice_cue_mode.clone())
            } else {
                (true, true, false, "af_heart".to_string(), "30s".to_string())
            }
        } else {
            (true, true, false, "af_heart".to_string(), "30s".to_string())
        };

        let wf_label = if wf { "✓ Waveform" } else { "  Waveform" };
        let st_label = if st { "✓ Subtitles" } else { "  Subtitles" };
        let mute_label = if muted { "Unmute" } else { "Mute" };

        let voice_label = |id: &str, name: &str| -> String {
            if active_voice == id { format!("✓ {}", name) } else { format!("  {}", name) }
        };

        let Ok(mood_sub) = SubmenuBuilder::new(&app, "Mood")
            .text("mood_success", "Happy")
            .text("mood_error", "Angry")
            .text("mood_melancholy", "Sad")
            .text("mood_warn", "Surprised")
            .text("mood_focused", "Focused")
            .text("mood_skeptical", "Skeptical")
            .text("mood_smirk", "Smirk")
            .text("mood_dramatic", "Dramatic")
            .build() else { return };

        let Ok(blur_sub) = SubmenuBuilder::new(&app, "Blur")
            .text("blur_none", "None")
            .text("blur_light", "Light")
            .text("blur_medium", "Medium")
            .text("blur_heavy", "Heavy")
            .build() else { return };

        let Ok(bg_sub) = SubmenuBuilder::new(&app, "Background")
            .text("bg_neon_room", "Neon Room")
            .text("bg_cozy_room", "Cozy Room")
            .text("bg_spooky_castle", "Spooky Castle")
            .separator()
            .text("bg_dark_purple", "Dark Purple")
            .text("bg_midnight", "Midnight Blue")
            .text("bg_purple", "Purple")
            .text("bg_ocean", "Ocean")
            .text("bg_warm", "Warm Dark")
            .separator()
            .text("bg_custom", "Load Image...")
            .item(&blur_sub)
            .build() else { return };

        let Ok(voice_american_f) = SubmenuBuilder::new(&app, "American Female")
            .text("voice_af_heart", voice_label("af_heart", "Heart"))
            .text("voice_af_alloy", voice_label("af_alloy", "Alloy"))
            .text("voice_af_aoede", voice_label("af_aoede", "Aoede"))
            .text("voice_af_bella", voice_label("af_bella", "Bella"))
            .text("voice_af_jessica", voice_label("af_jessica", "Jessica"))
            .text("voice_af_kore", voice_label("af_kore", "Kore"))
            .text("voice_af_nicole", voice_label("af_nicole", "Nicole"))
            .text("voice_af_nova", voice_label("af_nova", "Nova"))
            .text("voice_af_river", voice_label("af_river", "River"))
            .text("voice_af_sarah", voice_label("af_sarah", "Sarah"))
            .text("voice_af_sky", voice_label("af_sky", "Sky"))
            .build() else { return };

        let Ok(voice_american_m) = SubmenuBuilder::new(&app, "American Male")
            .text("voice_am_adam", voice_label("am_adam", "Adam"))
            .text("voice_am_echo", voice_label("am_echo", "Echo"))
            .text("voice_am_eric", voice_label("am_eric", "Eric"))
            .text("voice_am_fenrir", voice_label("am_fenrir", "Fenrir"))
            .text("voice_am_liam", voice_label("am_liam", "Liam"))
            .text("voice_am_michael", voice_label("am_michael", "Michael"))
            .text("voice_am_onyx", voice_label("am_onyx", "Onyx"))
            .text("voice_am_puck", voice_label("am_puck", "Puck"))
            .build() else { return };

        let Ok(voice_british_f) = SubmenuBuilder::new(&app, "British Female")
            .text("voice_bf_alice", voice_label("bf_alice", "Alice"))
            .text("voice_bf_emma", voice_label("bf_emma", "Emma"))
            .text("voice_bf_isabella", voice_label("bf_isabella", "Isabella"))
            .text("voice_bf_lily", voice_label("bf_lily", "Lily"))
            .build() else { return };

        let Ok(voice_british_m) = SubmenuBuilder::new(&app, "British Male")
            .text("voice_bm_daniel", voice_label("bm_daniel", "Daniel"))
            .text("voice_bm_fable", voice_label("bm_fable", "Fable"))
            .text("voice_bm_george", voice_label("bm_george", "George"))
            .text("voice_bm_lewis", voice_label("bm_lewis", "Lewis"))
            .build() else { return };

        let Ok(voice_sub) = SubmenuBuilder::new(&app, "Voice")
            .item(&voice_american_f)
            .item(&voice_american_m)
            .item(&voice_british_f)
            .item(&voice_british_m)
            .build() else { return };

        let Ok(camera_sub) = SubmenuBuilder::new(&app, "Camera")
            .text("zoom_in", "Zoom In")
            .text("zoom_out", "Zoom Out")
            .text("camera_up", "Camera Up")
            .text("camera_down", "Camera Down")
            .build() else { return };

        let cue_label = |mode: &str, name: &str| -> String {
            if cue_mode == mode { format!("✓ {}", name) } else { format!("  {}", name) }
        };

        let Ok(cue_sub) = SubmenuBuilder::new(&app, "Notification Sound")
            .text("cue_off", cue_label("off", "Off"))
            .text("cue_once", cue_label("once", "Once"))
            .text("cue_15s", cue_label("15s", "Every 15s"))
            .text("cue_30s", cue_label("30s", "Every 30s"))
            .text("cue_always", cue_label("always", "Always"))
            .build() else { return };

        if let Ok(menu) = MenuBuilder::new(&app)
            .text("stop_speaking", "Stop Speaking")
            .text("toggle_mute", mute_label)
            .separator()
            .text("toggle_waveform", wf_label)
            .text("toggle_subtitles", st_label)
            .separator()
            .item(&voice_sub)
            .item(&mood_sub)
            .item(&bg_sub)
            .item(&camera_sub)
            .item(&cue_sub)
            .separator()
            .text("load_avatar", "Load Avatar...")
            .text("reset_avatar", "Reset Avatar")
            .separator()
            .text("reload", "Reload")
            .text("reset_position", "Reset Position")
            .text("quit", "Quit")
            .build()
        {
            let _ = window.popup_menu(&menu);
        }
    }
}

// ── App Entry ─────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            app.manage(Mutex::new(ToggleState { waveform: true, subtitles: true, muted: false, voice: "af_heart".to_string(), voice_cue_mode: "30s".to_string() }));

            // ── Restore saved window position ──
            if let Some(window) = app.get_webview_window("overlay") {
                if let Some(state) = load_window_state() {
                    use tauri::{LogicalPosition, LogicalSize};
                    let _ = window.set_position(LogicalPosition::new(state.x, state.y));
                    let _ = window.set_size(LogicalSize::new(state.width, state.height));
                }

                // Right-click is handled by frontend (main.ts mouseup handler)
                // — no injection needed here
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            match id {
                "stop_speaking" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval(
                            "fetch('http://127.0.0.1:5111/stop', {method:'POST'})",
                        );
                    }
                }
                "zoom_in" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval("window.__V1R4_ZOOM_IN?.()");
                    }
                }
                "zoom_out" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval("window.__V1R4_ZOOM_OUT?.()");
                    }
                }
                "camera_up" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval("window.__V1R4_CAMERA_UP?.()");
                    }
                }
                "camera_down" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval("window.__V1R4_CAMERA_DOWN?.()");
                    }
                }
                id if id.starts_with("voice_") => {
                    let voice = id[6..].to_string(); // strip "voice_" prefix
                    // Update tracked voice state
                    if let Some(state) = app.try_state::<Mutex<ToggleState>>() {
                        if let Ok(mut ts) = state.lock() {
                            ts.voice = voice.clone();
                        }
                    }
                    if let Some(window) = app.get_webview_window("overlay") {
                        let js = format!(
                            "fetch('http://127.0.0.1:5111/voice', {{method:'POST', headers:{{'Content-Type':'application/json'}}, body:JSON.stringify({{voice:'{}'}})}})",
                            voice
                        );
                        let _ = window.eval(&js);
                    }
                }
                id if id.starts_with("mood_") => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let mood = &id[5..]; // strip "mood_" prefix
                        let js = format!("window.__V1R4_PREVIEW_MOOD?.('{}')", mood);
                        let _ = window.eval(&js);
                    }
                }
                "bg_custom" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval("window.__V1R4_CHANGE_BG?.('custom', 0)");
                    }
                }
                id if id.starts_with("blur_") => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let blur = match id {
                            "blur_none" => 0,
                            "blur_light" => 12,
                            "blur_medium" => 25,
                            "blur_heavy" => 40,
                            _ => 0,
                        };
                        let js = format!("window.__V1R4_SET_BLUR?.({})", blur);
                        let _ = window.eval(&js);
                    }
                }
                id if id.starts_with("bg_") => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let preset = match id {
                            "bg_dark_purple" => "darkPurple",
                            "bg_midnight" => "midnight",
                            "bg_purple" => "purple",
                            "bg_ocean" => "ocean",
                            "bg_warm" => "warmDark",
                            "bg_neon_room" => "neonRoom",
                            "bg_cozy_room" => "cozyRoom",
                            "bg_spooky_castle" => "spookyCastle",
                            _ => "darkPurple",
                        };
                        let js = format!(
                            "window.__V1R4_CHANGE_BG?.('{}')",
                            preset
                        );
                        let _ = window.eval(&js);
                    }
                }
                id if id.starts_with("cue_") => {
                    let mode = &id[4..]; // strip "cue_" prefix
                    if let Some(state) = app.try_state::<Mutex<ToggleState>>() {
                        if let Ok(mut ts) = state.lock() {
                            ts.voice_cue_mode = mode.to_string();
                        }
                    }
                    if let Some(window) = app.get_webview_window("overlay") {
                        let js = format!(
                            "fetch('http://127.0.0.1:5111/voice-cue-mode', {{method:'POST', headers:{{'Content-Type':'application/json'}}, body:JSON.stringify({{mode:'{}'}})}})",
                            mode
                        );
                        let _ = window.eval(&js);
                    }
                }
                "load_avatar" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval("window.__V1R4_LOAD_AVATAR?.()");
                    }
                }
                "reset_avatar" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval("window.__V1R4_RESET_AVATAR?.()");
                    }
                }
                "toggle_mute" => {
                    let new_muted = if let Some(state) = app.try_state::<Mutex<ToggleState>>() {
                        if let Ok(mut ts) = state.lock() {
                            ts.muted = !ts.muted;
                            ts.muted
                        } else { false }
                    } else { false };
                    if let Some(window) = app.get_webview_window("overlay") {
                        let js = format!(
                            "fetch('http://127.0.0.1:5111/mute', {{method:'POST', headers:{{'Content-Type':'application/json'}}, body:JSON.stringify({{muted:{}}})}})",
                            new_muted
                        );
                        let _ = window.eval(&js);
                    }
                }
                "toggle_waveform" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval("window.__V1R4_TOGGLE_WAVEFORM?.()");
                    }
                }
                "toggle_subtitles" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval("window.__V1R4_TOGGLE_SUBTITLES?.()");
                    }
                }
                "reload" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        let _ = window.eval("location.reload()");
                    }
                }
                "reset_position" => {
                    if let Some(window) = app.get_webview_window("overlay") {
                        use tauri::{LogicalPosition, LogicalSize};
                        let _ = window.set_position(LogicalPosition::new(100.0, 100.0));
                        let _ = window.set_size(LogicalSize::new(300.0, 400.0));
                        save_window_state(&WindowState {
                            x: 100.0,
                            y: 100.0,
                            width: 300.0,
                            height: 400.0,
                        });
                    }
                }
                "quit" => {
                    // Save state before quitting
                    if let Some(window) = app.get_webview_window("overlay") {
                        if let Some(state) = capture_webview_window_state(&window) {
                            save_window_state(&state);
                        }
                    }
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_window_event(|window, event| match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                if let Some(state) = capture_window_state(window) {
                    save_window_state(&state);
                }
            }
            WindowEvent::CloseRequested { .. } => {
                if let Some(state) = capture_window_state(window) {
                    save_window_state(&state);
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![show_context_menu, get_cursor_position, get_keystroke_count, set_toggle_state, get_viewer_direction])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
