import type { Metadata } from 'next';

export const getBaseUrl = () => {
  if (process.env.NEXT_PUBLIC_APP_URL) {
    return process.env.NEXT_PUBLIC_APP_URL;
  }

  return 'http://localhost:3000';
};

/**
 * Static page title + description for link previews and browser tabs.
 * Intentionally omits Open Graph / Twitter images.
 */
export function createPageMetadata({
  title,
  description,
}: {
  title: string;
  description: string;
}): Metadata {
  return {
    title,
    description,
    openGraph: {
      title,
      description,
    },
    twitter: {
      title,
      description,
    },
  };
}

export const PAGE_METADATA = {
  task: createPageMetadata({
    title: 'Roomote Task',
    description: 'View and continue a Roomote task.',
  }),
  settings: createPageMetadata({
    title: 'Roomote Settings',
    description: 'Manage settings for this Roomote deployment.',
  }),
  taskHistory: createPageMetadata({
    title: 'Roomote Task History',
    description: 'Browse past Roomote tasks.',
  }),
  logIn: createPageMetadata({
    title: 'Roomote Log In',
    description: 'Sign in to your Roomote account.',
  }),
  invite: createPageMetadata({
    title: 'Roomote Invitation',
    description: "You've been invited to join this Roomote deployment.",
  }),
  setup: createPageMetadata({
    title: 'Roomote Setup',
    description: 'Set up this Roomote deployment.',
  }),
  onboarding: createPageMetadata({
    title: 'Roomote Onboarding',
    description: 'Finish onboarding and start using Roomote.',
  }),
} as const;
