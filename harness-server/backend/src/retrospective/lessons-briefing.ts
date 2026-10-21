import { lessonsBriefing, lessonsFingerprint } from './core.js';
import { listLessons } from './store.js';

/** The lessons learned on this app, as a system-prompt section for plan, coding and QA. '' when there are none. */
export function lessonsBriefingFor(appId: string | null | undefined, role: 'plan' | 'coding' | 'qa'): string {
  return appId ? lessonsBriefing(listLessons(appId), role) : '';
}

export function lessonsFingerprintFor(appId: string): string {
  return lessonsFingerprint(listLessons(appId));
}
