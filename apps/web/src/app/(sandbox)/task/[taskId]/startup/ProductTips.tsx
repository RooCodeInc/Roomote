'use client';

import { useEffect, useRef, useState } from 'react';

import {
  ArrowRight,
  BasicTooltip,
  Button,
  Lightbulb,
  X,
} from '@/components/system';
import { Message, MessageContent } from '@/components/ai-elements';

const PRODUCT_TIPS_DISMISSED_STORAGE_KEY = 'roomote:product-tips-dismissed:v1';

const MIN_TIP_DURATION_MS = 8_000;
const MAX_TIP_DURATION_MS = 15_000;
const READING_CHARS_PER_SECOND = 10;

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
  const [secondsUntilNextTip, setSecondsUntilNextTip] = useState(0);

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

    const durationMs = getTipDisplayDurationMs(tip);
    const startedAt = Date.now();

    setSecondsUntilNextTip(Math.ceil(durationMs / 1_000));

    const timer = window.setTimeout(() => {
      setTipIndex((currentIndex) => (currentIndex + 1) % tips.length);
    }, durationMs);
    const countdown = window.setInterval(() => {
      setSecondsUntilNextTip(
        Math.max(0, Math.ceil((durationMs - (Date.now() - startedAt)) / 1_000)),
      );
    }, 1_000);

    return () => {
      window.clearTimeout(timer);
      window.clearInterval(countdown);
    };
  }, [tipIndex, tips]);

  const tip = tips[tipIndex];

  if (!tip) {
    return null;
  }

  const dismiss = () => {
    window.localStorage.setItem(PRODUCT_TIPS_DISMISSED_STORAGE_KEY, '1');
    setTips([]);
  };

  const showNextTip = () => {
    setTipIndex((currentIndex) => (currentIndex + 1) % tips.length);
  };

  const durationMs = getTipDisplayDurationMs(tip);
  const totalSeconds = Math.ceil(durationMs / 1_000);

  return (
    <Message from="assistant">
      <MessageContent>
        <div className="relative flex gap-3 rounded-xl bg-card p-6 pr-10 text-sm mt-8">
          <Lightbulb className="mt-0.5 size-6 shrink-0 text-muted-foreground enter-up" />
          <div
            key={tip.title}
            className="min-w-0 animate-in fade-in duration-1000 space-y-1"
          >
            <div className="font-semibold">{tip.title}</div>
            <div className="text-muted-foreground max-w-xl">
              {tip.description}
            </div>
            <Button
              type="button"
              variant="default"
              size="xs"
              className="relative mt-3 overflow-hidden"
              onClick={showNextTip}
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-y-0 left-0 bg-card/35"
                style={{
                  animation: `product-tip-progress ${totalSeconds}s linear forwards`,
                }}
              />
              <span className="relative z-10 flex gap-1 items-center">
                Next tip <ArrowRight />
              </span>
            </Button>
          </div>
          <BasicTooltip content="Stop showing these">
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
          </BasicTooltip>
        </div>
        <style>{`
          @keyframes product-tip-progress {
            from { width: 0%; }
            to { width: 100%; }
          }
        `}</style>
      </MessageContent>
    </Message>
  );
}
