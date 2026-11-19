'use client';

import { useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { apiUrl } from './api';

interface AttentionEvent {
  kind: 'done' | 'attention';
  sessionId: string;
  title: string;
  body: string;
}

/** Whether the user is already looking at Riff, so a system banner would only repeat the screen. */
async function isWatching(): Promise<boolean> {
  try {
    const win = getCurrentWindow();
    return (await win.isFocused()) && (await win.isVisible()) && !(await win.isMinimized());
  } catch {
    return false;
  }
}

/**
 * Turns the agent server's "done" / "needs attention" events into macOS
 * notifications (through the app's notification manager, so the user's consent
 * and notification settings apply). The server runs Bridget without a tab, so
 * this lives in the root layout. EventSource reconnects by itself if the
 * server restarts.
 */
export function useAgentAttentionNotifications() {
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    const source = new EventSource(apiUrl('/api/notifications/stream'));
    source.onmessage = async (message) => {
      let event: AttentionEvent;
      try {
        event = JSON.parse(message.data) as AttentionEvent;
      } catch {
        return;
      }
      if (await isWatching()) return;
      try {
        await invoke('show_notification', {
          notification: {
            id: null,
            title: event.title,
            body: event.body,
            notification_type: 'DevSession',
            priority: event.kind === 'attention' ? 'High' : 'Normal',
            timeout: { Seconds: 8 },
            icon: null,
            sound: true,
            actions: [],
          },
        });
      } catch (err) {
        console.warn('Could not show the agent notification:', err);
      }
    };
    return () => source.close();
  }, []);
}

export function AgentAttentionNotificationsBridge() {
  useAgentAttentionNotifications();
  return null;
}
