import { getThemeBootScript, resolveBootColorTheme } from './theme-boot';

describe('theme boot helpers', () => {
  it('resolves explicit light and dark values directly', () => {
    expect(resolveBootColorTheme('light', true)).toBe('light');
    expect(resolveBootColorTheme('dark', false)).toBe('dark');
  });

  it('falls back to the system theme when the stored value is missing or invalid', () => {
    expect(resolveBootColorTheme(undefined, true)).toBe('dark');
    expect(resolveBootColorTheme('sepia', false)).toBe('light');
  });

  it('includes the Roomote storage key in the bootstrap script', () => {
    expect(getThemeBootScript()).toContain('roomote-color-theme');
  });
});
