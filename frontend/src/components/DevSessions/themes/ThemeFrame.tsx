'use client';

import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/dev-sessions/api';
import type { ThemeDefinition, ThemeMode, ThemeTokens } from '@/lib/dev-sessions/types';
import { sameTheme } from './theme-utils';

const STYLE_ELEMENT_ID = 'dev-sessions-theme-components';

// Presets are fixed server-side, so one fetch per app run is enough.
export function useThemes() {
  return useQuery({ queryKey: ['themes'], queryFn: api.listThemes, staleTime: Infinity });
}

/**
 * The token maps for any theme, including unsaved edits. Presets come
 * precomputed; anything else is rendered by the server (the same code that
 * writes the app's tokens.css), debounced while the user drags a slider.
 * Keeps showing the last valid tokens while an edit is invalid.
 */
export function useThemeTokens(theme: ThemeDefinition | null): { tokens: ThemeTokens | undefined; error: string | null } {
  const { data: themes } = useThemes();
  const preset = theme ? themes?.presets.find((p) => sameTheme(p.theme, theme)) : undefined;
  const [debounced, setDebounced] = useState(theme);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(theme), 150);
    return () => clearTimeout(id);
  }, [theme]);

  const { data, error } = useQuery({
    queryKey: ['theme-preview', debounced],
    queryFn: () => api.previewTheme(debounced!),
    enabled: Boolean(debounced) && !preset,
    placeholderData: keepPreviousData,
    staleTime: Infinity,
    retry: false,
  });
  return { tokens: preset?.tokens ?? data?.tokens, error: preset ? null : ((error as Error | null)?.message ?? null) };
}

// One <style> in <head> shared by every preview on the page.
function useComponentsCss() {
  const { data } = useThemes();
  const css = data?.componentsCss;
  useEffect(() => {
    if (!css) return;
    let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ELEMENT_ID;
      document.head.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  }, [css]);
}

/**
 * Renders children with a theme's tokens and the shared ui-* component
 * classes in effect, in the given mode. The only place a preview gets its look.
 */
export function ThemeFrame({
  tokens,
  mode,
  className = '',
  children,
}: {
  tokens: ThemeTokens | undefined;
  mode: ThemeMode;
  className?: string;
  children: React.ReactNode;
}) {
  useComponentsCss();
  if (!tokens) return <div className={`${className} bg-gray-100 animate-pulse`} />;
  const style = { ...tokens[mode], colorScheme: mode } as React.CSSProperties;
  return (
    <div data-ui-theme="" style={style} className={className}>
      {children}
    </div>
  );
}
