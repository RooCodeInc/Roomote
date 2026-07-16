'use client';

import { PRODUCT_NAME } from '@roomote/types';

import { Button, CornerDownLeftIcon, InfoTooltip } from '@/components/system';

interface DraftPromptBannerProps {
  draftPrompt: string;
  onClick?: () => void;
  embedded?: boolean;
}

export function DraftPromptBanner({
  draftPrompt,
  onClick,
  embedded = false,
}: DraftPromptBannerProps) {
  const interactive = !!onClick;

  const banner = (
    <div className="mx-auto w-full max-w-4xl px-4 pb-5 pt-4">
      <div
        className={`flex gap-3 items-start ${interactive ? 'cursor-pointer hover:opacity-50' : ''}`}
        role={interactive ? 'button' : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={onClick}
        onKeyDown={
          interactive
            ? (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  onClick();
                }
              }
            : undefined
        }
      >
        <div className="resize-none font-mono rounded-xl text-sm text-muted-foreground opacity-70 pointer-events-none">
          {draftPrompt}
        </div>
        {interactive && (
          <InfoTooltip
            iconClassName="mt-1 size-3.5 shrink-0"
            content={`${PRODUCT_NAME} is asleep. Wake it up to keep chatting`}
          />
        )}
        <Button
          size="icon"
          variant="default"
          className="ml-auto"
          disabled
          aria-label="Submit"
          tabIndex={-1}
        >
          <CornerDownLeftIcon className="size-4" />
        </Button>
      </div>
    </div>
  );

  return embedded ? banner : <div className="border-t">{banner}</div>;
}
