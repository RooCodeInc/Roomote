import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { DM_Sans } from 'next/font/google';

import { PRODUCT_NAME } from '@roomote/types';

import { RootProviders } from '@/components/layout/RootProviders';
import { RouteTitle } from '@/components/layout/RouteTitle';
import { getAppIcons } from '@/lib/app-icons';
import { resolveAppEnv } from '@/lib/app-env';
import { Env, isRoomoteCloudEnabled } from '@/lib/server/env';
import { authorize } from '@/lib/server/auth-context';
import { isSetupBootstrapOpen } from '@/lib/server/setup-bootstrap';
import { getThemeBootScript } from '@/lib/shared/theme-boot';
import type { AuthorizedUser } from '@/types';

import './globals.css';

export const dynamic = 'force-dynamic';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
};

export async function generateMetadata(): Promise<Metadata> {
  const appEnv = resolveAppEnv(
    process.env,
    process.env.NODE_ENV === 'development' ? 'development' : 'production',
  );

  return {
    title: PRODUCT_NAME,
    description: `Cloud management for ${PRODUCT_NAME}.`,
    formatDetection: {
      telephone: false,
    },
    icons: getAppIcons(appEnv),
  };
}

const fontSans = DM_Sans({
  variable: '--font-sans',
  subsets: ['latin'],
  fallback: [
    'Inter',
    'ui-sans-serif',
    'system-ui',
    '-apple-system',
    'BlinkMacSystemFont',
    'Segoe UI',
    'Roboto',
    'Helvetica Neue',
    'Arial',
    'sans-serif',
  ],
});

const fontMono = localFont({
  variable: '--font-mono',
  src: [
    {
      path: './fonts/monaspace-neon-latin-400-normal.woff2',
      weight: '400',
      style: 'normal',
    },
    {
      path: './fonts/monaspace-neon-latin-500-normal.woff2',
      weight: '500',
      style: 'normal',
    },
    {
      path: './fonts/monaspace-neon-latin-700-normal.woff2',
      weight: '700',
      style: 'normal',
    },
  ],
  fallback: [
    'ui-monospace',
    'SFMono-Regular',
    'Menlo',
    'Monaco',
    'Consolas',
    'Liberation Mono',
    'Courier New',
    'monospace',
  ],
});

function serializeAuthorizedUser(user: AuthorizedUser): AuthorizedUser {
  return {
    ...user,
    resource: {
      ...user.resource,
      createdAt:
        user.resource.createdAt instanceof Date
          ? user.resource.createdAt.getTime()
          : user.resource.createdAt,
    },
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const [auth, setupBootstrapOpen] = await Promise.all([
    authorize(),
    isSetupBootstrapOpen(),
  ]);
  const authUser = auth.success ? serializeAuthorizedUser(auth) : null;
  const authStatus = auth.success ? 'signed-in' : 'signed-out';

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Must run synchronously before first paint: App Router queues
            inline beforeInteractive Scripts until client bootstrap, which
            flashes the wrong theme. */}
        <script dangerouslySetInnerHTML={{ __html: getThemeBootScript() }} />
      </head>
      <body
        className={`${fontSans.variable} ${fontMono.variable} font-sans antialiased`}
      >
        <RouteTitle />
        <RootProviders
          authStatus={authStatus}
          authUser={authUser}
          cloudEnabled={isRoomoteCloudEnabled(Env.R_CLOUD_ENABLED)}
          intercomAppId={Env.R_INTERCOM_APP_ID}
          posthogProjectKey={Env.R_POSTHOG_PROJECT_KEY}
          posthogHost={Env.R_POSTHOG_HOST}
          setupBootstrapOpen={setupBootstrapOpen}
        >
          {children}
        </RootProviders>
      </body>
    </html>
  );
}
