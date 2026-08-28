'use client';

import { Streamdown } from 'streamdown';
import { createMermaidPlugin } from '@streamdown/mermaid';

import {
  parseArchitectureSnapshot,
  type ArchitectureSnapshot,
} from '@roomote/types';

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
} from '@/components/system';

export const architectureSnapshotMermaidConfig = {
  securityLevel: 'strict',
  suppressErrorRendering: true,
} as const;

const strictMermaidPlugin = createMermaidPlugin({
  config: architectureSnapshotMermaidConfig,
});

function toMermaidMarkdown(source: string): string {
  const longestBacktickRun = Math.max(
    0,
    ...Array.from(source.matchAll(/`+/g), (match) => match[0].length),
  );
  const fence = '`'.repeat(Math.max(3, longestBacktickRun + 1));
  return `${fence}mermaid\n${source}\n${fence}`;
}

function formatSourceLocation(
  source: ArchitectureSnapshot['sources'][number],
): string {
  if (source.lineStart === undefined) return source.path;
  if (source.lineEnd === undefined || source.lineEnd === source.lineStart) {
    return `${source.path}:${source.lineStart}`;
  }
  return `${source.path}:${source.lineStart}-${source.lineEnd}`;
}

export function ArchitectureSnapshotContent({ content }: { content: string }) {
  const snapshot = parseArchitectureSnapshot(content);

  if (!snapshot.success) {
    return (
      <div className="p-6">
        <Alert variant="warning">
          <AlertTitle>Architecture snapshot unavailable</AlertTitle>
          <AlertDescription>
            This generated artifact does not match the supported snapshot
            contract. Inspect the raw JSON or download the artifact instead.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6 text-sm">
      <Alert variant="light">
        <AlertTitle>Generated explanatory evidence</AlertTitle>
        <AlertDescription>
          This snapshot helps review the changed system boundary. It is not
          authoritative architecture documentation.
        </AlertDescription>
      </Alert>

      <section className="space-y-3" aria-labelledby="snapshot-title">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="snapshot-title" className="text-base font-semibold">
            {snapshot.data.title}
          </h2>
          <Badge variant="outline">
            Contract v{snapshot.data.schemaVersion}
          </Badge>
        </div>
        <div className="overflow-x-auto rounded-lg border bg-background p-4">
          <Streamdown plugins={{ mermaid: strictMermaidPlugin }} mode="static">
            {toMermaidMarkdown(snapshot.data.mermaid)}
          </Streamdown>
        </div>
      </section>

      <section className="space-y-3" aria-labelledby="snapshot-sources">
        <h3 id="snapshot-sources" className="font-semibold">
          Source references
        </h3>
        <ul className="divide-y rounded-lg border bg-background">
          {snapshot.data.sources.map((source, index) => (
            <li
              key={`${source.repository}:${source.path}:${source.lineStart ?? ''}:${index}`}
              className="space-y-1 px-4 py-3"
            >
              <div className="text-xs text-muted-foreground">
                {source.repository}
              </div>
              <code className="break-all font-mono text-xs text-foreground">
                {formatSourceLocation(source)}
              </code>
              {source.description ? (
                <p className="text-xs text-muted-foreground">
                  {source.description}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

export { formatSourceLocation, toMermaidMarkdown };
