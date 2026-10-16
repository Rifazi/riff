import React, { useState, useEffect } from 'react';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { FolderOpen } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { DeviceSelection, SelectedDevices } from '@/components/DeviceSelection';
import Analytics from '@/lib/analytics';
import { toast } from 'sonner';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { useConfig } from '@/contexts/ConfigContext';

export interface RecordingPreferences {
  save_folder: string;
  auto_save: boolean;
  file_format: string;
  preferred_mic_device: string | null;
  preferred_system_device: string | null;
  auto_record_meetings: boolean;
  auto_record_apps: string[];
}

interface AutoRecordApp {
  key: string;
  name: string;
  installed: boolean;
  default_enabled: boolean;
}

interface RecordingSettingsProps {
  onSave?: (preferences: RecordingPreferences) => void;
}

export function RecordingSettings({ onSave }: RecordingSettingsProps) {
  const [preferences, setPreferences] = useState<RecordingPreferences>({
    save_folder: '',
    auto_save: true,
    file_format: 'mp4',
    preferred_mic_device: null,
    preferred_system_device: null,
    auto_record_meetings: false,
    auto_record_apps: [],
  });
  const [autoRecordApps, setAutoRecordApps] = useState<AutoRecordApp[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showRecordingNotification, setShowRecordingNotification] = useState(true);
  const { isRecording } = useRecordingState();
  const { setSelectedDevices } = useConfig();

  // Load recording preferences on component mount
  useEffect(() => {
    const loadPreferences = async () => {
      try {
        const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
        setPreferences(prefs);
      } catch (error) {
        console.error('Failed to load recording preferences:', error);
        // If loading fails, get default folder path
        try {
          const defaultPath = await invoke<string>('get_default_recordings_folder_path');
          setPreferences((prev) => ({ ...prev, save_folder: defaultPath }));
        } catch (defaultError) {
          console.error('Failed to get default folder path:', defaultError);
        }
      } finally {
        setLoading(false);
      }
    };

    loadPreferences();
  }, []);

  useEffect(() => {
    invoke<AutoRecordApp[]>('list_auto_record_apps')
      .then(setAutoRecordApps)
      .catch((error) => console.error('Failed to list auto-record apps:', error));
  }, []);

  // Load recording notification preference
  useEffect(() => {
    const loadNotificationPref = async () => {
      try {
        const { Store } = await import('@tauri-apps/plugin-store');
        const store = await Store.load('preferences.json');
        const show = (await store.get<boolean>('show_recording_notification')) ?? true;
        setShowRecordingNotification(show);
      } catch (error) {
        console.error('Failed to load notification preference:', error);
      }
    };
    loadNotificationPref();
  }, []);

  const handleAutoSaveToggle = async (enabled: boolean) => {
    const newPreferences = { ...preferences, auto_save: enabled };
    setPreferences(newPreferences);
    await savePreferences(newPreferences);

    // Track auto-save setting change
    await Analytics.track('auto_save_recording_toggled', {
      enabled: enabled.toString(),
    });
  };

  const handleAutoRecordToggle = async (enabled: boolean) => {
    // The first time it is turned on, start from the apps most people mean.
    const apps =
      enabled && preferences.auto_record_apps.length === 0
        ? autoRecordApps.filter((a) => a.default_enabled).map((a) => a.key)
        : preferences.auto_record_apps;
    const newPreferences = { ...preferences, auto_record_meetings: enabled, auto_record_apps: apps };
    setPreferences(newPreferences);
    await savePreferences(newPreferences, 'Auto-record setting saved');
    await Analytics.track('auto_record_meetings_toggled', { enabled: enabled.toString() });
  };

  const handleAutoRecordAppToggle = async (key: string, enabled: boolean) => {
    const apps = enabled
      ? [...preferences.auto_record_apps, key]
      : preferences.auto_record_apps.filter((k) => k !== key);
    const newPreferences = { ...preferences, auto_record_apps: apps };
    setPreferences(newPreferences);
    await savePreferences(newPreferences, 'Auto-record apps saved');
  };

  const handleDeviceChange = async (devices: SelectedDevices) => {
    const newPreferences = {
      ...preferences,
      preferred_mic_device: devices.micDevice,
      preferred_system_device: devices.systemDevice,
    };
    setPreferences(newPreferences);
    // Sync the in-memory selection ConfigContext exposes to the start path.
    // Without this, the picker only writes to disk (loaded into context once at
    // app mount), so a newly-chosen mic isn't honored until the next launch —
    // start keeps sending the stale launch-time device.
    setSelectedDevices(devices);
    await savePreferences(newPreferences);

    // Track default device preference changes
    // Note: Individual device selection analytics are tracked in DeviceSelection component
    await Analytics.track('default_devices_changed', {
      has_preferred_microphone: (!!devices.micDevice).toString(),
      has_preferred_system_audio: (!!devices.systemDevice).toString(),
    });
  };

  const handleOpenFolder = async () => {
    try {
      await invoke('open_recordings_folder');
    } catch (error) {
      console.error('Failed to open recordings folder:', error);
    }
  };

  const handleNotificationToggle = async (enabled: boolean) => {
    try {
      setShowRecordingNotification(enabled);
      const { Store } = await import('@tauri-apps/plugin-store');
      const store = await Store.load('preferences.json');
      await store.set('show_recording_notification', enabled);
      await store.save();
      toast.success('Preference saved');
      await Analytics.track('recording_notification_preference_changed', {
        enabled: enabled.toString(),
      });
    } catch (error) {
      console.error('Failed to save notification preference:', error);
      toast.error('Failed to save preference');
    }
  };

  const savePreferences = async (prefs: RecordingPreferences, successMessage?: string) => {
    setSaving(true);
    try {
      await invoke('set_recording_preferences', { preferences: prefs });
      onSave?.(prefs);

      if (successMessage) {
        toast.success(successMessage);
      } else {
        // Show success toast with device details
        const micDevice = prefs.preferred_mic_device || 'Default';
        const systemDevice = prefs.preferred_system_device || 'Default';
        toast.success('Device preferences saved', {
          description: `Microphone: ${micDevice}, System Audio: ${systemDevice}`,
        });
      }
    } catch (error) {
      console.error('Failed to save recording preferences:', error);
      toast.error('Failed to save recording preferences', {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="animate-pulse">
        <Skeleton className="h-4 w-1/4 mb-4" />
        <Skeleton className="h-8 mb-4" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-4">Recording Settings</h3>
        <p className="text-sm text-muted-foreground mb-6">
          Configure how your audio recordings are saved during meetings.
        </p>
      </div>

      {/* Auto Save Toggle */}
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex-1">
          <div className="font-medium">Save Audio Recordings</div>
          <div className="text-sm text-muted-foreground">Automatically save audio files when recording stops</div>
        </div>
        <Switch checked={preferences.auto_save} onCheckedChange={handleAutoSaveToggle} disabled={saving} />
      </div>

      {/* Folder Location - Only shown when auto_save is enabled */}
      {preferences.auto_save && (
        <div className="space-y-4">
          <div className="p-4 border rounded-lg bg-muted">
            <div className="font-medium mb-2">Save Location</div>
            <div className="text-sm text-muted-foreground mb-3 break-all">
              {preferences.save_folder || 'Default folder'}
            </div>
            <Button variant="outline" onClick={handleOpenFolder} className="h-auto px-3 py-2">
              <FolderOpen className="w-4 h-4" />
              Open Folder
            </Button>
          </div>

          <div className="p-4 border border-info/50 rounded-lg bg-info/10">
            <div className="text-sm text-foreground">
              <strong>File Format:</strong> {preferences.file_format.toUpperCase()} files
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              Recordings are saved with timestamp: recording_YYYYMMDD_HHMMSS.{preferences.file_format}
            </div>
          </div>
        </div>
      )}

      {/* Info when auto_save is disabled */}
      {!preferences.auto_save && (
        <div className="p-4 border border-warning/50 rounded-lg bg-warning/10">
          <div className="text-sm text-foreground">
            Audio recording is disabled. Enable "Save Audio Recordings" to automatically save your meeting audio.
          </div>
        </div>
      )}

      {/* Recording Notification Toggle */}
      <div className="flex items-center justify-between p-4 border rounded-lg">
        <div className="flex-1">
          <div className="font-medium">Recording Start Notification</div>
          <div className="text-sm text-muted-foreground">
            Show reminder to inform participants when recording starts
          </div>
        </div>
        <Switch checked={showRecordingNotification} onCheckedChange={handleNotificationToggle} />
      </div>

      {/* Auto-record meetings */}
      <div className="space-y-3">
        <div className="flex items-center justify-between p-4 border rounded-lg">
          <div className="flex-1 pr-4">
            <div className="font-medium">Record meetings automatically</div>
            <div className="text-sm text-muted-foreground">
              Start recording when one of the apps below is on a call, and stop when the call ends. Riff has to be
              running (it can stay in the menu bar). Recordings it starts show the usual notification and menu bar
              indicator, but nobody on the call is told, so make sure everyone has agreed to be recorded.
            </div>
          </div>
          <Switch
            checked={preferences.auto_record_meetings}
            onCheckedChange={handleAutoRecordToggle}
            disabled={saving || autoRecordApps.length === 0}
          />
        </div>

        {preferences.auto_record_meetings && (
          <div className="border rounded-lg divide-y">
            {autoRecordApps.map((app) => (
              <div key={app.key} className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="text-sm font-medium">{app.name}</div>
                  {!app.installed && <div className="text-xs text-muted-foreground">Not found on this Mac</div>}
                </div>
                <Switch
                  checked={preferences.auto_record_apps.includes(app.key)}
                  onCheckedChange={(enabled) => handleAutoRecordAppToggle(app.key, enabled)}
                  disabled={saving}
                  aria-label={`Auto-record ${app.name} calls`}
                />
              </div>
            ))}
            <div className="px-4 py-3 text-xs text-muted-foreground">
              Needs macOS 14.2 or later. A browser counts whenever any tab uses the microphone, so leave it off unless
              you mostly take calls on the web.
            </div>
          </div>
        )}
      </div>

      {/* Device Preferences */}
      <div className="space-y-4">
        <div className="border-t pt-6">
          <h4 className="text-base font-medium text-foreground mb-4">Default Audio Devices</h4>
          <p className="text-sm text-muted-foreground mb-4">
            Set your preferred microphone and system audio devices for recording. These will be automatically selected
            when starting new recordings.
          </p>

          {isRecording && (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-foreground bg-warning/10 border border-warning/50 rounded-md p-2 mb-4"
            >
              Device selection is locked while a recording is in progress. Connecting a new device mid-recording will
              not switch to it. Stop the current meeting to change devices.
            </p>
          )}

          <div className="border rounded-lg p-4 bg-muted">
            <DeviceSelection
              selectedDevices={{
                micDevice: preferences.preferred_mic_device,
                systemDevice: preferences.preferred_system_device,
              }}
              onDeviceChange={handleDeviceChange}
              disabled={saving || isRecording}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
