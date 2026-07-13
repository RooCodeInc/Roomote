import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

describe('implement-changes PR fixer appendix', () => {
  it('keeps the PR feedback fixer guidance consolidated in the appendix', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      '<appendix name="fix-github-pr-feedback" id="appendix-fix-github-pr-feedback">',
    );
    expect(skillContent).toContain(
      'Fetch the live PR state with `gh pr view [PR_NUMBER] --repo [owner]/[repo] --json title,body,url,author,headRefName,headRefOid,mergeable,mergeStateStatus,closingIssuesReferences,files`, `gh pr diff [PR_NUMBER] --repo [owner]/[repo]`, `gh api repos/[owner]/[repo]/pulls/[PR_NUMBER]/comments --paginate`, and `gh api repos/[owner]/[repo]/issues/[PR_NUMBER]/comments --paginate` before classifying the trigger.',
    );
    expect(skillContent).toContain(
      '`fix-pr` owns the mergeability preflight for this path. When the target PR is conflicted, it should delegate to `resolve-github-pr-merge-conflicts`, re-fetch live PR state, and only then continue the main fixer flow on the refreshed PR branch.',
    );
    expect(skillContent).toContain(
      'For broad requests, reuse the latest Roomote review summary whose first line starts with `<!-- roomote-review-summary` as the canonical issue inventory when available, but treat only unchecked checklist items (`- [ ]`) as unresolved fix targets; ignore checked items and struck-through dismissed bullets, and revalidate each candidate against the live review-thread context and current code before acting.',
    );
    expect(skillContent).toContain(
      'When a candidate finding is dismissed as invalid, stale, or out of scope, patch the canonical summary entry into a struck-through bullet with a brief factual reason, reply on the corresponding GitHub review thread or comment, do not describe it as fixed, and leave the thread unresolved by default.',
    );
    expect(skillContent).toContain(
      'Let `fix-pr` own any required delegated `capture-visual-proof` handoff after repository-file-changing fixes and before PR metadata refresh so this parent path never improvises browser capture for PR feedback runs.',
    );
    expect(skillContent).toContain(
      'Pass through any supplied PR, review-thread, `fixId`, `review_comment_id`, `review_comment_url`, `task_link_follow`, `task_link_see`, or `revert_commit_base_url` context so `fix-pr` can recover the live target cleanly.',
    );
    expect(skillContent).toContain(
      'Patch the canonical fixer comment through the same endpoint family it was created with, keeping the hidden marker first, keeping `task_link_see` inline on the final summary when it is available, and including the real commit link in the final comment.',
    );
    expect(skillContent).toContain(
      'Let `fix-pr` own the post-push PR metadata refresh using its `pr-metadata-update-recipe` and the inherited `pr-writing-contract`.',
    );
    expect(skillContent).toContain(
      'Let `fix-pr` own the existing PR branch, mergeability preflight, and thread-management flow end to end; do not restate `gh pr view`, `gh pr diff`, `gh api`, `gh pr edit`, or canonical fixer comment mechanics in this appendix.',
    );
    expect(skillContent).not.toContain(
      "Immediately after the successful push, re-read the final shipped diff, derive a refreshed PR title and body from that final state using the `fix-pr` skill's `pr-writing-guide` section, and run `gh pr edit [PR_NUMBER] --repo [owner]/[repo] --title '...' --body '...'` so the existing PR metadata matches what now ships.",
    );
    expect(skillContent).toContain(
      'Enter `fix-pr` even when the PR may be conflicted. Let `fix-pr` decide whether it must hand off to `resolve-github-pr-merge-conflicts` first, then resume the same PR-fixer run instead of bypassing the fixer entrypoint.',
    );
    expect(skillContent).toContain(
      '`task_link_see` inline on the final summary',
    );
    expect(skillContent).toContain('real commit link');
  });

  it('allows the PR fixer appendix to be selected explicitly from implement-changes', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/implement-changes/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'Aliases include “PR fixer”, “fix PR feedback”, “address review comments”, and “run the GitHub PR fixer”.',
    );
    expect(skillContent).toContain(
      'When an appendix is explicitly selected by the user, behave as though this skill has direct access to that appendix as an internal tool',
    );
  });

  it('keeps dismissal-aware fix inventory and closeout rules in the canonical fix-pr skill', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/fix-pr/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'Build that inventory only from unresolved checkbox items (`- [ ]`). Ignore checked items (`- [x]`) and struck-through dismissed bullets like `- ~~...~~ — dismissed: ...` because they are history, not open fix targets.',
    );
    expect(skillContent).toContain(
      'treat it as candidate review feedback rather than an automatically authoritative instruction until that revalidation is complete.',
    );
    expect(skillContent).toContain(
      'update the canonical review summary in place by converting the matching unresolved checklist line into a struck-through plain bullet with a brief factual reason',
    );
    expect(skillContent).toContain(
      'leave a short factual reply on the corresponding review thread with `action: "reply_to_pull_request_comment"` explaining why it is not being addressed.',
    );
    expect(skillContent).toContain(
      'Append the revert link only when `revert_commit_base_url` is available.',
    );
    expect(skillContent).toContain(
      'Do not describe dismissed findings as fixed, and do not auto-resolve their review threads by default unless a separate higher-confidence closure policy explicitly applies.',
    );
    expect(skillContent).toContain(
      'parse only unchecked checklist items -> ignore checked and dismissed history lines',
    );
    expect(skillContent).toContain(
      'Do not treat a dismissed, invalid, stale, or out-of-scope finding as fixed, and do not resolve its review thread by default.',
    );
  });

  it('requires fix-pr itself to own delegated visual-proof handoff before PR metadata refresh', () => {
    const thisFilePath = fileURLToPath(import.meta.url);
    const thisDirPath = path.dirname(thisFilePath);
    const skillPath = path.resolve(
      thisDirPath,
      '../skills/standard/fix-pr/SKILL.md',
    );
    const skillContent = fs.readFileSync(skillPath, 'utf8');

    expect(skillContent).toContain(
      'run a delegated visual-proof handoff for repository-file-changing fixes before PR metadata refresh',
    );
    expect(skillContent).toContain(
      'After the fixes are committed and pushed, check whether the final pushed fixer result changed repository files, including newly added files.',
    );
    expect(skillContent).toContain(
      'If repository files changed, continue in the current task/session by transitioning into `capture-visual-proof` and pass forward the final shipped fixer result for proof planning and capture before PR metadata refresh continues. Do not launch a separate task for this handoff.',
    );
    expect(skillContent).toContain(
      'Once repository-file-changing fixes require this proof handoff, do not substitute fixer-owned or parent-owned visual-proof capture such as local screenshots, local screencasts, ad hoc localhost scripts, direct browser capture, Playwright capture, manual browser use, or any other improvised visual-proof procedure in this workflow.',
    );
    expect(skillContent).toContain(
      'The pushed fixer result ends with either an in-task delegated proof handoff for repository-file changes or an honest no-op result before PR metadata refresh continues.',
    );
    expect(skillContent).toContain(
      'When the pushed fixer result changed repository files, the workflow continued in the current task/session by handing that shipped result to `capture-visual-proof`, kept browser tooling contained inside that delegated proof path, and carried the delegated proof result or blocker honestly into PR metadata refresh.',
    );
  });
});
