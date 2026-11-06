//! Windows USB SpaceMouse input. Read HID reports directly so redirected USB
//! devices also work when Windows supplies no WM_INPUT messages to the host.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::Emitter;
use windows_sys::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

const EVENT: &str = "geolibre:spacemouse";

#[derive(Clone, Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Motion {
    device: String,
    translation: Option<[i16; 3]>,
    rotation: Option<[i16; 3]>,
}

fn decode(report: &[u8], device: String) -> Option<Motion> {
    if report.len() < 7 || !matches!(report[0], 1 | 2) {
        return None;
    }
    let vector = |start: usize| {
        std::array::from_fn(|i| {
            i16::from_le_bytes([report[start + i * 2], report[start + i * 2 + 1]])
        })
    };
    Some(Motion {
        device,
        translation: (report[0] == 1).then(|| vector(1)),
        rotation: if report[0] == 2 {
            Some(vector(1))
        } else if report.len() >= 13 {
            Some(vector(7))
        } else {
            None
        },
    })
}

/// Each read times out within 100 ms. Destruction stops the worker and drops
/// its shared HID handle; unplug/replug is handled without restarting the app.
pub fn install(window: &tauri::WebviewWindow) -> Result<(), Box<dyn std::error::Error>> {
    let hwnd = window.hwnd()?.0 as usize;
    let alive = Arc::new(AtomicBool::new(true));
    let stop = Arc::clone(&alive);
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            stop.store(false, Ordering::Relaxed);
        }
    });
    let window = window.clone();
    std::thread::Builder::new()
        .name("spacemouse".into())
        .spawn(move || {
            let mut connection = 0u64;
            let mut last_error = String::new();
            while alive.load(Ordering::Relaxed) {
                let result = read_device(&window, hwnd, &alive, &mut connection);
                if let Err(error) = result {
                    let message = error.to_string();
                    if message != last_error {
                        eprintln!("SpaceMouse: {message}");
                        last_error = message;
                    }
                } else {
                    last_error.clear();
                }
                let _ = window.emit_to(window.label(), EVENT, Option::<Motion>::None);
                // Retry discovery once a second, but respond promptly to shutdown.
                for _ in 0..10 {
                    if !alive.load(Ordering::Relaxed) {
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        })?;
    Ok(())
}

fn read_device(
    window: &tauri::WebviewWindow,
    hwnd: usize,
    alive: &AtomicBool,
    connection: &mut u64,
) -> hidapi::HidResult<()> {
    let api = hidapi::HidApi::new()?;
    // Filter the top-level collection as well as vendor: ordinary Logitech
    // mice and 3Dconnexion keyboard/button interfaces must never be captured.
    let Some(info) = api.device_list().find(|info| {
        matches!(info.vendor_id(), 0x046d | 0x256f) && info.usage_page() == 1 && info.usage() == 8
    }) else {
        return Ok(());
    };
    let device = info.open_device(&api)?;
    *connection += 1;
    let id = connection.to_string();
    let mut report = [0u8; 64];
    let mut focused = false;
    while alive.load(Ordering::Relaxed) {
        let length = device.read_timeout(&mut report, 100)?;
        // WebView2 owns the focused child, so compare the top-level HWND.
        let foreground = unsafe { GetForegroundWindow() as usize == hwnd };
        if focused && !foreground {
            let _ = window.emit_to(window.label(), EVENT, Option::<Motion>::None);
        }
        focused = foreground;
        if length == 0 {
            continue;
        }
        // Continue draining reports while unfocused so refocusing cannot replay
        // old movement. Never send that background motion to the webview.
        if foreground {
            if let Some(motion) = decode(&report[..length], id.clone()) {
                let _ = window.emit_to(window.label(), EVENT, motion);
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decodes_signed_separate_and_combined_reports() {
        let translation = decode(&[1, 255, 255, 94, 1, 162, 254], "a".into()).unwrap();
        assert_eq!(translation.translation, Some([-1, 350, -350]));
        assert_eq!(translation.rotation, None);
        let rotation = decode(&[2, 0, 128, 255, 127, 0, 0], "a".into()).unwrap();
        assert_eq!(rotation.translation, None);
        assert_eq!(rotation.rotation, Some([i16::MIN, i16::MAX, 0]));
        let combined = decode(&[1, 1, 0, 2, 0, 3, 0, 4, 0, 5, 0, 6, 0], "a".into()).unwrap();
        assert_eq!(combined.translation, Some([1, 2, 3]));
        assert_eq!(combined.rotation, Some([4, 5, 6]));
    }
    #[test]
    fn ignores_buttons_unknown_and_short_reports() {
        for report in [
            &[][..],
            &[1, 0, 0],
            &[2, 0, 0, 0, 0, 0],
            &[3, 0, 0, 0, 0, 0, 0],
            &[28, 0, 0, 0, 0, 0, 0],
        ] {
            assert!(decode(report, "a".into()).is_none());
        }
    }
}
