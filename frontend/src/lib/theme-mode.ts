'use client';

import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'riff.themeMode';
const CHANGE_EVENT = 'riff-theme-mode-change';

function readStored(): ThemeMode {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === 'light' || value === 'dark' || value === 'system') return value;
  } catch {
    // storage unavailable: follow the system
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveDark(mode: ThemeMode): boolean {
  return mode === 'dark' || (mode === 'system' && systemPrefersDark());
}

/** Puts the `dark` class on <html>, which swaps the token set in globals.css. */
export function applyThemeMode(mode: ThemeMode): void {
  document.documentElement.classList.toggle('dark', resolveDark(mode));
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // not persisted; still applies for this session
  }
  applyThemeMode(mode);
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Current mode plus whether it resolves to dark; keeps <html> in sync with the OS in `system` mode. */
export function useThemeMode() {
  const [mode, setMode] = useState<ThemeMode>('system');
  const [isDark, setIsDark] = useState(false);

  const sync = useCallback(() => {
    const next = readStored();
    setMode(next);
    setIsDark(resolveDark(next));
    applyThemeMode(next);
  }, []);

  useEffect(() => {
    sync();
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', sync);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      media.removeEventListener('change', sync);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, [sync]);

  return { mode, isDark, setMode: setThemeMode };
}
