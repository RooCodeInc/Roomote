import { getAppIcons } from '../app-icons';

describe('getAppIcons', () => {
  it('returns the dev favicon in development', () => {
    expect(getAppIcons('development')).toEqual([
      { rel: 'apple-touch-icon', url: '/apple-touch-icon-dev.png' },
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
    ]);
  });

  it('returns the preview favicon set in preview', () => {
    expect(getAppIcons('preview')).toEqual([
      {
        rel: 'apple-touch-icon',
        url: '/apple-touch-icon-preview.png',
      },
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
      { rel: 'icon', url: '/favicon-preview.ico' },
    ]);
  });

  it('returns the production favicon set in production', () => {
    expect(getAppIcons('production')).toEqual([
      { rel: 'apple-touch-icon', url: '/apple-touch-icon.png' },
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
      { rel: 'icon', url: '/favicon.ico' },
    ]);
  });
});
