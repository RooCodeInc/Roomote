'use client';

import { useEffect } from 'react';

import { PRODUCT_NAME } from '@roomote/types';

const BASE_TITLE = PRODUCT_NAME;

/**
 * A global flag shared across all hook instances so only the very first
 * mount in the page lifecycle uses the MutationObserver workaround.
 */
let hydrationHandled = false;

/**
 * Sets `document.title` to `"<title> | <base>"`.
 *
 * On the first mount after hydration, uses a MutationObserver to wait for
 * Next.js metadata hydration to finish before overriding the title.
 *
 * @param title - The page-specific portion of the title (e.g. "History", "Task #42").
 *   Pass `null` or `undefined` to skip setting the title (useful when data is still loading).
 *
 * @example
 * // Static title
 * usePageTitle("Settings");
 *
 * @example
 * // Dynamic title — pass null while loading to avoid a flash of "null | Roomote"
 * const { data } = trpc.tasks.get.useQuery({ id });
 * usePageTitle(data ? `Task: ${data.name}` : null);
 */
export function usePageTitle(title: string | null | undefined) {
  useEffect(() => {
    if (title == null) {
      return;
    }

    const fullTitle = `${title} | ${BASE_TITLE}`;

    if (!hydrationHandled) {
      hydrationHandled = true;

      // On first mount, Next.js metadata hydration overwrites document.title.
      // Watch for that mutation and override once it happens.
      const titleElement = document.querySelector('title');

      if (titleElement) {
        const observer = new MutationObserver(() => {
          observer.disconnect();
          document.title = fullTitle;
        });

        observer.observe(titleElement, {
          childList: true,
          characterData: true,
          subtree: true,
        });

        // Fallback if the mutation already fired or never fires.
        const fallbackTimeout = setTimeout(() => {
          observer.disconnect();
          document.title = fullTitle;
        }, 2_000);

        return () => {
          observer.disconnect();
          clearTimeout(fallbackTimeout);
        };
      }
    }

    document.title = fullTitle;
  }, [title]);
}
