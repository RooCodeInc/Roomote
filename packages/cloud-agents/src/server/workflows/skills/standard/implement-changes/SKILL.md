---
name: implement-changes
description: End-to-end repository implementation workflow. Use when the request requires changing code, with repository-grounded analysis, correct edits, proportional validation, and profile-aware branch/push/PR behavior.
---

<core_contract id="core-contract">

## Shared Mutation Contract

Standalone mutating child skills inherit only `core-contract` and their matching child-path contract below. Loading this skill for inheritance does not authorize executing the default workflow automatically. Do not read the default-workflow resource for child inheritance unless the caller explicitly instructed the parent default path to run first. When invoked together with a child, this skill is the shared base and routing layer; the child remains the canonical owner of specialized mechanics and wins over conflicting general defaults.

- Ground every change in repository truth before editing. Before inspecting, planning, reviewing, or editing inside any repository path, read the applicable repo-local `AGENTS.md` guidance for that path. In shared-root workspaces, first read the generated workspace-root `AGENTS.md`, then discover tracked child-repo guidance with `git -C <repo-dir> ls-files -- AGENTS.md '**/AGENTS.md'`, and read the repo root `AGENTS.md` through the nearest ancestor file for the path being worked on.
- When switching repositories or moving into a different subtree with its own `AGENTS.md`, re-check and read the newly applicable repo-local guidance before continuing.
- Prefer a correct, repository-aligned change that satisfies the request without unrelated churn. Validate proportionally and report failed, skipped, or unavailable checks honestly.
- Keep task tracking current so the visible plan matches reality. Carry unresolved parent proof, delivery, blocker, and input-needed obligations across handoffs until resolved; a child load is not completion.
- Do not narrate implementation rationale into runtime-visible product output: UI copy, strings, placeholders, HTML, and end-user-visible comments must serve the product, not describe your edits. Repository documentation is exempt; explain your work in conversation, commits, and PR descriptions.
- Follow the invoking execution policy and explicit authorization for branch/push/PR actions. Do not create a pull request unless that policy allows it. Report a policy pause or remote/auth blocker exactly, not as successful delivery.
- Do not claim branch, push, PR, validation, or proof steps completed unless they actually happened.

</core_contract>

<default_path id="default-path">
When `implement-changes` is the execution workflow without an explicit child-path selection, read [resources/default-workflow.md](resources/default-workflow.md) before deeper execution and follow it through the required delivery state. Load that resource only for default execution, not merely because a standalone child loaded this root for inheritance.
</default_path>

<child_skill_registry id="child-skill-registry">

## Child Routing

Consult only the matching contract below, then load its canonical skill; do not duplicate the child's executable recipes here. Explicitly naming a child path or clear alias while `implement-changes` is active is authoritative: enter it immediately without waiting for an external wrapper to restate the selection. If multiple paths remain plausible, ask one focused clarification question.

For delivery after default implementation, finish the default resource's implementation, proof, validation, and parent review first. Pass the final shipped diff, full task conversation, validation gaps, and latest proof result/artifact list to the selected delivery skill. For standalone child invocation, follow that child's own workflow instead; do not force the default sequence. The child owns workspace detection, metadata, branch/commit/push mechanics, and repository-by-repository reporting. Treat its returned state as canonical before parent follow-up or closeout.

<appendix name="create-pr" id="appendix-create-pr">
Load `create-pr` only when the active policy allows ready-for-review delivery. Aliases: "ready PR", "ready-for-review PR", "non-draft PR". Generic requests such as "create PR", "open PR", or "deliver as a PR/MR" follow task-level delivery policy, which defaults to draft delivery in Autonomous runs; they do not select this ready path. The child owns PR creation/refresh, title/body derivation, proof-section updates, and sibling-PR cross-links.
</appendix>

<appendix name="create-draft-pr" id="appendix-create-draft-pr">
Load `create-draft-pr` when the policy requires draft delivery. Aliases: "create draft PR", "open draft PR", "draft PR"; generic create/open/deliver PR/MR requests also select this path when task-level policy selects draft delivery. The child owns draft-state handling, PR creation/refresh, title/body derivation, proof-section updates, and sibling-PR cross-links.
</appendix>

<appendix name="push-branch" id="appendix-push-branch">
Load `push` for "push", "push branch", "push changes", or "push without PR" when the policy requires push-only delivery. Do not create or refresh a pull request on this path unless a later, separate workflow explicitly changes the delivery policy.
</appendix>

<appendix name="fix-github-pr-feedback" id="appendix-fix-github-pr-feedback">
Load `fix-pr` for review-thread fixes, `fixId` requests, top-level PR comments, or broad unresolved-feedback requests. Aliases: "PR fixer", "fix PR feedback", "address review comments", "run the GitHub PR fixer".

Pass through any supplied PR, review-thread, `fixId`, `review_comment_id`, `review_comment_url`, `task_link_follow`, `task_link_see`, or `revert_commit_base_url` context so `fix-pr` can recover the live target cleanly.

Enter `fix-pr` even when the PR may be conflicted. It owns live-state retrieval and mergeability preflight, delegation to `resolve-github-pr-merge-conflicts` when needed, and resuming the fixer on refreshed PR state. It also owns revalidating unresolved review-summary candidates, dismissal bookkeeping (not claiming dismissed findings as fixed or resolving their threads by default), existing-branch pushes, thread management, and canonical fixer comment updates.

Let `fix-pr` own any required `capture-visual-proof` step after repository-file-changing fixes and before PR metadata refresh so this parent path never runs proof for PR feedback runs itself. Let `fix-pr` own the post-push PR metadata refresh using its shared `pr-metadata-update-recipe` block and the `fix-pr` skill's `pr-writing-guide` section. Its result is the canonical fixer outcome, not a trigger for the parent's default PR-delivery finish.
</appendix>

<appendix name="resolve-github-pr-merge-conflicts" id="appendix-resolve-github-pr-merge-conflicts">
Load `resolve-github-pr-merge-conflicts` to merge the base branch into an existing PR branch and resolve conflicts intentionally. Aliases: "merge conflict resolver", "resolve PR conflicts", "fix merge conflicts". Pass supplied PR number and repository context. The child owns checkout, merge, intent-aware resolution, integrated safety review, validation, push, and resolution reporting; do not restate those mechanics here.
</appendix>

</child_skill_registry>
