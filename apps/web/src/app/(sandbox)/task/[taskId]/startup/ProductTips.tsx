'use client';

import { useEffect, useRef, useState } from 'react';

import { Button, Lightbulb, X } from '@/components/system';
import { Message, MessageContent } from '@/components/ai-elements';

const PRODUCT_TIPS_DISMISSED_STORAGE_KEY = 'roomote:product-tips-dismissed:v1';

const MIN_TIP_DURATION_MS = 8_000;
const MAX_TIP_DURATION_MS = 15_000;
const READING_CHARS_PER_SECOND = 16;

export const PRODUCT_TIPS = [
  {
    title: 'Start from anywhere',
    description:
      'Kick off and continue tasks from connected tools like Slack, Teams, or GitHub. For example, mention Roomote in a bug thread to turn the conversation into a task.',
  },
  {
    title: 'Share visual context',
    description:
      'Attach screenshots or recordings when the details are easier to show than explain. For example, include a checkout error and ask Roomote to reproduce and fix it.',
  },
  {
    title: 'Plan before building',
    description:
      'Ask for a repository-grounded plan when a change still has open product or architecture decisions. For example, map a new permissions flow before implementation starts.',
  },
  {
    title: 'Inspect changes live',
    description:
      'Use the task view to follow progress, open the diff, and preview UI work while the agent runs. For example, review a responsive page before the pull request is ready.',
  },
  {
    title: 'Continue the conversation',
    description:
      'Follow up on a task with corrections or extra context instead of starting over. For example, ask Roomote to tighten a validation rule after reviewing the first pass.',
  },
] as const;

type ProductTip = (typeof PRODUCT_TIPS)[number];

export function getTipDisplayDurationMs(tip: ProductTip): number {
  const readingTime =
    Math.ceil(
      `${tip.title} ${tip.description}`.length / READING_CHARS_PER_SECOND,
    ) * 1_000;

  return Math.min(
    MAX_TIP_DURATION_MS,
    Math.max(MIN_TIP_DURATION_MS, readingTime),
  );
}

function shuffleTips(): ProductTip[] {
  const tips = [...PRODUCT_TIPS];

  for (let index = tips.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [tips[index], tips[swapIndex]] = [tips[swapIndex]!, tips[index]!];
  }

  return tips;
}

export function ProductTips() {
  const initialized = useRef(false);
  const [tips, setTips] = useState<ProductTip[]>([]);
  const [tipIndex, setTipIndex] = useState(0);

  useEffect(() => {
    if (initialized.current) {
      return;
    }

    initialized.current = true;

    if (
      window.localStorage.getItem(PRODUCT_TIPS_DISMISSED_STORAGE_KEY) === '1'
    ) {
      return;
    }

    setTips(shuffleTips());
  }, []);

  useEffect(() => {
    const tip = tips[tipIndex];

    if (!tip || tips.length < 2) {
      return;
    }

    const timer = window.setTimeout(() => {
      setTipIndex((currentIndex) => (currentIndex + 1) % tips.length);
    }, getTipDisplayDurationMs(tip));

    return () => window.clearTimeout(timer);
  }, [tipIndex, tips]);

  const tip = tips[tipIndex];

  if (!tip) {
    return null;
  }

  const dismiss = () => {
    window.localStorage.setItem(PRODUCT_TIPS_DISMISSED_STORAGE_KEY, '1');
    setTips([]);
  };

  return (
    <Message from="assistant">
      <MessageContent>
        <div className="relative flex max-w-2xl gap-3 rounded-lg border border-border/60 px-3 py-2 pr-10 text-sm">
          <Lightbulb className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div
            key={tip.title}
            className="min-w-0 animate-in fade-in duration-300"
          >
            <div className="font-semibold">{tip.title}</div>
            <div className="text-muted-foreground">{tip.description}</div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="absolute right-1 top-1"
            aria-label="Hide product tips"
            onClick={dismiss}
          >
            <X />
          </Button>
        </div>
      </MessageContent>
    </Message>
  );
}
