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
    title: 'Debug production backward',
    description:
      'Ask Roomote to inspect a Sentry issue, deployment logs, or Grafana alert, trace it into the codebase, and prepare the smallest verified fix.',
  },
  {
    title: 'Turn failed CI into a fix',
    description:
      'CI Failure Triage can detect a persistent failure on the default branch, reproduce it in the configured environment, and open a fix PR.',
  },
  {
    title: 'Investigate surprising metrics',
    description:
      'Connect PostHog and ask why a metric moved. Roomote can inspect events, experiments, and feature flags, then trace likely causes into the code.',
  },
  {
    title: 'Debug with real database state',
    description:
      'Use read-only Supabase or Neon access to investigate data-dependent bugs, compare the live schema with application assumptions, and plan a safe fix.',
  },
  {
    title: 'Build directly from the spec',
    description:
      'Point Roomote at a Notion spec or Linear issue and ask it to trace affected code, identify missing decisions, implement the change, and link the PR back.',
  },
  {
    title: 'Turn support into engineering work',
    description:
      'Auto-respond in a support or bug channel so new reports become repository-grounded investigations—even when nobody explicitly mentions Roomote.',
  },
  {
    title: 'Triage issues as they arrive',
    description:
      'Roomote can investigate each newly opened issue and post a concrete implementation plan with the relevant code paths before anyone picks it up.',
  },
  {
    title: 'Keep old PRs mergeable',
    description:
      'Label selected pull requests for automatic conflict resolution. Roomote periodically rebases the work, resolves safe conflicts, and updates the branch.',
  },
  {
    title: 'Audit what just shipped',
    description:
      'Run security and code-quality auditors over recently merged PRs to surface high-confidence risks and maintainability problems as follow-up work.',
  },
  {
    title: 'Schedule repository-aware work',
    description:
      'Create recurring tasks such as release-readiness checks, dependency audits, or weekly product reports that can inspect your code and connected tools.',
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

    const durationMs = getTipDisplayDurationMs(tip);

    const timer = window.setTimeout(() => {
      setTipIndex((currentIndex) => (currentIndex + 1) % tips.length);
    }, durationMs);

    return () => {
      window.clearTimeout(timer);
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
