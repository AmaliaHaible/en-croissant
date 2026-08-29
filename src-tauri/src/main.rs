// Hide the console window on Windows release builds (GUI subsystem).
#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

mod chess;
mod db;
mod engine;
mod error;
mod game;

mod fs;
mod lexer;
mod oauth;
mod opening;
mod pgn;
mod progress;
mod puzzle;
mod sound;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::SystemTime;

use chess::{BestMovesPayload, EngineProcess};
use dashmap::DashMap;
use db::{DatabaseProgress, GameQuery, NormalizedGame, PositionStats};
use derivative::Derivative;
use game::GameManager;
use progress::{clear_progress, get_progress, ProgressEvent, ProgressStore};

use log::LevelFilter;
use oauth::AuthState;
use serde::Serialize;
#[cfg(debug_assertions)]
use specta_typescript::{BigIntExportBehavior, Typescript};
use sysinfo::{CpuExt, RefreshKind, SystemExt};
use tauri::{Manager, Window};
use tauri_plugin_log::{Target, TargetKind};

use crate::chess::{
    analyze_game, cancel_analysis, get_engine_config, get_engine_logs, kill_engine, kill_engines,
    stop_engine,
};
use crate::db::{
    clear_games, convert_pgn, create_indexes, delete_database, delete_db_game, delete_empty_games,
    delete_indexes, export_to_pgn, get_player, get_players_game_info, get_tournaments,
    preload_reference_db, search_position, MmapSearchIndex,
};
use crate::game::{
    abort_game, get_game_engine_logs, get_game_state, make_game_move, resign_game, start_game,
    take_back_game_move, ClockUpdateEvent, GameMoveEvent, GameOverEvent,
};

use crate::fs::set_file_as_executable;
use crate::lexer::lex_pgn;
use crate::oauth::authenticate;
use crate::pgn::{count_pgn_games, delete_game, read_games, write_game};
use crate::puzzle::{
    delete_puzzle_database, get_puzzle, get_puzzle_db_info, get_puzzle_themes,
    get_themes_for_puzzle,
};
use crate::sound::get_sound_server_port;
use crate::{
    chess::get_best_moves,
    db::{
        delete_duplicated_games, edit_db_info, get_db_info, get_game_analysis_label, get_games,
        get_players, merge_players, set_game_analysis_label, write_db_game,
    },
    fs::{download_file, file_exists, get_file_metadata},
    opening::{
        get_opening_from_fen, get_opening_from_fens, get_opening_from_name, search_opening_name,
    },
};
use std::sync::atomic::AtomicBool;
use tokio::sync::Semaphore;

#[derive(Derivative)]
#[derivative(Default)]
pub struct AppState {
    connection_pool: DashMap<
        String,
        diesel::r2d2::Pool<diesel::r2d2::ConnectionManager<diesel::SqliteConnection>>,
    >,
    line_cache:
        DashMap<(GameQuery, PathBuf, SystemTime), (Vec<PositionStats>, Vec<NormalizedGame>)>,
    db_cache: Mutex<Option<(PathBuf, MmapSearchIndex)>>,
    #[derivative(Default(value = "Arc::new(Semaphore::new(2))"))]
    new_request: Arc<Semaphore>,
    #[derivative(Default(value = "DashMap::new()"))]
    search_collisions: DashMap<(GameQuery, PathBuf), Arc<tokio::sync::Mutex<()>>>,
    pgn_offsets: DashMap<String, pgn::PgnIndex>,

    engine_processes: DashMap<(String, String), Arc<tokio::sync::Mutex<EngineProcess>>>,
    analysis_cancel_flags: DashMap<String, Arc<AtomicBool>>,
    auth: AuthState,
    game_manager: GameManager,
    progress_state: ProgressStore,
    #[derivative(Default(value = "reqwest::Client::new()"))]
    http_client: reqwest::Client,
}

#[tauri::command]
#[specta::specta]
async fn close_splashscreen(window: Window) -> Result<(), String> {
    window
        .get_webview_window("main")
        .expect("no window labeled 'main' found")
        .show()
        .unwrap();
    Ok(())
}

fn main() {
    let specta_builder = tauri_specta::Builder::new()
        .commands(tauri_specta::collect_commands!(
            close_splashscreen,
            get_best_moves,
            analyze_game,
            cancel_analysis,
            stop_engine,
            kill_engine,
            kill_engines,
            get_engine_logs,
            memory_size,
            get_puzzle,
            search_opening_name,
            get_opening_from_fen,
            get_opening_from_fens,
            get_opening_from_name,
            get_players_game_info,
            get_engine_config,
            file_exists,
            get_file_metadata,
            merge_players,
            convert_pgn,
            get_player,
            count_pgn_games,
            read_games,
            lex_pgn,
            is_bmi2_compatible,
            delete_game,
            delete_duplicated_games,
            delete_empty_games,
            clear_games,
            set_file_as_executable,
            delete_indexes,
            create_indexes,
            edit_db_info,
            delete_db_game,
            write_db_game,
            get_game_analysis_label,
            set_game_analysis_label,
            delete_database,
            export_to_pgn,
            authenticate,
            write_game,
            download_file,
            get_tournaments,
            get_db_info,
            get_games,
            search_position,
            get_players,
            get_puzzle_db_info,
            get_puzzle_themes,
            get_themes_for_puzzle,
            delete_puzzle_database,
            start_game,
            get_game_state,
            make_game_move,
            take_back_game_move,
            resign_game,
            abort_game,
            get_game_engine_logs,
            preload_reference_db,
            get_progress,
            clear_progress,
            get_sound_server_port,
            get_hardware_info
        ))
        .events(tauri_specta::collect_events!(
            BestMovesPayload,
            DatabaseProgress,
            ProgressEvent,
            GameMoveEvent,
            ClockUpdateEvent,
            GameOverEvent
        ));

    #[cfg(debug_assertions)]
    specta_builder
        .export(
            Typescript::default().bigint(BigIntExportBehavior::BigInt),
            "../src/bindings/generated.ts",
        )
        .expect("Failed to export types");

    #[cfg(debug_assertions)]
    let log_targets = [TargetKind::Stdout, TargetKind::Webview];

    #[cfg(not(debug_assertions))]
    let log_targets = [
        TargetKind::Stdout,
        TargetKind::LogDir {
            file_name: Some(String::from("en-croissant.log")),
        },
    ];

    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .targets(log_targets.map(Target::new))
                .level(LevelFilter::Info)
                .build(),
        )
        .invoke_handler(specta_builder.invoke_handler())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(move |app| {
            log::info!("Setting up application");

            // #[cfg(any(windows, target_os = "macos"))]
            // set_shadow(&app.get_webview_window("main").unwrap(), true).unwrap();

            specta_builder.mount_events(app);

            #[cfg(target_os = "linux")]
            {
                let sound_dir = app
                    .path()
                    .resolve("sound", tauri::path::BaseDirectory::Resource)
                    .unwrap_or_else(|_| PathBuf::from("sound"));
                let port = sound::start_sound_server(sound_dir);
                app.manage(sound::SoundServerPort(port));
            }
            #[cfg(not(target_os = "linux"))]
            app.manage(sound::SoundServerPort(0));

            #[cfg(desktop)]
            app.handle().plugin(tauri_plugin_cli::init())?;

            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }

            log::info!("Finished rust initialization");

            Ok(())
        })
        .manage(AppState::default())
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                let state = app.state::<AppState>();
                for entry in state.engine_processes.iter() {
                    if let Ok(mut process) = entry.value().try_lock() {
                        process.kill_sync();
                    }
                }
            }
        });
}

#[tauri::command]
#[specta::specta]
fn is_bmi2_compatible() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    if is_x86_feature_detected!("bmi2") {
        return true;
    }
    false
}

#[tauri::command]
#[specta::specta]
fn memory_size() -> u32 {
    let total_bytes =
        sysinfo::System::new_with_specifics(RefreshKind::new().with_memory()).total_memory();
    (total_bytes / 1024 / 1024) as u32
}

#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct HardwareInfo {
    pub cpu_brand: String,
    pub physical_cores: u32,
    pub logical_cores: u32,
    pub total_memory_mb: u32,
    pub available_memory_mb: u32,
    pub gpu_brand: String,
    pub vram_mb: Option<u32>,
    pub os_name: String,
    pub os_version: String,
    pub arch: String,
    pub is_bmi2: bool,
    pub is_avx2: bool,
    pub recommended_threads: u32,
    pub recommended_hash_mb: u32,
}

fn detect_gpu_and_vram() -> (String, Option<u32>) {
    // 1. Try nvidia-smi
    if let Ok(output) = std::process::Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,memory.total",
            "--format=csv,noheader,nounits",
        ])
        .output()
    {
        if output.status.success() {
            if let Ok(text) = String::from_utf8(output.stdout) {
                if let Some(line) = text.lines().next() {
                    let parts: Vec<&str> = line.split(',').collect();
                    if parts.len() >= 2 {
                        let name = parts[0].trim().to_string();
                        let vram = parts[1].trim().parse::<u32>().ok();
                        return (name, vram);
                    } else if !parts.is_empty() && !parts[0].trim().is_empty() {
                        return (parts[0].trim().to_string(), None);
                    }
                }
            }
        }
    }

    // 2. On Linux, try lspci
    #[cfg(target_os = "linux")]
    {
        if let Ok(output) = std::process::Command::new("lspci").output() {
            if output.status.success() {
                if let Ok(text) = String::from_utf8(output.stdout) {
                    for line in text.lines() {
                        let lower = line.to_lowercase();
                        if lower.contains("vga compatible controller")
                            || lower.contains("3d controller")
                            || lower.contains("display controller")
                        {
                            if let Some(pos) = line.find(": ") {
                                let name = line[pos + 2..].trim().to_string();
                                return (name, None);
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. On Windows, try PowerShell WMI
    #[cfg(target_os = "windows")]
    {
        if let Ok(output) = std::process::Command::new("powershell")
            .args(["-Command", "Get-CimInstance Win32_VideoController | Select-Object -Property Name,AdapterRAM | ConvertTo-Json"])
            .output()
        {
            if output.status.success() {
                if let Ok(text) = String::from_utf8(output.stdout) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        let item = if val.is_array() { val.get(0) } else { Some(&val) };
                        if let Some(obj) = item {
                            let name = obj.get("Name").and_then(|v| v.as_str()).unwrap_or("Discrete GPU").to_string();
                            let vram = obj.get("AdapterRAM").and_then(|v| v.as_u64()).map(|b| (b / 1024 / 1024) as u32);
                            return (name, vram);
                        }
                    }
                }
            }
        }
    }

    // 4. On macOS, try system_profiler
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = std::process::Command::new("system_profiler")
            .args(["SPDisplaysDataType", "-json"])
            .output()
        {
            if output.status.success() {
                if let Ok(text) = String::from_utf8(output.stdout) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(displays) =
                            val.get("SPDisplaysDataType").and_then(|v| v.as_array())
                        {
                            if let Some(first) = displays.first() {
                                let name = first
                                    .get("sppci_model")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or("Apple GPU")
                                    .to_string();
                                return (name, None);
                            }
                        }
                    }
                }
            }
        }
    }

    ("System GPU".to_string(), None)
}

#[tauri::command]
#[specta::specta]
fn get_hardware_info() -> HardwareInfo {
    let mut sys = sysinfo::System::new_with_specifics(
        sysinfo::RefreshKind::new()
            .with_cpu(sysinfo::CpuRefreshKind::everything())
            .with_memory(),
    );
    sys.refresh_cpu();
    sys.refresh_memory();

    let cpu_brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Unknown CPU".to_string());

    let logical_cores = sys.cpus().len().max(1) as u32;
    let physical_cores = sys.physical_core_count().unwrap_or(logical_cores as usize) as u32;
    let total_memory_mb = (sys.total_memory() / 1024 / 1024) as u32;
    let available_memory_mb = (sys.available_memory() / 1024 / 1024) as u32;

    let (gpu_brand, vram_mb) = detect_gpu_and_vram();

    let is_bmi2 = {
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        {
            is_x86_feature_detected!("bmi2")
        }
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        {
            false
        }
    };

    let is_avx2 = {
        #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
        {
            is_x86_feature_detected!("avx2")
        }
        #[cfg(not(any(target_arch = "x86", target_arch = "x86_64")))]
        {
            false
        }
    };

    let os_name = sys
        .name()
        .unwrap_or_else(|| std::env::consts::OS.to_string());
    let os_version = sys.os_version().unwrap_or_default();
    let arch = std::env::consts::ARCH.to_string();

    let recommended_threads = if logical_cores > 2 {
        logical_cores - 1
    } else {
        1
    };
    let recommended_hash_mb = (total_memory_mb / 4).clamp(16, 4096);

    HardwareInfo {
        cpu_brand,
        physical_cores,
        logical_cores,
        total_memory_mb,
        available_memory_mb,
        gpu_brand,
        vram_mb,
        os_name,
        os_version,
        arch,
        is_bmi2,
        is_avx2,
        recommended_threads,
        recommended_hash_mb,
    }
}
