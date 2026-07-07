'use client';

import { useEffect } from 'react';
import { SETTINGS_PATHS } from '@/lib/settings';

export default function BackgroundAgentsShortcutPage() {
  useEffect(() => {
    const { hash, search } = window.location;
    window.location.replace(`${SETTINGS_PATHS.automations}${search}${hash}`);
  }, []);

  return null;
}
