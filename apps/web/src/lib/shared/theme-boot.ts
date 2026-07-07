import {
  DEFAULT_PERSONAL_PREFERENCES,
  isPersonalColorTheme,
  PERSONAL_THEME_STORAGE_KEY,
  type PersonalColorTheme,
} from '@/types/preferences';

type ResolvedPersonalColorTheme = Exclude<PersonalColorTheme, 'system'>;

export function resolveBootColorTheme(
  storedTheme: unknown,
  systemPrefersDark: boolean,
): ResolvedPersonalColorTheme {
  const theme = isPersonalColorTheme(storedTheme)
    ? storedTheme
    : DEFAULT_PERSONAL_PREFERENCES.colorTheme;

  if (theme === 'system') {
    return systemPrefersDark ? 'dark' : 'light';
  }

  return theme;
}

export function getThemeBootScript(): string {
  return `(function(){try{var d=document.documentElement;var t=localStorage.getItem(${JSON.stringify(
    PERSONAL_THEME_STORAGE_KEY,
  )});var r=t==="light"||t==="dark"||t==="system"?t:"system";var c=r==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":r==="system"?"light":r;d.classList.remove("light","dark");d.classList.add(c);d.style.colorScheme=c;}catch(e){}})();`;
}
