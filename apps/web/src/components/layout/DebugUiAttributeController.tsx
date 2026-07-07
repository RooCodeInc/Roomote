'use client';

import { useEffect } from 'react';

import { useShowDebugUI } from '@/hooks/useShowDebugUI';

const DEBUG_UI_ATTRIBUTE = 'data-debug-ui';

export function DebugUiAttributeController() {
  const { isDebugUIVisible } = useShowDebugUI();

  useEffect(() => {
    const root = document.documentElement;

    if (isDebugUIVisible) {
      root.setAttribute(DEBUG_UI_ATTRIBUTE, 'true');
      return () => {
        root.removeAttribute(DEBUG_UI_ATTRIBUTE);
      };
    }

    root.removeAttribute(DEBUG_UI_ATTRIBUTE);
    return () => {
      root.removeAttribute(DEBUG_UI_ATTRIBUTE);
    };
  }, [isDebugUIVisible]);

  return null;
}
