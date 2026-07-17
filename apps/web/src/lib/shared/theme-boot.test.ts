import {
  escapeJsonForJsCode,
  getThemeBootScript,
  resolveBootColorTheme,
} from './theme-boot';
import { PERSONAL_THEME_STORAGE_KEY } from '@/types/preferences';

describe('theme boot helpers', () => {
  it('resolves explicit light and dark values directly', () => {
    expect(resolveBootColorTheme('light', true)).toBe('light');
    expect(resolveBootColorTheme('dark', false)).toBe('dark');
  });

  it('falls back to the system theme when the stored value is missing or invalid', () => {
    expect(resolveBootColorTheme(undefined, true)).toBe('dark');
    expect(resolveBootColorTheme('sepia', false)).toBe('light');
  });

  it('escapes script-breakout characters after JSON.stringify', () => {
    const breakout = JSON.stringify('</script><script>alert(1)//');
    const escaped = escapeJsonForJsCode(breakout);

    expect(escaped).not.toContain('<');
    expect(escaped).not.toContain('>');
    expect(escaped).not.toContain('/');
    expect(JSON.parse(escaped)).toBe('</script><script>alert(1)//');
  });

  it('embeds a script-context-safe storage key that still resolves correctly', () => {
    const script = getThemeBootScript();
    const match = script.match(/localStorage\.getItem\(([\s\S]*?)\);/);
    const embeddedLiteral = match?.[1];

    expect(embeddedLiteral).toBeDefined();
    expect(JSON.parse(embeddedLiteral!)).toBe(PERSONAL_THEME_STORAGE_KEY);
    expect(embeddedLiteral).toBe(
      escapeJsonForJsCode(JSON.stringify(PERSONAL_THEME_STORAGE_KEY)),
    );
    expect(script).toContain('localStorage.getItem(');
  });
});
