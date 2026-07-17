import {
  DEFAULT_PERSONAL_PREFERENCES,
  isPersonalColorTheme,
  PERSONAL_THEME_STORAGE_KEY,
  type PersonalColorTheme,
} from '@/types/preferences';

type ResolvedPersonalColorTheme = Exclude<PersonalColorTheme, 'system'>;

const UNSAFE_JS_CODE_CHARS: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\0': '\\0',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

export function escapeJsonForJsCode(json: string): string {
  return json.replace(
    /[<>/\b\f\n\r\t\0\u2028\u2029]/g,
    (ch) => UNSAFE_JS_CODE_CHARS[ch] ?? ch,
  );
}

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
  const storageKeyLiteral = escapeJsonForJsCode(
    JSON.stringify(PERSONAL_THEME_STORAGE_KEY),
  );
  return `(function(){try{var d=document.documentElement;var t=localStorage.getItem(${storageKeyLiteral});var r=t==="light"||t==="dark"||t==="system"?t:"system";var c=r==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":r==="system"?"light":r;d.classList.remove("light","dark");d.classList.add(c);d.style.colorScheme=c;}catch(e){}})();`;
}
