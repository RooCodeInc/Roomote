import {
  formatHunkRange,
  REVIEW_PRESCREEN_AREA_LABELS,
  screenReviewHunks,
  type ReviewPrescreenHint,
} from './workflows/githubPrReviewPrescreen';

/** Bounds what a sandbox may send; the pre-screen caps its own input again. */
export const DIFF_RISK_HINTS_MAX_DIFF_CHARS = 400_000;

const CHANGED_FILE_PATTERN = /^diff --git a\/(.+?) b\//gmu;

type DiffRiskHintsResult =
  | { available: true; hints: ReviewPrescreenHint[]; text: string }
  | { available: false; reason: string };

/**
 * The pull request review pre-screen, run on an agent's own diff before it
 * ships: the changed hunks the decision model ranks most likely to contain a
 * defect. Advisory only. Nothing is held or blocked; the agent reads the hints
 * as questions during its self-review, and the pull request still gets its
 * full review.
 */
export async function screenDiffRiskHints(input: {
  title?: string | null;
  diff: string;
}): Promise<DiffRiskHintsResult> {
  const changedFiles = [
    ...new Set(
      [...input.diff.matchAll(CHANGED_FILE_PATTERN)].map((m) => m[1]!),
    ),
  ];
  let hints: ReviewPrescreenHint[] | undefined;

  try {
    hints = await screenReviewHunks({
      title: input.title,
      changedFiles,
      diff: input.diff,
    });
  } catch (error) {
    // Advisory: a judgment-model failure must never become a tool error.
    console.warn(
      `[DiffRiskHints] Pre-screen failed; returning no hints. ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return {
      available: false,
      reason:
        'The risk pre-screen is unavailable right now. Continue without it.',
    };
  }

  if (!hints) {
    return {
      available: false,
      reason:
        'No risk hints: either this deployment has no hosted judgment model or the diff has no reviewable code.',
    };
  }

  return {
    available: true,
    hints,
    text: formatDiffRiskHintsForAuthor(hints),
  };
}

function formatDiffRiskHintsForAuthor(
  hints: readonly ReviewPrescreenHint[],
): string {
  if (hints.length === 0) {
    return 'The pre-screen flagged no hunks. It misses about half of real defects, so this does not clear the change.';
  }

  return [
    'These changed hunks ranked most likely to contain a defect. Re-read each one before you ship:',
    ...hints.map(
      (hint) =>
        `- \`${hint.file}\` ${formatHunkRange(hint)} (\`${hint.header}\`)${hint.area ? `: possible ${REVIEW_PRESCREEN_AREA_LABELS[hint.area]} issue` : ''}.`,
    ),
    'Each line is a question, not a finding. Fix what the code confirms, leave the rest. The pre-screen misses about half of real defects, so it does not clear unflagged code.',
  ].join('\n');
}
