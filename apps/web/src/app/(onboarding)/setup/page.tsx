import { compileMDX } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import { getDocsPage } from '@/lib/docs-content';

import { docsMdxComponents } from './DocsMdx';
import SetupPageClient from './SetupPageClient';
import { getSetupDocsPath, getSetupDocsStep } from './setup-docs';

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ step?: string }>;
}) {
  const setupDocsStep = getSetupDocsStep((await searchParams).step ?? null);
  const docsPath = getSetupDocsPath(setupDocsStep);
  const docsPage = docsPath ? await getDocsPage(docsPath) : null;
  const { content } = docsPage
    ? await compileMDX({
        source: docsPage.source,
        components: docsMdxComponents,
        options: { mdxOptions: { remarkPlugins: [remarkGfm] } },
      })
    : { content: null };

  const setupDocsContent = docsPage ? (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">
        {docsPage.title}
      </h1>
      {docsPage.description ? (
        <p className="mt-2 text-muted-foreground">{docsPage.description}</p>
      ) : null}
      {content}
    </>
  ) : null;

  return <SetupPageClient setupDocsContent={setupDocsContent} />;
}
