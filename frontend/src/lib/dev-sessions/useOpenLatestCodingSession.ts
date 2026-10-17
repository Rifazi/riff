import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { api } from './api';
import { sessionHref, stageGroupFor } from './stage';

const OPENED_KEY = 'riff.openedLatestCodingSession';
const ATTEMPTS = 10;
const RETRY_MS = 1500;

/**
 * Once per app launch, opens the most recently updated session that is in
 * the coding stage. The agent server starts alongside the app, so the first
 * requests may fail; it retries for a while, then gives up and stays put.
 * Skipped while `disabled` (e.g. a recording is running).
 */
export function useOpenLatestCodingSession(disabled: boolean) {
  const router = useRouter();

  useEffect(() => {
    if (disabled) return;
    try {
      if (sessionStorage.getItem(OPENED_KEY)) return;
    } catch {}

    let cancelled = false;
    const markDone = () => {
      try {
        sessionStorage.setItem(OPENED_KEY, '1');
      } catch {}
    };

    (async () => {
      for (let attempt = 0; attempt < ATTEMPTS && !cancelled; attempt++) {
        try {
          const sessions = await api.listSessions();
          if (cancelled) return;
          markDone();
          const latest = sessions
            .filter((s) => stageGroupFor(s) === 'coding' && s.stage !== 'abandoned')
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
          if (latest) router.replace(sessionHref(latest.id, 'coding'));
          return;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [disabled, router]);
}
