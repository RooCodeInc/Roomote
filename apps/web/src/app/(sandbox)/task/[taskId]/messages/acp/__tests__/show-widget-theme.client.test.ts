import {
  getShowWidgetHostThemeKey,
  readShowWidgetHostTheme,
} from '../show-widget-theme';

describe('show widget host theme', () => {
  it('copies Roomote host tokens and its selected color scheme', () => {
    const host = document.createElement('div');
    host.className = 'dark';
    host.style.setProperty('--background', '#101010');
    host.style.setProperty('--card', '#080808');
    host.style.setProperty('--foreground', '#fefefe');
    host.style.setProperty('--accent-foreground', '#d8fb2b');
    document.body.append(host);

    const theme = readShowWidgetHostTheme(host);

    expect(theme).toMatchObject({
      colorScheme: 'dark',
      background: '#101010',
      surface: '#080808',
      text: '#fefefe',
      accent: '#d8fb2b',
    });

    host.remove();
  });

  it('changes the iframe identity when any resolved token changes', () => {
    const host = document.createElement('div');
    host.style.setProperty('--card', '#ffffff');
    document.body.append(host);

    const firstTheme = readShowWidgetHostTheme(host);
    host.style.setProperty('--card', '#f5f5f5');
    const secondTheme = readShowWidgetHostTheme(host);

    expect(getShowWidgetHostThemeKey(firstTheme)).not.toBe(
      getShowWidgetHostThemeKey(secondTheme),
    );

    host.remove();
  });
});
