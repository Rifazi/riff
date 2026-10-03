//! Standalone `riff-search` for running the agent server without the app
//! (`npm run dev` in harness-server). The app serves the same protocol as
//! `riff --search-stdio`. See `riff_search::stdio`.

fn main() {
    if let Err(e) = riff_search::stdio::main_from_args(std::env::args().skip(1)) {
        eprintln!("riff-search: {e:#}");
        std::process::exit(1);
    }
}
