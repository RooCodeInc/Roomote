import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFilePath = fileURLToPath(import.meta.url);
const thisDirPath = path.dirname(thisFilePath);

function readSkill(relativePath: string) {
  return fs.readFileSync(path.resolve(thisDirPath, relativePath), 'utf8');
}

function readAppendix(skillContent: string, appendixName: string) {
  const startMarker = `<appendix name="${appendixName}"`;
  const startIndex = skillContent.indexOf(startMarker);
  if (startIndex === -1) {
    throw new Error(`Could not find appendix ${appendixName}`);
  }

  const endIndex = skillContent.indexOf('\n  </appendix>', startIndex);
  if (endIndex === -1) {
    throw new Error(`Could not find end of appendix ${appendixName}`);
  }

  return skillContent.slice(startIndex, endIndex);
}

function expectAppendixIgnoresCi(
  appendix: string,
  summaryTitleMarker: string,
  reviewInstruction: string,
  commentInstruction: string,
) {
  expect(appendix).toContain(summaryTitleMarker);
  expect(appendix).toContain(reviewInstruction);
  expect(appendix).toContain(commentInstruction);
  expect(appendix).not.toContain(
    'gh pr checks [PR_NUMBER] --repo [owner]/[repo]',
  );
  expect(appendix).not.toContain('latest fetched CI state');
  expect(appendix).not.toContain('Do not wait for CI');
  expect(appendix).not.toContain('pending_check');
  expect(appendix).not.toContain('--watch --interval 10');
  expect(appendix).not.toContain('10-minute wait cap');
}

describe('review-code GitHub workflow paths', () => {
  const skillContent = readSkill('../skills/standard/review-code/SKILL.md');

  it('forbids nested judge subagent spawns during code review', () => {
    expect(skillContent).toContain(
      'Do not spawn the `judge` subagent or any other nested review-only subagent',
    );
  });

  it('publishes findings as comments instead of change-request reviews', () => {
    expect(skillContent).toContain(
      'Do not submit a `request_changes` review in any pull-request review path.',
    );
    expect(skillContent).toContain(
      'Publish actionable findings as inline comments plus the canonical summary',
    );
    expect(skillContent).toContain(
      'reserve `submit_pull_request_review` for `approve` only in the approval-enabled clean paths.',
    );
  });

  it('keeps the consolidated GitHub review paths in review-code', () => {
    expect(skillContent).toContain(
      '<appendix name="review-github-pr" id="appendix-review-github-pr">',
    );
    expect(skillContent).toContain(
      '<appendix name="review-github-pr-with-approval" id="appendix-review-github-pr-with-approval">',
    );
    expect(skillContent).toContain(
      '<appendix name="sync-github-pr-review" id="appendix-sync-github-pr-review">',
    );
    expect(skillContent).toContain(
      '<appendix name="sync-github-pr-review-with-approval" id="appendix-sync-github-pr-review-with-approval">',
    );
  });

  it('self-fetches live PR context and preserves canonical summary discovery', () => {
    expect(skillContent).toContain(
      'When `pull_request_details` or current head metadata is missing, or when it must be revalidated before a side effect, call `mcp__roomote__manage_source_control` with `action: "get_pull_request"`, `repositoryFullName`, and `prNumber`.',
    );
    for (const appendixName of [
      'review-github-pr',
      'review-github-pr-with-approval',
    ]) {
      const appendix = readAppendix(skillContent, appendixName);
      expect(appendix).toContain(
        "For a GitHub cross-repository PR, run `git fetch origin '<targetBranch>' '+refs/pull/[PR_NUMBER]/head:refs/remotes/origin/pr-[PR_NUMBER]-head'`, then verify `git rev-parse refs/remotes/origin/pr-[PR_NUMBER]-head` exactly equals `<headSha>` from `get_pull_request`.",
      );
      expect(appendix).toContain(
        'If it differs, call `get_pull_request` once more and proceed only when the fetched SHA matches the refreshed `<headSha>`; otherwise report the blocker.',
      );
    }
    for (const appendixName of [
      'review-github-pr',
      'review-github-pr-with-approval',
      'sync-github-pr-review',
      'sync-github-pr-review-with-approval',
    ]) {
      const appendix = readAppendix(skillContent, appendixName);
      expect(appendix).toContain(
        "For a GitHub cross-repository PR, fetch the upstream PR ref with `git fetch origin '+refs/pull/[PR_NUMBER]/head:refs/remotes/origin/pr-[PR_NUMBER]-head'`, verify its resolved SHA exactly equals `<headSha>` from `get_pull_request`, and if it differs call `get_pull_request` once more and proceed only when the fetched SHA matches the refreshed `<headSha>`; otherwise report the blocker. Then run `git checkout --detach <headSha>`.",
      );
      expect(appendix).toContain(
        'For a cross-repository PR on another provider whose source branch cannot be fetched with task credentials, report that blocker instead of fetching the fork directly or improvising credentials.',
      );
    }
    expect(skillContent).toContain(
      'When `existing_review_comments` or `issue_comments` are missing, or when current thread, top-level review, or discussion state must be revalidated before a side effect, call `mcp__roomote__manage_source_control` with `action: "list_pull_request_comments"`.',
    );
    expect(skillContent).not.toContain('gh pr view');
    expect(skillContent).not.toContain('gh pr diff');
    expect(skillContent).not.toContain('gh pr checkout');
    expect(skillContent).not.toContain('gh pr review');
    expect(skillContent).not.toContain('gh repo view');
    expect(skillContent).not.toContain('gh issue view');
    expect(skillContent).not.toContain('gh api');
    expect(skillContent).toContain(
      '<!-- roomote-review-summary sha=[HEAD_SHA] mode=initial agent=[CLOUD_AGENT_ID] version=2 phase=[reviewing|reviewed] -->',
    );
    expect(skillContent).toContain(
      'this marker phase is the authoritative lifecycle signal',
    );
    expect(skillContent).toContain(
      'If no marker-based summary comment exists, use a backward-compatible legacy fallback',
    );
  });

  it('keeps every GitHub PR review path focused on code findings instead of CI state', () => {
    for (const appendixName of [
      'review-github-pr',
      'review-github-pr-with-approval',
    ]) {
      expectAppendixIgnoresCi(
        readAppendix(skillContent, appendixName),
        '<title>Update the canonical summary comment</title>',
        'Review the diff in context first before publishing the review findings.',
        'For each finding, check the fetched review threads for an existing thread anchored on the same file and overlapping lines.',
      );
    }

    for (const appendixName of [
      'sync-github-pr-review',
      'sync-github-pr-review-with-approval',
    ]) {
      expectAppendixIgnoresCi(
        readAppendix(skillContent, appendixName),
        '<title>Refresh the canonical summary comment</title>',
        'Review the delta in context first before publishing the review findings.',
        'For each net-new finding, check the fetched review threads for an existing thread anchored on the same file and overlapping lines.',
      );
    }
  });

  it('keeps code-only summary inventory, task handoff, and sync anchor recovery in the shared skill', () => {
    expect(skillContent).toContain(
      'If unresolved code findings remain, write one short status line inside the hidden status block, such as `2 issues outstanding.`',
    );
    expect(skillContent).toContain(
      'Add one unchecked markdown checkbox item (`- [ ]`) per actionable code finding inside the hidden checklist block.',
    );
    expect(skillContent).toContain(
      'Treat only unchecked markdown checklist items (`- [ ]`) as unresolved actionable inventory.',
    );
    expect(skillContent).toContain(
      'preserve it in place as a struck-through plain bullet like `- ~~Short finding text~~ — dismissed: brief factual reason.`',
    );
    expect(skillContent).toContain(
      'Do not append Roomote-authored action links or hidden fix markers.',
    );
    expect(skillContent).toContain(
      'If no actionable code issues remain, use a short status line in the hidden status block, such as `No code issues found.`',
    );
    expect(skillContent).toContain(
      'Record optional task-context values if they are supplied: `last_review_sha`, `current_head_sha`, `task_link_follow`, `task_link_see`, `TOP_LEVEL_COMMENT_ID`, `linked_implementation_task_id`, `top_level_review_comment`, `prior_summary_checklist`, `pull_request_details`, `pull_request_changed_files`, `changed_files_since_last_review`, `commits_since_last_review`, `linked_issue`, `diff_in_range`, `existing_review_comments`, and `issue_comments`.',
    );
    expect(skillContent).toContain(
      'When `pull_request_changed_files` is supplied, treat it as the authoritative set of files this pull request changes',
    );
    expect(skillContent).toContain(
      'If `prior_summary_checklist` is supplied, treat it as the parsed checklist inventory you must preserve in the refreshed summary.',
    );
    expect(skillContent).toContain(
      'If no surviving or net-new code issues remain, use a short status line in the hidden status block, such as `No new code issues found.`',
    );
    expect(skillContent).toContain(
      'If surviving or net-new code issues remain, add one unchecked markdown checkbox item (`- [ ]`) for each actionable code issue that should remain open.',
    );
    expect(skillContent).toContain(
      'Keep the summary structured as a hidden status block plus a hidden checklist/history block, ending with the trailing `<sub>Reviewing|Reviewed [SHORT_SHA]</sub>` footer.',
    );
    expect(skillContent).toContain(
      'approve the pull request by calling `mcp__roomote__manage_source_control` with `action: "submit_pull_request_review"` and `reviewEvent: "approve"`, passing no body or comment text.',
    );
    expect(skillContent).toContain(
      'On providers where approval maps to a vote or is not permitted for the token identity, the tool reports `applied: false` with warnings; report that gap honestly instead of claiming the pull request was approved.',
    );
    expect(skillContent).toContain(
      'top-level `reviews` with review ids and states when exposed',
    );
    expect(skillContent).toContain(
      'dismiss each unique top-level review whose `state` is `CHANGES_REQUESTED` and whose author matches the normalized Roomote-managed login set',
    );
    expect(skillContent).toContain(
      '`action: "dismiss_pull_request_review"`, that review\'s `reviewId`, and body `Requested changes have been addressed.`',
    );
    expect(skillContent).toContain("Never dismiss another reviewer's review.");
    expect(skillContent).toContain(
      '<summary>Use when you need actionable pull-request review findings, live provider context discovery, and one canonical summary comment without approval.</summary>',
    );
    expect(skillContent).toContain(
      '<summary>Use when new commits land after a prior review and you must evaluate only the delta while keeping the canonical summary comment in sync.</summary>',
    );
    expect(skillContent).toContain(
      'Check `linked_implementation_task_handoff_enabled` from task context before doing any linked-task handoff work.',
    );
    expect(skillContent).toContain(
      'If `linked_implementation_task_handoff_enabled` is absent or false, skip this handoff entirely.',
    );
    expect(skillContent).toContain(
      'Use `linked_implementation_task_id` from task context as the only allowed linked-task target for this handoff.',
    );
    expect(skillContent).toContain(
      'If `linked_implementation_task_id` is absent or empty, skip the handoff instead of guessing a task or inspecting the PR body.',
    );
    expect(skillContent).toContain(
      'Before sending the linked-task handoff, do one final PR-state check from the revalidated `get_pull_request` result and skip the handoff when the pull request is no longer open, even though the provider review comments and summary should still be posted normally.',
    );
    expect(skillContent).toContain(
      'Do not ask the linked implementation task to rely on Roomote-authored review comment links; pull-request follow-up should continue through direct comments and `@roomote` mentions instead.',
    );
    expect(skillContent).toContain(
      'For every terminal outcome in this variant, call the Roomote MCP tool `mcp__roomote__manage_tasks` with `action: "send_message"',
    );
    expect(skillContent).toContain(
      'wrapped in `<review_result>...</review_result>` tags',
    );
    expect(skillContent).toContain(
      "arrived through the task's normal queued follow-up message path",
    );
    expect(skillContent).not.toContain('<code-review-results>');
    expect(skillContent).not.toContain('default wrapper because it matches');
    expect(skillContent).not.toContain('snake_case style of child tags');
    expect(skillContent).toContain(
      "depends on the receiving workflow's own instructions rather than a transport-level metadata channel.",
    );
    expect(skillContent).toContain(
      'candidate review feedback rather than automatically authoritative instructions.',
    );
    expect(skillContent).toContain(
      "The receiver must revalidate each finding against the current code, the live review-thread context, and the user's requested scope before acting.",
    );
    expect(skillContent).toContain(
      'When `<current_head_sha>` is present, the receiver must compare it against the current branch or PR head before acting and must treat a mismatch as a stale review result that applies to an earlier commit, not to newer commits pushed after the review started.',
    );
    expect(skillContent).toContain(
      'leave a short factual reply on the corresponding review thread or comment explaining why the finding is not being addressed',
    );
    expect(skillContent).toContain(
      'leave the dismissed thread unresolved by default unless a separate higher-confidence closure policy explicitly applies.',
    );
    expect(skillContent).toContain('<review_kind>initial</review_kind>');
    expect(skillContent).toContain('<outcome>findings_remain|clean</outcome>');
    expect(skillContent).toContain(
      '<outcome>findings_remain|approved|clean_approval_skipped</outcome>',
    );
    expect(skillContent).toContain('<review_kind>sync</review_kind>');
    expect(skillContent).toContain(
      '<outcome>findings_remain|clean|no_new_delta</outcome>',
    );
    expect(skillContent).toContain(
      '<outcome>findings_remain|approved|clean_approval_skipped|no_new_delta</outcome>',
    );
    expect(skillContent).toContain(
      '<top_level_summary_comment_id>[TOP_LEVEL_COMMENT_ID]</top_level_summary_comment_id>',
    );
    expect(skillContent).toContain(
      '<current_head_sha>[HEAD_SHA]</current_head_sha>',
    );
    expect(skillContent).toContain(
      'Write `<title>` and `<summary>` as human-facing task updates rather than internal review bookkeeping.',
    );
    expect(skillContent).toContain(
      'For sync reviews, prefer phrasing like `latest update` or `new changes` over raw diff terminology.',
    );
    expect(skillContent).toContain('<finding_summary>...</finding_summary>');
    expect(skillContent).toContain('<finding_kind>code_finding</finding_kind>');
    expect(skillContent).toContain(
      '<review_comment_id>...</review_comment_id>',
    );
    expect(skillContent).toContain(
      '<review_comment_url>...</review_comment_url>',
    );
    expect(skillContent).toContain(
      'add a `<findings>` section with one `<finding>` block per actionable finding.',
    );
    expect(skillContent).toContain(
      'When no actionable findings remain, send an explicit clean result with `<outcome>clean</outcome>` instead of skipping the handoff.',
    );
    expect(skillContent).toContain(
      'When the review is clean and approval was recorded, send an explicit approved result with `<outcome>approved</outcome>` and `<approval_status>approved</approval_status>`.',
    );
    expect(skillContent).toContain(
      'When the review is clean but approval was skipped because the author is Roomote-managed, send an explicit clean result with `<outcome>clean_approval_skipped</outcome>` and `<approval_status>skipped</approval_status>`.',
    );
    expect(skillContent).toContain(
      'When there is no new delta, send an explicit no-op result with `<outcome>no_new_delta</outcome>` instead of skipping the handoff.',
    );
    expect(skillContent).toContain(
      'For every terminal outcome, the linked implementation task received an explicit final review result if the handoff was enabled, a reusable PR owner task ID was available in task context, and the task accepted the follow-up message, or the handoff failed harmlessly without affecting the published review.',
    );
    expect(skillContent).toContain(
      'For every terminal outcome, the linked implementation task received an explicit final sync-review result if the handoff was enabled, a reusable PR owner task ID was available in task context, and the task accepted the follow-up message, or the handoff failed harmlessly without affecting the published review.',
    );
    expect(skillContent).toContain(
      'convert that line from unresolved checklist form into a struck-through plain markdown bullet like `- ~~Short finding text~~ — dismissed: brief factual reason.` and leave it out of later actionable inventories.',
    );
    expect(skillContent).toContain(
      'Do not approve the pull request in this variant.',
    );
    expect(skillContent).toContain(
      '<criterion>No approval action was taken in this variant.</criterion>',
    );
    expect(skillContent).toContain(
      'If you still cannot determine a reliable anchor SHA but you do have a legacy summary comment, enter `legacy_full_rereview_path`',
    );
    expect(skillContent).toContain(
      'If you still cannot determine a reliable anchor SHA and there is no legacy summary comment to reuse, stop and ask for `last_review_sha` or explicit permission to do a full fresh review instead of guessing.',
    );
    expect(skillContent).toContain('Re-reviewing new commits now.');
    expect(skillContent).toContain(
      'patch its hidden summary marker to `version=2 phase=reviewing` and update its status block immediately',
    );
    expect(skillContent).toContain(
      '`<!-- roomote-review-status:start -->` and `<!-- roomote-review-status:end -->`',
    );
    expect(skillContent).toContain(
      '`<!-- roomote-review-checklist:start -->` and `<!-- roomote-review-checklist:end -->`',
    );
    expect(skillContent).toContain(
      'End the comment with a small visible status footer as the final line',
    );
    expect(skillContent).toContain(
      '<sub>Reviewing [SHORT_SHA](commit_url)</sub>',
    );
    expect(skillContent).not.toContain(
      'single-line clean summary is acceptable.',
    );
    expect(skillContent).toContain(
      'resolve that thread as part of this sync review closeout',
    );
    expect(skillContent).toContain(
      'Treat the configured GitHub App slug and any explicitly configured additional trusted app slugs in `[bot]` or `app/...` form as the only Roomote-managed logins ineligible for approval.',
    );
    expect(skillContent).not.toContain(
      'End the comment with the configured footer line (task link).',
    );
  });

  it('publishes new findings as line-anchored inline comments with a retry-then-summary-carry recovery', () => {
    for (const appendixName of [
      'review-github-pr',
      'review-github-pr-with-approval',
      'sync-github-pr-review',
      'sync-github-pr-review-with-approval',
    ]) {
      const appendix = readAppendix(skillContent, appendixName);
      expect(appendix).toContain(
        'post one new line-anchored inline comment per finding with `mcp__roomote__manage_source_control` `action: "create_pull_request_review_comment"`',
      );
      expect(appendix).toContain(
        'If the provider rejects the anchor because the line is not part of the current diff, re-check the hunk, correct `path`, `line`, or `side`, and retry exactly once.',
      );
      expect(appendix).toContain(
        'Match the suggestion syntax to `source_control_provider`: a fenced code block with info string `suggestion` on github and gitea, a fenced code block with info string `suggestion:-0+0` on gitlab, and a plain fenced code block with prose (no suggestion syntax) on bitbucket and ado.',
      );
      expect(appendix).toContain(
        'Bitbucket and Azure DevOps do not validate anchors against the diff',
      );
    }
    expect(skillContent).toContain(
      '<scenario name="inline_comment_anchor_rejected">',
    );
    for (const appendixName of [
      'sync-github-pr-review',
      'sync-github-pr-review-with-approval',
    ]) {
      const appendix = readAppendix(skillContent, appendixName);
      expect(appendix).toContain(
        'A thread whose `outdated` flag is true reports its original anchor line and means the flagged lines were changed by later commits',
      );
      expect(appendix).toContain(
        'Match threads by file and line including threads whose `outdated` flag is true',
      );
    }
    for (const appendixName of [
      'review-github-pr',
      'review-github-pr-with-approval',
      'sync-github-pr-review',
      'sync-github-pr-review-with-approval',
    ]) {
      const appendix = readAppendix(skillContent, appendixName);
      expect(appendix).toContain(
        'Treat a thread whose `outdated` flag is true as a weaker match for new findings',
      );
    }
    expect(skillContent).not.toContain('finding_without_thread_anchor');
    expect(skillContent).not.toContain(
      'no batch API for creating new line-anchored inline comments',
    );
    expect(skillContent).not.toContain('summary-carried on all providers');
  });

  it('removes CI and check-state language from the shared skill contract', () => {
    expect(skillContent).not.toContain(
      'If unresolved findings remain after combining the published code findings with the latest fetched CI state',
    );
    expect(skillContent).not.toContain(
      'If no actionable issues remain after combining the published code findings with the latest fetched CI state',
    );
    expect(skillContent).not.toContain(
      'If no surviving or net-new actionable issues remain after combining the published code findings with the latest fetched CI state',
    );
    expect(skillContent).not.toContain(
      'If surviving or net-new actionable issues remain after combining the published code findings with the latest fetched CI state',
    );
    expect(skillContent).not.toContain(
      'Treat checks whose `bucket` is `fail` or `cancel` as actionable review findings',
    );
    expect(skillContent).not.toContain(
      'If any checks are still in the `pending` bucket in the latest fetched check state',
    );
    expect(skillContent).not.toContain(
      'If any checks are still pending in the latest fetched check state',
    );
    expect(skillContent).not.toContain(
      'Confirm every accepted actionable check finding and every check still pending in the latest fetched check state was carried',
    );
    expect(skillContent).not.toContain(
      'Keep actionable check findings in the canonical summary comment and linked-task handoff instead of forcing an invalid inline review target.',
    );
    expect(skillContent).not.toContain(
      'When checks failed, include those actionable checks in the checklist alongside code findings',
    );
    expect(skillContent).not.toContain(
      '<finding_kind>code_finding|check|pending_check</finding_kind>',
    );
    expect(skillContent).not.toContain(
      'gh pr checks [PR_NUMBER] --repo [owner]/[repo]',
    );
    expect(skillContent).not.toContain('latest fetched CI state');
    expect(skillContent).not.toContain('Do not wait for CI');
    expect(skillContent).not.toContain('pending_check');
    expect(skillContent).not.toContain('--watch --interval 10');
    expect(skillContent).not.toContain('10-minute wait cap');
  });
});
