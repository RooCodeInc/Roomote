import { useMemo, type RefObject } from 'react';

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockDiff,
  CodeBlockDiffContent,
  CodeBlockHeader,
  CodeBlockTitle,
} from '@/components/ai-elements';

import { type FileDiff } from '../../hooks';
import { LazyViewportItem } from '../../LazyViewportItem';

import { inferLanguageFromPath, toDiffLines } from './utils';

const DIFF_VIEWPORT_MARGIN = '1200px 0px';
const DIFF_COLLAPSE_DELAY_MS = 150;
const DIFF_LINE_HEIGHT_PX = 17;
const DIFF_BLOCK_BASE_HEIGHT_PX = 48;

function estimateDiffBlockHeight(file: FileDiff) {
  return (
    DIFF_BLOCK_BASE_HEIGHT_PX +
    Math.max(file.lines.length, 1) * DIFF_LINE_HEIGHT_PX
  );
}

function FileDiffBlockContent({ file }: { file: FileDiff }) {
  const diffLines = useMemo(() => toDiffLines(file), [file]);
  const language = useMemo(() => inferLanguageFromPath(file.path), [file.path]);
  const code = useMemo(
    () => diffLines.map((l) => l.content).join('\n'),
    [diffLines],
  );

  if (diffLines.length === 0) return null;

  return (
    <CodeBlock
      code={code}
      language={language}
      collapsible
      renderContent={false}
      className="text-[0.8em]"
    >
      <CodeBlockHeader>
        <CodeBlockTitle>
          <CodeBlockDiff
            path={file.path}
            additions={file.additions}
            deletions={file.deletions}
          />
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockDiffContent lines={diffLines} language={language} />
    </CodeBlock>
  );
}

export function FileDiffBlock({
  file,
  id,
  rootRef,
  defaultVisible = false,
}: {
  file: FileDiff;
  id: string;
  rootRef: RefObject<HTMLDivElement | null>;
  defaultVisible?: boolean;
}) {
  const estimatedHeight = useMemo(() => estimateDiffBlockHeight(file), [file]);

  return (
    <LazyViewportItem
      anchorId={id}
      rootRef={rootRef}
      rootMargin={DIFF_VIEWPORT_MARGIN}
      collapseDelayMs={DIFF_COLLAPSE_DELAY_MS}
      estimatedHeight={estimatedHeight}
      defaultVisible={defaultVisible}
    >
      <FileDiffBlockContent file={file} />
    </LazyViewportItem>
  );
}
