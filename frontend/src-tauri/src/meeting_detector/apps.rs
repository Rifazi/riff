//! The apps Riff can auto-record. One table drives both the detector and the
//! Settings list, so a new app only needs an entry here.

use serde::Serialize;

pub struct MeetingApp {
    /// Stable key stored in `RecordingPreferences::auto_record_apps`.
    pub key: &'static str,
    pub name: &'static str,
    /// Bundle IDs of the app and its audio helpers. An ID also matches its
    /// dotted children (`com.google.Chrome` matches `com.google.Chrome.helper`),
    /// because the process holding the mic is often a helper.
    pub bundle_ids: &'static [&'static str],
    /// Where the app lives, to tell whether it is installed. A leading `~/`
    /// means the home directory.
    pub app_paths: &'static [&'static str],
    /// Turned on when the user first enables auto-record.
    pub default_enabled: bool,
}

pub const APPS: &[MeetingApp] = &[
    MeetingApp {
        key: "teams",
        name: "Microsoft Teams",
        bundle_ids: &["com.microsoft.teams2", "com.microsoft.teams"],
        app_paths: &[
            "/Applications/Microsoft Teams.app",
            "/Applications/Microsoft Teams (work or school).app",
            "/Applications/Microsoft Teams classic.app",
        ],
        default_enabled: true,
    },
    MeetingApp {
        key: "zoom",
        name: "Zoom",
        bundle_ids: &["us.zoom.xos"],
        app_paths: &["/Applications/zoom.us.app"],
        default_enabled: true,
    },
    MeetingApp {
        key: "webex",
        name: "Webex",
        bundle_ids: &[
            "Cisco-Systems.Spark",
            "com.cisco.webexmeetingsapp",
            "com.webex.meetingmanager",
        ],
        app_paths: &["/Applications/Webex.app", "/Applications/Cisco Webex Meetings.app"],
        default_enabled: false,
    },
    MeetingApp {
        key: "slack",
        name: "Slack huddles",
        bundle_ids: &["com.tinyspeck.slackmacgap"],
        app_paths: &["/Applications/Slack.app"],
        default_enabled: false,
    },
    MeetingApp {
        key: "discord",
        name: "Discord",
        bundle_ids: &["com.hnc.Discord"],
        app_paths: &["/Applications/Discord.app"],
        default_enabled: false,
    },
    MeetingApp {
        key: "facetime",
        name: "FaceTime",
        bundle_ids: &["com.apple.FaceTime", "com.apple.avconferenced"],
        app_paths: &["/System/Applications/FaceTime.app", "/Applications/FaceTime.app"],
        default_enabled: false,
    },
    // Browsers cover Google Meet and other web calls, but any tab using the
    // microphone triggers them, so they stay off unless asked for.
    MeetingApp {
        key: "browser",
        name: "Web browsers (Google Meet, etc.)",
        bundle_ids: &[
            "com.google.Chrome",
            "com.microsoft.edgemac",
            "org.mozilla.firefox",
            "com.brave.Browser",
            "company.thebrowser.Browser",
        ],
        app_paths: &[
            "/Applications/Google Chrome.app",
            "/Applications/Microsoft Edge.app",
            "/Applications/Firefox.app",
            "/Applications/Brave Browser.app",
            "/Applications/Arc.app",
        ],
        default_enabled: false,
    },
];

pub fn app_by_key(key: &str) -> Option<&'static MeetingApp> {
    APPS.iter().find(|a| a.key == key)
}

fn id_matches(bundle_id: &str, id: &str) -> bool {
    bundle_id == id
        || (bundle_id.len() > id.len()
            && bundle_id.starts_with(id)
            && bundle_id.as_bytes()[id.len()] == b'.')
}

/// The table entry for the process with this bundle ID, if it is one of ours.
pub fn match_bundle_id(bundle_id: &str) -> Option<&'static MeetingApp> {
    APPS.iter()
        .find(|app| app.bundle_ids.iter().any(|id| id_matches(bundle_id, id)))
}

fn is_installed(app: &MeetingApp) -> bool {
    app.app_paths.iter().any(|path| match path.strip_prefix("~/") {
        Some(rest) => dirs::home_dir().is_some_and(|home| home.join(rest).exists()),
        None => std::path::Path::new(path).exists(),
    })
}

#[derive(Serialize)]
pub struct AutoRecordApp {
    pub key: &'static str,
    pub name: &'static str,
    pub installed: bool,
    pub default_enabled: bool,
}

#[tauri::command]
pub fn list_auto_record_apps() -> Vec<AutoRecordApp> {
    APPS.iter()
        .map(|app| AutoRecordApp {
            key: app.key,
            name: app.name,
            installed: is_installed(app),
            default_enabled: app.default_enabled,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_exact_and_dotted_children() {
        assert_eq!(match_bundle_id("com.microsoft.teams2").unwrap().key, "teams");
        assert_eq!(match_bundle_id("com.microsoft.teams2.modulehost").unwrap().key, "teams");
        assert_eq!(match_bundle_id("com.google.Chrome.helper").unwrap().key, "browser");
        assert_eq!(match_bundle_id("us.zoom.xos").unwrap().key, "zoom");
    }

    #[test]
    fn does_not_match_lookalikes() {
        assert!(match_bundle_id("com.microsoft.teams2x").is_none());
        assert!(match_bundle_id("us.zoom").is_none());
        assert!(match_bundle_id("com.rifaz.riff").is_none());
        assert!(match_bundle_id("com.apple.WebKit.WebContent").is_none());
    }

    #[test]
    fn keys_are_unique() {
        for (i, a) in APPS.iter().enumerate() {
            assert!(APPS.iter().skip(i + 1).all(|b| b.key != a.key), "{}", a.key);
        }
    }
}
