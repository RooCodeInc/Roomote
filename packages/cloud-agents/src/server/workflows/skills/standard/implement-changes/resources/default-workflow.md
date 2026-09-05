# Default Implementation Workflow

Read this resource only when executing the parent `implement-changes` default path, not for standalone child inheritance. Apply the root's `core-contract` throughout. This path handles repository implementation, not planning-only work or review-only commenting.

## 1. Ground and Plan

Create a concrete todo list before deep exploration covering repository analysis, implementation, validation, proof, and the active branch/push/PR path. Split delivery into distinct milestones and keep unresolved obligations visible through delegated skills. Update it as milestones actually complete, before progress text if the visible plan would otherwise lag.

After reading applicable `AGENTS.md` guidance, inspect relevant code, nearby patterns, contracts, tests, and configuration. Identify the exact change surface, behavior that must remain intact, and validation targets. Ask a focused question only if critical ambiguity remains after exploration. Turn the findings into concrete edits and checks, including separate commit/push/PR milestones required by task-level policy.

Plan for post-implementation `capture-visual-proof` whenever repository files change, but do not pre-classify visual applicability or enumerate capture surfaces. That skill decides from the final shipped change.

## 2. Implement

Edit only necessary files, following local architecture, shared abstractions, typing, and behavioral invariants. If a local pattern is wrong for the requested outcome, deviate deliberately rather than copying it blindly.

If you create a markdown file not meant to be committed (such as a report), upload it with `manage_artifacts` using action `upload`, set `type: "general"`, and share the returned link, including it in the final response.

## 3. Resolve Post-Change Proof

After implementation, check whether repository files actually changed, including newly added files. If none changed, skip capture and carry an honest no-op forward. Otherwise, load `capture-visual-proof` in the current task/session for the final shipped change before the judge pass or delivery. Do not launch a separate task or subagent for this step.

The proof skill decides applicability, snapshots the diff, captures any applicable screenshots or screencasts with `agent-browser`, uploads them, and returns its result. Do not run a screenshot, screencast, or baseline procedure outside it. Do not substitute Playwright, browser devtools, ad hoc localhost scripts, or any other browser automation for the `agent-browser` path defined in `capture-visual-proof`. If its environment-provided target is blocked, do not improvise another host or browser tool.

Carry the proof report, canonical uploaded artifact list, and any no-op, non-applicable, unnecessary, or blocked outcome honestly into review and delivery; never fabricate before/after evidence. A proof result is input, not completion. For later repository-file-changing iterations, rerun this step on the newer shipped state. Replace prior PR proof evidence with the latest relevant result instead of accumulating stale batches.

## 4. Validate and Review

Run targeted tests, type checks, linting, or other checks matching scope and risk. Investigate failures introduced by the change, fix them, and rerun affected checks. Record exactly what passed, failed, was skipped, or could not run; an unavailable dependency, service, credential, or tool is a validation gap, not permission to claim success or stop before required delivery.

For narrow visual-only polish changes, the automated validation step may stop at the smallest relevant static checks. When repository files changed, still follow the separate visual-proof step defined earlier in this workflow. Do not add or expand automated tests whose main assertion is an exact Tailwind class, exact DOM nesting, or another incidental UI implementation detail unless that detail is itself the contract or a reported regression.

By default, run a brief self-review over the task diff before branch/push/PR actions, focused on obvious request-satisfaction gaps, diff stability, accidental scope creep, and other cheap author-side catches. When task-level workflow instructions explicitly narrow or replace the parent review step, obey that narrower override instead of duplicating another review pass. For example, if the workflow says the parent step is only a brief author sanity check before a child review loop, keep it to that scope.

For the default review, inspect committed changes with `git diff $(git merge-base HEAD origin/HEAD 2>/dev/null || echo "HEAD~1") HEAD`, staged changes with `git diff --cached`, and unstaged changes with `git diff`; include newly added files. Check `git diff --cached --name-status` against intended deliverables before delivery, and unstage unexpected task-staged paths without modifying unrelated work.

When runtime instructions expose a hidden `judge` subagent and the task has a concrete plan, checklist, or explicit requested outcome, run one focused Task-tool judge pass after the initial self-review and only after any required pre-delivery `capture-visual-proof` step for this shipped change has completed. Supply the final shipped diff, plan/requested outcome, validation results, proof report verbatim, the path `/tmp/capture-visual-proof/diff-at-start.patch` when it exists, and the local paths of every kept screenshot and keyframe so the judge can open them. Ask it specifically to compare plan versus built result, to open the images and verify visual proof when evidence was captured or when proof should have applied, and to report undisclosed source drift between the proof snapshot and the shipped diff, not to repeat generic code review; keep any repo reads minimal and targeted instead of doing open-ended exploration.

Treat the judge verdict as review input and fix actionable plan-mismatch, proof, or drift gaps it finds. When those judge-driven fixes change repository files, re-run the `capture-visual-proof` step once for the updated shipped change, replace prior proof evidence, then run one more focused judge pass against the refreshed diff, validation state, and refreshed proof result before delivery. Otherwise re-review the updated diff and rerun the judge once if needed without a second proof step. Fix actionable self-review issues too, re-review changes, and explicitly document unresolved gaps.

Once the required parent review step reaches a known state, update the todo list and continue to the branch/push/PR step.

## 5. Reach the Required Delivery State

Continue until the run reaches the concrete branch, push, or pull-request state required by the invoking workflow's execution policy. This skill does not choose that policy. Local validation, proof, or a summary is not completion when delivery remains required; any local summary before delegated delivery resolves is only a progress update.

If validation failed, was skipped, or was unavailable for environmental reasons, and the implementation is still the intended shipped diff, continue into the policy-selected delivery skill and make that validation state reviewer-visible in the delegated PR or push report. If `capture-visual-proof` returned a no-op, non-applicable, unnecessary, or blocked proof result, continue into the policy-selected delivery skill and pass that proof result forward.

After implementation and the required parent review step are complete, select the matching child contract in the root and load `create-pr`, `create-draft-pr`, or `push` for actual delivery. Do not inline workspace detection, branch/commit/push mechanics, or PR creation here. Pass the final shipped diff, full task conversation, validation state, and latest relevant proof result/artifact list. The child decides whether to embed, refresh, or remove `## Screenshots` and `## Screencasts` and backfills sibling-PR cross-links when work spans repositories.

Let the delegated delivery skill own pull request title/body derivation, screenshot and screencast embedding, related-PR links, and any PR metadata refresh using its shared `pr-metadata-update-recipe` block plus the relevant `pr-writing-guide` section instead of duplicating that procedure here. Treat its returned branch, PR, and repository-by-repository results as canonical before any parent follow-up. If the run selects `fix-pr` or `resolve-github-pr-merge-conflicts`, follow that root child contract instead of imposing this default delivery sequence.

When delivery is blocked by a remote/auth failure or paused for input or approval, report the exact pending state, retain useful local context, and do not report the run as complete while the required delivery path remains pending. The only valid terminal states for a repository-changing run are: delegated delivery completed, an explicit blocker, or an explicit policy pause awaiting user input.

## 6. Report the Actual Outcome

Only close out after the delivery state is known. Summarize behavior-level changes, not just file names, with claims grounded in the checks and scope actually covered. State material unverified or pending work rather than implying broader completion.

Keep the final completion report conversational and concise by default; do not turn routine successful execution into an audit log. Do not add standalone `Validation`, `Checks`, or `Status` sections for routine successful runs. Mention proof capture or branch/PR outcomes when they materially affect delivery or the user's next step, or the user explicitly asked; prefer concise inline wording. Include links for any non-codebase markdown artifacts. Do not claim completion for steps that did not happen.
