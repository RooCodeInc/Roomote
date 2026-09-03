import { compileMDX } from 'next-mdx-remote/rsc';
import remarkGfm from 'remark-gfm';
import { getDocsPage } from '@/lib/docs-content';

import { docsMdxComponents } from './DocsMdx';
import SetupPageClient from './SetupPageClient';
import { getSetupDocsPath, getSetupDocsStep } from './setup-docs';

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{
    authProvider?: string;
    modelProvider?: string;
    step?: string;
  }>;
}) {
  const params = await searchParams;
  const setupDocsStep = getSetupDocsStep(params.step ?? null);
  const docsPath = getSetupDocsPath(setupDocsStep, {
    authProvider: params.authProvider,
    modelProvider: params.modelProvider,
  });
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
