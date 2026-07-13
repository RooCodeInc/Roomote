import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

import {
  getAllowedDevOrigins,
  getWebBundledEnvFilePaths,
  resolveAppEnv,
} from './src/lib/server/env';

const appEnv = resolveAppEnv(process.env, 'production');
const webEnvFiles = getWebBundledEnvFilePaths(appEnv);
const sentryRelease =
  process.env.VERCEL_GIT_COMMIT_SHA?.trim() ||
  process.env.GITHUB_SHA?.trim() ||
  process.env.VERCEL_DEPLOYMENT_ID?.trim() ||
  process.env.RELEASE_VERSION?.trim() ||
  undefined;
const canUploadSentrySourceMaps =
  Boolean(process.env.SENTRY_AUTH_TOKEN?.trim()) && Boolean(sentryRelease);

const nextConfig: NextConfig = {
  // Emit a self-contained server for the Docker runtime image; dev and
  // non-container builds are unaffected.
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_SENTRY_RELEASE: sentryRelease ?? '',
  },
  serverExternalPackages: [
    'pino',
    'pino-pretty',
    'bullmq',
    'ioredis',
    'postgres',
  ],
  // Always bundle the env files the runtime may need so preview deploys can
  // load preview secrets even when build-time env detection resolves differently.
  outputFileTracingIncludes: {
    '/*': webEnvFiles,
  },
  experimental: {
    serverActions: {
      bodySizeLimit: '20mb', // Increase body size limit for image uploads.
    },
  },
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'avatars.slack-edge.com',
      },
      {
        protocol: 'https',
        hostname: 'secure.gravatar.com',
      },
      {
        // Microsoft Entra sign-in avatars (Teams deployments).
        protocol: 'https',
        hostname: 'graph.microsoft.com',
      },
    ],
  },
  devIndicators: false,
  // When running inside a sandbox, R_PREVIEW_DOMAINS lists the base domains
  // used by preview-proxy (e.g. "preview-john.ngrok.app"). HMR WebSocket
  // connections arrive with Origin set to the full preview subdomain
  // (e.g. "taskid-web.preview-john.ngrok.app"), so we need *.domain entries.
  allowedDevOrigins: getAllowedDevOrigins(process.env.R_PREVIEW_DOMAINS),
  async redirects() {
    // Public product docs now live at the standalone Mintlify site
    // (https://docs.roomote.dev). Preserve old in-app /docs URLs by
    // redirecting them to the external docs site.
    return [
      {
        source: '/docs',
        destination: 'https://docs.roomote.dev',
        permanent: true,
      },
      {
        source: '/docs/:path*',
        destination: 'https://docs.roomote.dev/:path*',
        permanent: true,
      },
    ];
  },
  async headers() {
    return [
      {
        // Apply CORS headers to cloud agent icons
        source: '/cloud-agents/icons/:path*',
        headers: [
          {
            key: 'Access-Control-Allow-Origin',
            value: '*', // Allow all origins. You can restrict this to specific domains if needed
          },
          {
            key: 'Access-Control-Allow-Methods',
            value: 'GET, OPTIONS',
          },
          {
            key: 'Access-Control-Allow-Headers',
            value: 'Content-Type',
          },
          {
            key: 'Cache-Control',
            value: 'public, max-age=31536000, immutable', // Cache icons for 1 year since they rarely change
          },
        ],
      },
    ];
  },
  // turbopack.root is auto-detected from pnpm-lock.yaml at the monorepo root
};

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://github.com/getsentry/sentry-webpack-plugin#options
  org: 'roomote',
  project: 'roomote',

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,
  useRunAfterProductionCompileHook: canUploadSentrySourceMaps,
  sourcemaps: {
    disable: !canUploadSentrySourceMaps,
  },
  release: {
    create: canUploadSentrySourceMaps,
    name: sentryRelease,
  },

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: '/monitoring',

  // Hides source maps from generated client bundles
  // hideSourceMaps: true,

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Automatically tree-shake Sentry logger statements to reduce bundle size
    treeshake: {
      removeDebugLogging: true,
    },
  },

  // Disable Sentry telemetry
  telemetry: false,
});
