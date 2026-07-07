import { visit, SKIP } from 'unist-util-visit';
// `Parent` comes from `unist` instead of `mdast` so the visitor signatures stay
// compatible with third-party `mdast` type augmentations.
import type { Parent } from 'unist';
import type { Root, Link } from 'mdast';

const ARTIFACT_URL_PREFIX = 'https://__artifact__/';

const ARTIFACT_PATH_PATTERN = /^(?:plans|artifacts)\//;

const isAbsoluteUrl = (url: string): boolean =>
  /^(?:https?:\/\/|\/\/|mailto:|tel:)/.test(url);

/**
 * Remark plugin that:
 * 1. Transforms relative artifact URLs (`plans/*`, `artifacts/*`) into absolute
 *    marker URLs (`https://__artifact__/plans/*`) so they survive `rehype-harden`.
 * 2. Converts any remaining non-absolute links (e.g. file paths like `src/foo.ts`)
 *    into plain text nodes so `rehype-harden` doesn't replace them with `[blocked]`.
 *
 * The `__artifact__` domain is a placeholder marker detected by `CustomLink`.
 */
export function remarkArtifactLinks() {
  return (tree: Root) => {
    visit(
      tree,
      'link',
      (node: Link, index: number | undefined, parent: Parent | undefined) => {
        // Transform artifact paths to marker URLs that survive sanitization
        if (ARTIFACT_PATH_PATTERN.test(node.url)) {
          node.url = `${ARTIFACT_URL_PREFIX}${node.url}`;
          return;
        }

        // Absolute URLs are handled fine by rehype-harden, leave them alone
        if (isAbsoluteUrl(node.url)) {
          return;
        }

        // Replace non-absolute, non-artifact links with their text children
        // to prevent rehype-harden from rendering them as [blocked]
        if (parent && index !== undefined) {
          parent.children.splice(index, 1, ...node.children);
          return [SKIP, index] as const;
        }
      },
    );
  };
}
