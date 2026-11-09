import type { ThemeDefinition, ThemeMode, ThemeTokens } from '@/lib/dev-sessions/types';

/** One choice in a ThemePicker. `id` is whatever the caller keys its selection by. */
export interface ThemeOption {
  id: string;
  theme: ThemeDefinition;
  tokens: ThemeTokens | undefined;
  badge?: React.ReactNode;
}

export interface ThemePreviewProps {
  option: ThemeOption;
  mode: ThemeMode;
}
