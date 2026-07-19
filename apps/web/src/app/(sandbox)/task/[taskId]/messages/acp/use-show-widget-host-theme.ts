import { useLayoutEffect, useRef, useState } from 'react';

import {
  getShowWidgetHostThemeKey,
  readShowWidgetHostTheme,
  type ShowWidgetHostTheme,
} from './show-widget-theme';

/**
 * Bridge the task view's selected theme into an isolated widget iframe.
 * Watching only the host theme attributes keeps the bridge narrow and lets
 * Storybook exercise the same behavior as the application.
 */
export function useShowWidgetHostTheme() {
  const hostRef = useRef<HTMLDivElement>(null);
  const [hostTheme, setHostTheme] = useState<ShowWidgetHostTheme | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const syncTheme = () => {
      const nextTheme = readShowWidgetHostTheme(host);
      setHostTheme((currentTheme) =>
        currentTheme &&
        getShowWidgetHostThemeKey(currentTheme) ===
          getShowWidgetHostThemeKey(nextTheme)
          ? currentTheme
          : nextTheme,
      );
    };
    const observer = new MutationObserver(syncTheme);

    syncTheme();
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    });

    return () => observer.disconnect();
  }, []);

  return {
    hostRef,
    hostTheme,
    hostThemeKey: hostTheme ? getShowWidgetHostThemeKey(hostTheme) : 'initial',
  };
}
