import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { cache } from 'react';
import matter from 'gray-matter';

const DOCS_DIRECTORY = resolve(process.cwd(), '..', 'docs');

export type DocsPage = {
  slug: string;
  title: string;
  description?: string;
  icon?: string;
  source: string;
};

function getDocsPath(slug: string) {
  const segments = slug.split('/');
  if (
    !slug ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return null;
  }

  const filePath = resolve(DOCS_DIRECTORY, `${slug}.mdx`);
  return filePath.startsWith(`${DOCS_DIRECTORY}${sep}`) ? filePath : null;
}

export const getDocsPage = cache(
  async (slug: string): Promise<DocsPage | null> => {
    const filePath = getDocsPath(slug);
    if (!filePath) {
      return null;
    }

    try {
      const source = await readFile(filePath, 'utf8');
      const parsed = matter(source);
      const frontmatter = parsed.data as {
        title?: string;
        description?: string;
        icon?: string;
      };

      return {
        slug,
        title: frontmatter.title ?? slug.split('/').at(-1) ?? slug,
        description: frontmatter.description,
        icon: frontmatter.icon,
        source: parsed.content.replace(/^\s*import\s+[\s\S]*?;\s*$/gm, ''),
      };
    } catch {
      return null;
    }
  },
);
