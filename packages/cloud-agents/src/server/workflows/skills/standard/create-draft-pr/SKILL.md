---
name: create-draft-pr
description: Draft pull-request creation workflow. Use when repositories have pending changes or unpushed commits and you want draft PRs created.
---

<role>
You are executing a command to create a draft pull request with the current changes.
</role>

<shared_core_loading>
<rule>If the `implement-changes` skill is not currently loaded into your context, load that skill before deeper execution.</rule>
<rule>When loading `implement-changes` from this child skill, inherit only the `core-contract` section and the matching parent child-path contract for this workflow.</rule>
<rule>Do not execute `implement-changes`'s default workflow from this child skill unless the caller explicitly instructed the parent default path to run first.</rule>
<rule>This child skill remains the canonical owner of its delivery mechanics even when the parent skill is loaded for shared context.</rule>
</shared_core_loading>

<delivery_branch_invariant>
<rule>Before staging files, writing `/tmp/pr-body.md`, committing, pushing, or calling `mcp__roomote__manage_source_control`, ensure each repository is on the delivery branch for this task, created from the provided base/default branch when a new branch is needed.</rule>
<rule>Do not perform delivery work directly from `main` or `master` unless the user explicitly selected that branch as the existing delivery branch for this task.</rule>
</delivery_branch_invariant>

<pull_request_base_invariant>
<rule>For every draft pull request, pass the provided base/default branch explicitly as `targetBranch` in the `mcp__roomote__manage_source_control` call; do not rely on the provider's repository default branch or the current local tracking branch to choose the PR base.</rule>
<rule>Pass `targetBranch` on refresh calls too, so an existing draft pull request keeps its intended base relationship.</rule>
</pull_request_base_invariant>

<workflow>
  <overview>Create or refresh draft pull requests for every repository in the current workspace that has pending changes or unpushed commits.</overview>
  <initial_determination>
    <detection_patterns>
      <pattern type="single_repo">
        <indicator>The current directory contains a `.git` directory.</indicator>
      </pattern>
      <pattern type="multi_repo">
        <indicator>The current directory is not itself a git repository but contains child directories that are repositories.</indicator>
      </pattern>
      <pattern type="no_changes">
        <indicator>No repository has uncommitted changes or unpushed commits after workspace detection.</indicator>
      </pattern>
    </detection_patterns>
  </initial_determination>

  <phase name="analysis">
    <description>Identify every repository that needs a pull request and collect the metadata required to create it safely.</description>
    <steps>
      <step number="1">
        <title>Detect the workspace layout and changed repositories</title>
        <description>Determine whether the workspace is a single repository or a container of multiple repositories, then enumerate every repository with pending work.</description>
        <actions>
          <action>Run `echo "=== Workspace Detection ===" && pwd && echo "" && if [ -d ".git" ]; then echo "WORKSPACE_TYPE: SINGLE_REPO"; echo "REPO_DIR: $(pwd)"; echo "REPO_NAME: $(git remote get-url origin 2>/dev/null | sed -E 's|.*[:/]([^/]+/[^/]+)$|\1|' | sed 's/\.git$//' || basename $(pwd))"; else echo "WORKSPACE_TYPE: MULTI_REPO"; echo "=== Repos with Changes ==="; workspace_root=$(pwd); shopt -s nullglob; for repo_dir in */; do if [ -d "$workspace_root/${repo_dir}.git" ]; then cd "$workspace_root/$repo_dir"; has_changes=false; if [ -n "$(git status --porcelain 2>/dev/null)" ]; then has_changes=true; fi; if [ -n "$(git log origin/HEAD..HEAD --oneline 2>/dev/null)" ]; then has_changes=true; fi; if [ "$has_changes" = "true" ]; then repo_name=$(git remote get-url origin 2>/dev/null | sed -E 's|.*[:/]([^/]+/[^/]+)$|\1|' | sed 's/\.git$//' || basename $(pwd)); echo "CHANGED_REPO: ${repo_dir%/} -> $repo_name"; fi; fi; done; cd "$workspace_root"; for owner_dir in */; do if [ ! -d "$workspace_root/${owner_dir}.git" ]; then cd "$workspace_root"; for repo_dir in "$owner_dir"*/; do if [ -d "$workspace_root/${repo_dir}.git" ]; then cd "$workspace_root/$repo_dir"; has_changes=false; if [ -n "$(git status --porcelain 2>/dev/null)" ]; then has_changes=true; fi; if [ -n "$(git log origin/HEAD..HEAD --oneline 2>/dev/null)" ]; then has_changes=true; fi; if [ "$has_changes" = "true" ]; then repo_name=$(git remote get-url origin 2>/dev/null | sed -E 's|.*[:/]([^/]+/[^/]+)$|\1|' | sed 's/\.git$//' || basename $(pwd)); echo "CHANGED_REPO: ${repo_dir%/} -> $repo_name"; fi; fi; done; cd "$workspace_root"; fi; done; shopt -u nullglob; cd "$workspace_root"; fi`.</action>
          <action>Capture each changed repository and conclude with a user-facing no-op explanation if no repositories require action.</action>
        </actions>
        <validation>Every changed repository is listed explicitly and the execution path is known to be single-repo, multi-repo, or no-op.</validation>
      </step>
      <step number="2">
        <title>Derive branch, commit, and repository metadata for each repository</title>
        <description>Inspect the pending work in every changed repository and derive the exact metadata required before commit, push, and pull request creation.</description>
        <actions>
          <action>For each repository, determine the final `owner/repo` from the git remote, the current branch, and the provided base/default branch for this run. If no branch is provided for the run, use the repository default branch.</action>
          <action>For each repository, derive a branch name using `feature/<short-description>-<TASK_ID>` or `fix/<short-description>-<TASK_ID>` in kebab-case.</action>
          <action>Choose a conventional commit message for each repository.</action>
        </actions>
        <pr-writing-guide>
          <pr_title_format>
            <format>Follow the selected repository template's explicit title convention when it defines one; otherwise use `[Type] user-facing description`.</format>
            <types>
              <type name="feat">New capability or behavior visible to the user.</type>
              <type name="fix">Bug fix. Description must use the pattern "... when user [does X]" or "... [user-visible symptom]" so the title names the symptom, not the code fix.</type>
              <type name="improve">Enhancement to existing behavior, UX polish, or quality-of-life change.</type>
              <type name="refactor">Code restructuring with no user-visible behavior change.</type>
              <type name="docs">Documentation-only change.</type>
              <type name="chore">Dependency updates, config, CI, infra, or other non-functional maintenance.</type>
            </types>
            <scope>The bracketed Roomote format is the fallback only when the selected repository template does not define a title convention.</scope>
            <description_rules>
              <rule>When the selected repository template contains an explicit title convention, follow that convention exactly instead of imposing the fallback Roomote format.</rule>
              <rule>Otherwise, start the title with exactly one singular bracketed type tag such as `[Fix]`, `[Feat]`, `[Improve]`, `[Refactor]`, `[Docs]`, or `[Chore]`.</rule>
              <rule>For fallback titles, keep the bracket contents to the type only and follow the tag with a space and the description.</rule>
              <rule>Lead with what the user sees or can do, not the implementation detail.</rule>
              <rule>Write the user-facing description in sentence case. Capitalize the first word after the required title prefix and preserve proper nouns and acronyms.</rule>
              <rule>For fixes, frame as the user-visible symptom: "task list fails to load when user has no environments", not "add null check to getTaskList query".</rule>
              <rule>For non-fix titles, use present-tense imperative mood.</rule>
              <rule>For features, name the capability: "Add bulk-cancel action to task dashboard", not "implement BulkCancelButton component".</rule>
              <rule>For improvements, name the better experience: "Show environment name in task status notifications", not "pass env name through notification context".</rule>
            </description_rules>
            <examples>
              <example type="fix">[Fix] Task list fails to load when user has no environments</example>
              <example type="feat">[Feat] Add bulk-cancel action to task dashboard</example>
              <example type="improve">[Improve] Show environment name in task status notifications</example>
            </examples>
          </pr_title_format>
          <pr_body_sections>
            <section name="What problem this solves">
              <guidance>Describe the concrete user, product, developer, or operational problem. Name the affected surface or workflow. For fixes, describe the broken behavior and trigger. For features, improvements, refactors, docs, and chores, state the unmet need, limitation, maintenance burden, or reviewer-relevant objective without inventing user-facing drama. Do not lead with the implementation or narrate files.</guidance>
            </section>
            <section name="Why this change was made">
              <guidance>Explain the complete shipped solution, important design decisions, and relevant boundaries or non-goals. Include implementation detail only when it helps the reviewer understand behavior or risk. Avoid file-by-file narration.</guidance>
            </section>
            <section name="User impact">
              <guidance>State what users, operators, or developers can now do or expect. Lead with the concrete benefit. When there is no intended user-facing change, say so plainly and state the operational, maintenance, or reviewer-visible benefit instead.</guidance>
            </section>
            <section name="Evidence">
              <guidance>Show the most useful proof that the change works. Include focused tests, CI results, manual observations, terminal output, redacted logs, screenshots, screencasts, or artifact links as appropriate. State failed, skipped, or unavailable checks honestly. Make validation easy to understand without restating the diff.</guidance>
            </section>
            <section name="Related PRs">
              <guidance>Include only when the same task ships through multiple pull requests. Link the sibling PRs with short labels such as repository names or user-facing split names like frontend/backend. Omit the current PR, and remove stale links when the task split changes.</guidance>
            </section>
          </pr_body_sections>
        </pr-writing-guide>
        <validation>Each repository has a complete execution bundle: repo directory, target repository, base branch, delivery branch name, and commit message.</validation>
      </step>
    </steps>
  </phase>

  <phase name="implementation">
    <description>Create or reuse the delivery head branch, commit the work on that branch, push it, and create or refresh one draft pull request per changed repository.</description>
    <steps>
      <step number="3">
        <title>Create the delivery branch from the provided base branch</title>
        <description>Use the provided base/default branch for this run as the source for the delivery branch. For example, if the provided base is `develop`, create the delivery branch from `origin/develop`.</description>
        <actions>
          <action>For each repository, fetch the provided base branch with `cd <REPO_DIR> && git fetch origin <base-branch-for-this-repo>`.</action>
          <action>If a new delivery branch is needed, run `cd <REPO_DIR> && git checkout -b <branch-name-for-this-repo> origin/<base-branch-for-this-repo>` before staging or committing pending work.</action>
          <action>If already on an explicit existing delivery branch for this task, keep that branch.</action>
          <action>Record the final delivery branch name and base branch before proceeding.</action>
        </actions>
        <validation>Every repository that is being prepared for a draft pull request is on a delivery branch created from the provided base branch, or is explicitly identified as already on an existing delivery branch for this task.</validation>
      </step>
      <step number="4">
        <title>Commit any uncommitted work</title>
        <description>Stage and commit pending local changes repository by repository, while preserving hook-based safeguards.</description>
        <actions>
          <action>For repositories with uncommitted changes, run `cd <REPO_DIR> && git add -A && git diff --cached --name-status`.</action>
          <action>After `git add -A`, explicitly compare `git diff --cached --name-status` against the intended deliverables for this task. If any staged path is unexpected, unstage it with `git restore --staged <path>` before committing. Treat generated or untracked files as excluded by default unless they are clearly part of the requested delivery.</action>
          <action>After the staged-path review is complete, run `cd <REPO_DIR> && git commit -m '<commit-message-for-this-repo>'`.</action>
          <action>If a repository has only unpushed commits and no working tree changes, skip the commit step for that repository.</action>
          <action>If hooks fail, fix the underlying issue instead of bypassing validation with `--no-verify` unless no other safe option remains.</action>
        </actions>
        <validation>Every repository is either clean with a new commit or intentionally skipped because it already had the necessary commits.</validation>
      </step>
      <step number="5">
        <title>Push the target branch</title>
        <description>Push each repository's current HEAD to the remote after the delivery branch and commit state are correct.</description>
        <actions>
          <action>For each repository, run `cd <REPO_DIR> && git push origin HEAD`.</action>
          <action>Record the final branch name and confirm the remote push succeeded before proceeding.</action>
        </actions>
        <validation>Every repository that is being prepared for a pull request has a pushed remote branch.</validation>
      </step>
      <step number="6">
        <title>Create or refresh one draft pull request per repository</title>
        <description>Use the derived metadata to either open a new draft pull request or refresh the existing one for each repository with pending work, targeting the same provided base branch.</description>
        <actions>
          <action>For each repository, derive the current branch with `cd <REPO_DIR> && git rev-parse --abbrev-ref HEAD`. Do not use provider-specific PR CLIs such as `gh` for creation or refresh; the `mcp__roomote__manage_source_control` tool handles open pull request lookup and provider-specific mutation server-side.</action>
          <action>Use the identical `pr-metadata-update-recipe` block below after the push and before the create or refresh call.</action>
          <action>In this draft workflow, execute the recipe's `mcp__roomote__manage_source_control` call. The platform opens new pull requests in the draft or ready-for-review state configured by the deployment PR delivery setting and preserves the existing state on refresh. Include `labels` with the conflict resolver label when one is provided, and do not pass `labels` when none is provided.</action>
          <action>When provider-compatible assignee usernames are provided for this run, pass them as `assignees` in the `mcp__roomote__manage_source_control` call so the created or refreshed draft pull request is assigned to those users.</action>
          <action>Before any `mcp__roomote__manage_source_control` call, run the recipe's required PR metadata contract check. If the check fails, rewrite `/tmp/pr-body.md` and the title until it passes; do not create or refresh a pull request with non-contract metadata.</action>
          <action>Collect the pull request number and URL returned by each successful `mcp__roomote__manage_source_control` result, and treat that tool result as the live pull request reference instead of treating the final message as proof that the pull request exists.</action>
          <action>After the first creation or refresh pass, if this run produced or refreshed more than one pull request for the same task, rebuild each PR body so it includes a `## Related PRs` section linking the sibling pull requests by repository or surface label, then call `mcp__roomote__manage_source_control` again for each sibling pull request to backfill those cross-links.</action>
          <action>When maintaining the `## Related PRs` section, omit self-links, keep only sibling pull requests from the current task split, and remove stale links to superseded or unrelated PRs.</action>
        </actions>
        <pr-metadata-update-recipe>
          <item>Run `git diff $(git merge-base HEAD origin/<base-branch-for-this-repo> 2>/dev/null || echo "HEAD~1") HEAD` to capture the full PR diff for the branch. Use this local git diff for every provider.</item>
          <item>When an earlier delivery pass in this task produced a `/tmp/pr-body.md`, read it before overwriting it so still-applicable metadata can be recovered, including current `## Related PRs` links, `## Linked work items`, and proof sections; this workflow does not read the remote pull request body.</item>
          <item>Call the Roomote MCP tool `mcp__roomote__manage_tasks` with `action: "get_messages"` for the current task using `limit: 20`. Reverse the returned newest-first message list before extracting the original problem statement, motivation, and key decisions from the conversation history.</item>
          <item>Before writing `/tmp/pr-body.md`, check for a checked-in repository pull request or merge request template in the locations the repository's source-control provider supports. On GitHub, inspect `.github/pull_request_template.md`, `.github/PULL_REQUEST_TEMPLATE.md`, any `.md` files inside `.github/PULL_REQUEST_TEMPLATE/`, `docs/pull_request_template.md`, `docs/PULL_REQUEST_TEMPLATE.md`, `pull_request_template.md`, and `PULL_REQUEST_TEMPLATE.md`. On GitLab, inspect the `.md` files inside `.gitlab/merge_request_templates/`, preferring `Default.md` when present. On Gitea, inspect `.gitea/pull_request_template.md`, `.gitea/PULL_REQUEST_TEMPLATE.md`, any `.md` files inside `.gitea/PULL_REQUEST_TEMPLATE/`, and the same root-level and `docs/` fallbacks GitHub supports. On Azure DevOps, inspect `.azuredevops/pull_request_template.md`, any branch-specific `.md` files inside `.azuredevops/pull_request_template/branches/`, `docs/pull_request_template.md`, and root-level `pull_request_template.md`. Match the repo's actual filename casing when present. When multiple template files exist in the directory path, choose the single template that best matches the current PR scope and treat it as the selected repo template for this run.</item>
          <item>Write `/tmp/pr-body.md` using the PR diff, the recovered conversation, and any still-applicable metadata recovered from the previous `/tmp/pr-body.md`. When a selected repo template exists, use it as the starting scaffold for `/tmp/pr-body.md`: preserve its reviewer-facing headings, checklist items, and other required structure, replace placeholder guidance with final content, and merge the `pr-writing-guide` substance into that scaffold instead of replacing the template. When no repo template exists, structure the body per the `pr-writing-guide` section below. If the caller supplied a PR provenance block, make it the opening blockquote. Preserve or refresh `## Related PRs` when the previous `/tmp/pr-body.md` or current task context identifies sibling PRs. Preserve or refresh `## Linked work items` when the previous `/tmp/pr-body.md` or current workflow instructions identify linked work items. When the current workflow instructions include a pre-rendered linked-work-item block for this run, include that block verbatim and do not rewrite provider-specific closing or reference syntax. When the latest `capture-visual-proof` handoff reports an uploaded artifact list from `manage_artifacts` upload results, treat it as the authoritative visual-proof input: render `## Screenshots` from its reported screenshots only when present, embedding each screenshot as `![<shot-description>](<rawUrl>)` so the image renders inline in the PR body; do not create `## Visual proof` for screenshots and do not render screenshot artifact viewer links when `rawUrl` exists; render `## Screencasts` from its reported screencasts only when present using `[![<clip-name>](<first-keyframe-rawUrl>)](<video-viewUrl>)`, plus a caption line below each embed, where `<video-viewUrl>` is the clip's uploaded `viewUrl`, and explicitly remove any existing `## Screenshots` or `## Screencasts` section whose latest reported set is empty so stale evidence is not preserved. When that uploaded artifact list does not exist and the latest proof handoff is an honest no-op result because this cycle did not run `capture-visual-proof`, preserve any existing `## Screenshots` and `## Screencasts` sections from the previous `/tmp/pr-body.md` when they already contain valid artifact URLs or screencast embeds. When that uploaded artifact list does not exist and the latest proof handoff reports that browser proof is not applicable, that screenshots and screencasts are unnecessary, or that capture is blocked, explicitly remove any existing `## Screenshots` and `## Screencasts` sections instead of preserving stale proof from an earlier cycle. Only when that uploaded artifact list does not exist and screenshot `rawUrl` values are still available from the latest proof handoff should the screenshot-only fallback include `## Screenshots`, embedding each screenshot as `![<shot-description>](<rawUrl>)` so the image renders inline in the PR body; do not create `## Visual proof` for screenshots and do not render screenshot artifact viewer links when `rawUrl` exists. When no previous `/tmp/pr-body.md` exists, there is no prior body to preserve, so include visual proof sections only when current-cycle proof links are available and include `## Linked work items` only when the current workflow instructions provide one.</item>
          <item>Derive a refreshed PR title per the `pr-writing-guide` section below.</item>
          <item>Before calling `mcp__roomote__manage_source_control`, validate the exact title and `/tmp/pr-body.md` against the PR writing guide. When a selected repo template defines an explicit title convention, the title must follow it; otherwise the title must begin with exactly one approved bracketed fallback type tag. When a selected repo template exists, the body must preserve the template's reviewer-facing headings, checklist items, and required structure, replace placeholder guidance with final content, and cover the same reviewer substance the `pr-writing-guide` requires without forcing Roomote-only headings that the template does not use. When no repo template exists, the body must include `## What problem this solves`, `## Why this change was made`, `## User impact`, and `## Evidence`. Do not add generic top-level sections such as `## Summary`, `## Changes`, `## Validation`, `## Checks`, or `## Status` unless the selected repo template explicitly requires them. Treat this as a hard gate: if the metadata fails, rewrite it and re-check before running the source-control mutation.</item>
          <item>Call `mcp__roomote__manage_source_control` with `action: "create_or_update_pull_request"`, `repositoryFullName: "<OWNER/REPO-or-provider-full-name>"`, `sourceBranch: "<current-branch>"`, `targetBranch: "<base-branch-for-this-repo>"`, `title: "<TITLE>"`, and `body` set to the exact `/tmp/pr-body.md` contents. Include `labels` only when a current conflict-resolver label is provided, and include `assignees` only when provider-compatible assignee usernames are available for this run. The tool creates a new draft pull request or refreshes the open one for the branch in a single call.</item>
        </pr-metadata-update-recipe>
        <validation>Every changed repository now has a corresponding created or refreshed draft pull request confirmed by a `mcp__roomote__manage_source_control` result, or a clearly reported blocker.</validation>
      </step>
    </steps>
  </phase>

  <phase name="validation">
    <description>Verify that every repository is represented in the final result and report the created or updated pull requests clearly.</description>
    <steps>
      <step number="7">
        <title>Report the created or updated pull requests</title>
        <description>Provide the user with a concise repository-by-repository summary of the created or updated pull requests.</description>
        <actions>
          <action>Report each created or updated pull request using the pull request title, repository name, whether it was created or refreshed, and the URL when available; if a URL cannot be recovered, report the pull request number and branch instead.</action>
          <action>Explicitly note that the resulting pull requests are drafts.</action>
        </actions>
        <validation>The summary includes every repository processed and no successful pull request creation or update is omitted.</validation>
      </step>
    </steps>
  </phase>

<completion_criteria>
<criterion>Every repository with changes or unpushed commits has been evaluated exactly once.</criterion>
<criterion>The delivery branch is created from the provided base/default branch, and new draft pull requests target that same base branch.</criterion>
<criterion>Each repository that required action has a pushed branch and a created or refreshed draft pull request.</criterion>
<criterion>When the same task ships through multiple pull requests, each draft PR body links the sibling PRs with current URLs.</criterion>
<criterion>When a single-PR refresh updates one draft PR from an already-split task, the refreshed PR body does not silently drop valid sibling PR links.</criterion>
<criterion>The final response lists the resulting pull requests clearly and accurately.</criterion>
</completion_criteria>
</workflow>

<best_practices>
<guideline priority="high">
<rule>Create or refresh a separate pull request for each changed repository rather than bundling unrelated repos together.</rule>
<rationale>Cross-repository work still needs per-repository review, CI, and merge tracking.</rationale>
<exceptions>None.</exceptions>
</guideline>
<guideline priority="high">
<rule>When the same task is split across multiple pull requests, make each draft PR description mention the sibling PRs and keep those links current.</rule>
<rationale>Reviewers need to understand the full change surface and any coupled frontend/backend or multi-repository changes.</rationale>
<exceptions>Skip the section only when there is truly only one PR for the task or no sibling PR URL can be recovered honestly.</exceptions>
</guideline>
<guideline priority="high">
<rule>Preserve commit and push validation hooks unless there is no safe alternative.</rule>
<rationale>Hook failures often indicate real formatting, linting, or typing problems that should be fixed before review.</rationale>
<exceptions>Only bypass as a last resort after diagnosing why the hook cannot be satisfied.</exceptions>
</guideline>
<guideline priority="medium">
<rule>Use descriptive branch names, conventional commit messages, and concise pull request copy.</rule>
<rationale>Reviewers need the branch, commit, and pull request metadata to explain intent quickly.</rationale>
<exceptions>Follow repository-specific naming conventions when they differ from the default pattern.</exceptions>
</guideline>
<guideline priority="medium">
<rule>Apply `Net PR Changes Only`: ground the pull request body in the final PR diff, then add conversation context only when it matches what actually changed.</rule>
<rationale>Reviewer-facing context becomes misleading when it repeats an earlier plan or conversation that the final code no longer reflects.</rationale>
<exceptions>If the change is an exact implementation of the user-stated request, use the conversation context directly.</exceptions>
</guideline>
</best_practices>

<patterns>
  <pattern name="workspace_detection">
    <description>Determine whether the workspace is a single repository or a multi-repository container before performing any git actions or source-control mutations.</description>
    <context>Use for any workflow that might operate across multiple repositories.</context>
    <template>Detect repositories, collect changed targets, and return early with a no-op when no targets require work.</template>
  </pattern>
  <pattern name="per_repository_execution">
    <description>Repeat the same metadata, commit, push, and creation steps for each changed repository.</description>
    <context>Use when the workspace may contain more than one repo that needs an output artifact.</context>
    <template>For each repository: analyze, commit if needed, push the branch, create or refresh the pull request, and capture the live pull request reference.</template>
  </pattern>
</patterns>

<decision_guidance>
<principles>
<principle>Prefer the git operations that safely produce a reviewable pull request.</principle>
<principle>Return early when there is no changed repository rather than creating empty pull requests.</principle>
<principle>Preserve repository-specific context instead of assuming one repository's metadata applies to another.</principle>
</principles>
<constraints>Use only script-safe git commands, pass user-controlled text through `mcp__roomote__manage_source_control` tool parameters instead of shell interpolation, and never skip reporting blockers.</constraints>
<boundaries>
<rule>This workflow handles repository detection, commit creation, branch pushing, and draft pull request creation.</rule>
<rule>This workflow does not decide product requirements or rewrite the requested code changes themselves.</rule>
<rule>When branch protection, authentication, or remote permissions block progress, surface the exact blocker to the user and conclude with a blocked result.</rule>
</boundaries>
</decision_guidance>

<examples>
  <example name="multi_repo_pull_request_creation">
    <scenario>A workspace contains two repositories with pending work that should each receive their own draft pull request.</scenario>
    <user_request>Create draft PRs for the current changes.</user_request>
    <workflow>
      <step number="1">
        <description>Detect the workspace shape and enumerate the changed repositories.</description>
        <approach>Run the workspace detection command and record both changed repositories.</approach>
        <expected_outcome>There is a concrete target list instead of an assumed single repository.</expected_outcome>
      </step>
      <step number="2">
        <description>Analyze each repository separately.</description>
        <approach>Derive a branch name, commit message, pull request title, and pull request body for each repository.</approach>
        <expected_outcome>Each repository has a full metadata bundle ready for execution.</expected_outcome>
      </step>
      <step number="3">
        <description>Commit, push, and create or refresh the pull requests.</description>
        <approach>Execute the git commands and `mcp__roomote__manage_source_control` calls repo by repo and capture each live pull request reference.</approach>
        <expected_outcome>Two distinct draft pull requests are created or updated and ready to report.</expected_outcome>
      </step>
    </workflow>
    <completion>The user receives a concise list of the created or updated pull requests, one for each repository.</completion>
    <key_takeaways>
      <takeaway>Multi-repository work still requires repository-specific pull request handling.</takeaway>
    </key_takeaways>
  </example>
</examples>

<error_handling>
<scenario name="no_changed_repositories">
<problem>No repository has uncommitted or unpushed work.</problem>
<causes>
<cause>The workspace is already clean.</cause>
<cause>All commits were already pushed and already have open pull requests.</cause>
</causes>
<recovery>Report a no-op result and tell the user there is nothing to package into a pull request.</recovery>
</scenario>
<scenario name="hook_or_push_failure">
<problem>A commit or push command fails.</problem>
<causes>
<cause>Pre-commit or pre-push checks failed.</cause>
<cause>The branch conflicts with remote permissions or branch protection.</cause>
</causes>
<recovery>Diagnose and fix the validation issue when possible; otherwise report the exact blocker instead of forcing completion.</recovery>
</scenario>
</error_handling>
