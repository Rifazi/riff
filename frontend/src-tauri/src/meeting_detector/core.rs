//! The start/stop decision, kept free of Core Audio and Tauri so it can be
//! tested with a fake clock.

use std::time::{Duration, Instant};

#[derive(Clone, Copy)]
pub struct Timing {
    /// How long an app must hold the mic before recording starts, so a brief
    /// mic test doesn't count as a call.
    pub start_after: Duration,
    /// How long the mic must stay free before an auto recording stops. A muted
    /// or reconnecting call can drop its input stream for a few seconds.
    pub stop_after: Duration,
    /// Pause after a failed start before trying again.
    pub retry_after: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Self {
            start_after: Duration::from_secs(3),
            stop_after: Duration::from_secs(20),
            retry_after: Duration::from_secs(30),
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    None,
    /// Start recording for the app with this key.
    Start(&'static str),
    /// The call has ended; stop the recording the detector started.
    Stop,
}

pub struct Detector {
    timing: Timing,
    /// The app that has held the mic since this instant, not yet long enough.
    call: Option<(&'static str, Instant)>,
    /// Since when no enabled app has held the mic, while an auto recording runs.
    quiet_since: Option<Instant>,
    /// Set while a recording the detector started is running.
    auto_app: Option<&'static str>,
    /// A recording the user controls overlaps this call, so leave it alone
    /// until the call ends.
    suppressed: bool,
    retry_not_before: Option<Instant>,
}

impl Detector {
    pub fn new(timing: Timing) -> Self {
        Self {
            timing,
            call: None,
            quiet_since: None,
            auto_app: None,
            suppressed: false,
            retry_not_before: None,
        }
    }

    /// Forget everything, for when auto-record is switched off. A recording
    /// already running is left alone, as if the user had started it.
    pub fn reset(&mut self) {
        *self = Self::new(self.timing);
    }

    /// `active` is the enabled app holding the mic right now, `recording`
    /// whether Riff is recording (started by anyone).
    pub fn tick(&mut self, now: Instant, active: Option<&'static str>, recording: bool) -> Action {
        // The user stopped an auto recording themselves: don't start another
        // one for the call that is still going.
        if self.auto_app.is_some() && !recording {
            self.auto_app = None;
            self.quiet_since = None;
            self.suppressed = active.is_some();
        }

        match active {
            None => {
                self.call = None;
                self.suppressed = false;
                if self.auto_app.is_some() {
                    let since = *self.quiet_since.get_or_insert(now);
                    if now.duration_since(since) >= self.timing.stop_after {
                        // `auto_app` stays set: once the recording is gone the
                        // branch above clears it, and if the stop failed we
                        // try again after another quiet period.
                        self.quiet_since = None;
                        return Action::Stop;
                    }
                }
            }
            Some(app) => {
                self.quiet_since = None;
                if recording && self.auto_app.is_none() {
                    self.suppressed = true;
                }
                if recording || self.suppressed {
                    self.call = None;
                    return Action::None;
                }
                if self.retry_not_before.is_some_and(|t| now < t) {
                    return Action::None;
                }
                let since = match self.call {
                    Some((current, since)) if current == app => since,
                    _ => {
                        self.call = Some((app, now));
                        now
                    }
                };
                if now.duration_since(since) >= self.timing.start_after {
                    self.call = None;
                    self.auto_app = Some(app);
                    return Action::Start(app);
                }
            }
        }
        Action::None
    }

    /// The start returned an error: forget it and wait before trying again.
    pub fn start_failed(&mut self, now: Instant) {
        self.auto_app = None;
        self.retry_not_before = Some(now + self.timing.retry_after);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn secs(base: Instant, s: u64) -> Instant {
        base + Duration::from_secs(s)
    }

    #[test]
    fn starts_once_the_mic_has_been_held_long_enough() {
        let t0 = Instant::now();
        let mut d = Detector::new(Timing::default());
        assert_eq!(d.tick(secs(t0, 0), Some("teams"), false), Action::None);
        assert_eq!(d.tick(secs(t0, 2), Some("teams"), false), Action::None);
        assert_eq!(d.tick(secs(t0, 3), Some("teams"), false), Action::Start("teams"));
    }

    #[test]
    fn a_brief_blip_does_not_start() {
        let t0 = Instant::now();
        let mut d = Detector::new(Timing::default());
        d.tick(secs(t0, 0), Some("zoom"), false);
        d.tick(secs(t0, 2), None, false);
        assert_eq!(d.tick(secs(t0, 4), Some("zoom"), false), Action::None);
        assert_eq!(d.tick(secs(t0, 7), Some("zoom"), false), Action::Start("zoom"));
    }

    #[test]
    fn never_starts_over_a_manual_recording_or_stops_it() {
        let t0 = Instant::now();
        let mut d = Detector::new(Timing::default());
        for s in 0..60 {
            assert_eq!(d.tick(secs(t0, s), Some("teams"), true), Action::None);
        }
        for s in 60..120 {
            assert_eq!(d.tick(secs(t0, s), None, true), Action::None);
        }
    }

    #[test]
    fn a_manual_stop_mid_call_does_not_restart_until_the_next_call() {
        let t0 = Instant::now();
        let mut d = Detector::new(Timing::default());
        d.tick(secs(t0, 0), Some("teams"), true); // user recording during the call
        for s in 1..30 {
            assert_eq!(d.tick(secs(t0, s), Some("teams"), false), Action::None);
        }
        d.tick(secs(t0, 30), None, false); // call ends
        d.tick(secs(t0, 40), Some("teams"), false);
        assert_eq!(d.tick(secs(t0, 43), Some("teams"), false), Action::Start("teams"));
    }

    #[test]
    fn stops_after_the_quiet_period_but_not_for_a_short_mute() {
        let t0 = Instant::now();
        let mut d = Detector::new(Timing::default());
        d.tick(secs(t0, 0), Some("teams"), false);
        assert_eq!(d.tick(secs(t0, 3), Some("teams"), false), Action::Start("teams"));
        // muted for 10s: the input stream drops, then comes back
        assert_eq!(d.tick(secs(t0, 10), None, true), Action::None);
        assert_eq!(d.tick(secs(t0, 20), None, true), Action::None);
        assert_eq!(d.tick(secs(t0, 21), Some("teams"), true), Action::None);
        // really over
        assert_eq!(d.tick(secs(t0, 30), None, true), Action::None);
        assert_eq!(d.tick(secs(t0, 50), None, true), Action::Stop);
    }

    #[test]
    fn a_call_user_ended_by_stopping_manually_is_not_restarted() {
        let t0 = Instant::now();
        let mut d = Detector::new(Timing::default());
        d.tick(secs(t0, 0), Some("teams"), false);
        d.tick(secs(t0, 3), Some("teams"), false); // Start
        assert_eq!(d.tick(secs(t0, 10), Some("teams"), false), Action::None); // user stopped it
        assert_eq!(d.tick(secs(t0, 30), Some("teams"), false), Action::None);
    }

    #[test]
    fn a_failed_start_backs_off() {
        let t0 = Instant::now();
        let mut d = Detector::new(Timing::default());
        d.tick(secs(t0, 0), Some("teams"), false);
        assert_eq!(d.tick(secs(t0, 3), Some("teams"), false), Action::Start("teams"));
        d.start_failed(secs(t0, 3));
        assert_eq!(d.tick(secs(t0, 10), Some("teams"), false), Action::None);
        assert_eq!(d.tick(secs(t0, 32), Some("teams"), false), Action::None);
        // back-off over at 33; the debounce starts afresh
        assert_eq!(d.tick(secs(t0, 36), Some("teams"), false), Action::None);
        assert_eq!(d.tick(secs(t0, 39), Some("teams"), false), Action::Start("teams"));
    }

    #[test]
    fn a_failed_stop_is_retried() {
        let t0 = Instant::now();
        let mut d = Detector::new(Timing::default());
        d.tick(secs(t0, 0), Some("teams"), false);
        d.tick(secs(t0, 3), Some("teams"), false);
        d.tick(secs(t0, 10), None, true);
        assert_eq!(d.tick(secs(t0, 30), None, true), Action::Stop);
        // still recording after the failed stop
        d.tick(secs(t0, 32), None, true);
        assert_eq!(d.tick(secs(t0, 52), None, true), Action::Stop);
    }
}
