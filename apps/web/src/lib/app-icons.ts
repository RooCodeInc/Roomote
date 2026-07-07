import type { Metadata } from 'next';

import type { AppEnv } from '@/lib/app-env';

const APPLE_TOUCH_ICON = {
  rel: 'apple-touch-icon',
  url: '/apple-touch-icon.png',
} as const;

const DEV_APPLE_TOUCH_ICON = {
  rel: 'apple-touch-icon',
  url: '/apple-touch-icon-dev.png',
} as const;

const PREVIEW_APPLE_TOUCH_ICON = {
  rel: 'apple-touch-icon',
  url: '/apple-touch-icon-preview.png',
} as const;

const DEV_FAVICONS = [
  {
    rel: 'icon',
    type: 'image/png',
    sizes: '32x32',
    url: '/favicon-dev-32x32.png',
  },
  {
    rel: 'icon',
    type: 'image/png',
    sizes: '16x16',
    url: '/favicon-dev-16x16.png',
  },
  {
    rel: 'icon',
    url: '/favicon-dev.ico',
  },
] as const;

const PREVIEW_FAVICONS = [
  {
    rel: 'icon',
    type: 'image/png',
    sizes: '32x32',
    url: '/favicon-preview-32x32.png',
  },
  {
    rel: 'icon',
    type: 'image/png',
    sizes: '16x16',
    url: '/favicon-preview-16x16.png',
  },
  {
    rel: 'icon',
    url: '/favicon-preview.ico',
  },
] as const;

const PRODUCTION_FAVICONS = [
  {
    rel: 'icon',
    type: 'image/png',
    sizes: '32x32',
    url: '/favicon-32x32.png',
  },
  {
    rel: 'icon',
    type: 'image/png',
    sizes: '16x16',
    url: '/favicon-16x16.png',
  },
  {
    rel: 'icon',
    url: '/favicon.ico',
  },
] as const;

export function getAppIcons(appEnv: AppEnv): Metadata['icons'] {
  switch (appEnv) {
    case 'development':
      return [DEV_APPLE_TOUCH_ICON, ...DEV_FAVICONS];
    case 'preview':
      return [PREVIEW_APPLE_TOUCH_ICON, ...PREVIEW_FAVICONS];
    case 'production':
      return [APPLE_TOUCH_ICON, ...PRODUCTION_FAVICONS];
  }
}
