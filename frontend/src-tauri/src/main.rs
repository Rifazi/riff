#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use log;
use env_logger;

fn main() {
    std::env::set_var("RUST_LOG", "info");
    env_logger::init();

    // The Dev Sessions agent server runs the app's own search engine through
    // this mode (see riff_search::stdio), so every search shares one implementation.
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some("--search-stdio") {
        if let Err(e) = riff_search::stdio::main_from_args(args) {
            eprintln!("riff --search-stdio: {e:#}");
            std::process::exit(1);
        }
        return;
    }

    // Async logger will be initialized lazily when first needed (after Tauri runtime starts)
    log::info!("Starting application...");
    app_lib::run();
}
