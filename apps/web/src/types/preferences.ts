export const PERSONAL_COLOR_THEMES = ['light', 'dark', 'system'] as const;
export const PERSONAL_THEME_STORAGE_KEY = 'roomote-color-theme';

export type PersonalColorTheme = (typeof PERSONAL_COLOR_THEMES)[number];

export function isPersonalColorTheme(
  value: unknown,
): value is PersonalColorTheme {
  return (
    typeof value === 'string' &&
    PERSONAL_COLOR_THEMES.includes(value as PersonalColorTheme)
  );
}

export interface PersonalPreferences {
  colorTheme: PersonalColorTheme;
  narrationMode: boolean;
  showDebugUI: boolean;
}

export type PersonalPreferencesUpdate = Partial<PersonalPreferences>;

export const DEFAULT_PERSONAL_PREFERENCES: PersonalPreferences = {
  colorTheme: 'system',
  narrationMode: false,
  showDebugUI: false,
};
