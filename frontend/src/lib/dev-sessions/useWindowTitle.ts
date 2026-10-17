import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';

const DEFAULT_TITLE = 'Riff';

/**
 * Names the native window after the app being worked on while this page is
 * mounted, then puts the default back. Does nothing without a name, or when
 * running outside Tauri.
 */
export function useWindowTitle(title: string | null | undefined) {
  useEffect(() => {
    if (!title) return;
    const set = (value: string) => {
      try {
        getCurrentWindow().setTitle(value).catch(() => {});
      } catch {
        // Not running inside Tauri.
      }
    };
    set(title);
    document.title = title;
    return () => {
      set(DEFAULT_TITLE);
      document.title = DEFAULT_TITLE;
    };
  }, [title]);
}
