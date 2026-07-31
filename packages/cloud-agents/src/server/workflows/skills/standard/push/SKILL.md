---
name: push
description: Push local commits or existing unpushed commits to the remote without opening pull requests. Stage and commit any uncommitted changes first, keep existing unpushed history when present, and report the follow-up pull request command.
---

<role>
You are executing a command to push work to remote branches without creating a pull request. Stage and commit any unstaged changes first when needed, keep existing unpushed commits when present, then push the result.
</role>

<shared_core_loading>
<rule>If the `implement-changes` skill is not currently loaded into your context, load that skill before deeper execution.</rule>
<rule>When loading `implement-changes` from this child skill, inherit only the `core-contract` section and the matching parent child-path contract for this workflow.</rule>
<rule>Do not execute `implement-changes`'s default workflow from this child skill unless the caller explicitly instructed the parent default path to run first.</rule>
<rule>This child skill remains the canonical owner of its delivery mechanics even when the parent skill is loaded for shared context.</rule>
</shared_core_loading>

<workflow>
  <overview>Push the current changes or existing unpushed commits to remote branches without opening pull requests, handling both single-repository and multi-repository workspaces.</overview>
  <initial_determination>
    <detection_patterns>
      <pattern type="single_repo">
        <indicator>The current directory contains a `.git` directory.</indicator>
      </pattern>
      <pattern type="multi_repo">
        <indicator>The current directory contains child repositories rather than being the active repository itself.</indicator>
      </pattern>
      <pattern type="no_changes">
        <indicator>No repository has uncommitted changes or unpushed commits after detection.</indicator>
      </pattern>
    </detection_patterns>
  </initial_determination>

  <phase name="analysis">
    <description>Find every repository that requires a pushed branch and determine the names and commit metadata that should be used.</description>
    <steps>
      <step number="1">
        <title>Detect the workspace layout and changed repositories</title>
        <description>Establish whether the workflow should operate on one repository or many, then collect all repositories that need a branch push.</description>
        <actions>
          <action>Run `echo "=== Workspace Detection ===" && pwd && echo "" && if [ -d ".git" ]; then echo "WORKSPACE_TYPE: SINGLE_REPO"; echo "REPO_DIR: $(pwd)"; echo "REPO_NAME: $(git remote get-url origin 2>/dev/null | sed -E 's|.*[:/]([^/]+/[^/]+)$|\1|' | sed 's/\.git$//' || basename $(pwd))"; else echo "WORKSPACE_TYPE: MULTI_REPO"; echo "=== Repos with Changes ==="; workspace_root=$(pwd); shopt -s nullglob; for repo_dir in */; do if [ -d "$workspace_root/${repo_dir}.git" ]; then cd "$workspace_root/$repo_dir"; has_changes=false; if [ -n "$(git status --porcelain 2>/dev/null)" ]; then has_changes=true; fi; if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then if [ -n "$(git log @{u}..HEAD --oneline 2>/dev/null)" ]; then has_changes=true; fi; elif [ -n "$(git log HEAD --not --remotes=origin --oneline 2>/dev/null)" ]; then has_changes=true; fi; if [ "$has_changes" = "true" ]; then repo_name=$(git remote get-url origin 2>/dev/null | sed -E 's|.*[:/]([^/]+/[^/]+)$|\1|' | sed 's/\.git$//' || basename $(pwd)); echo "CHANGED_REPO: ${repo_dir%/} -> $repo_name"; fi; fi; done; cd "$workspace_root"; for owner_dir in */; do if [ ! -d "$workspace_root/${owner_dir}.git" ]; then cd "$workspace_root"; for repo_dir in "$owner_dir"*/; do if [ -d "$workspace_root/${repo_dir}.git" ]; then cd "$workspace_root/$repo_dir"; has_changes=false; if [ -n "$(git status --porcelain 2>/dev/null)" ]; then has_changes=true; fi; if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then if [ -n "$(git log @{u}..HEAD --oneline 2>/dev/null)" ]; then has_changes=true; fi; elif [ -n "$(git log HEAD --not --remotes=origin --oneline 2>/dev/null)" ]; then has_changes=true; fi; if [ "$has_changes" = "true" ]; then repo_name=$(git remote get-url origin 2>/dev/null | sed -E 's|.*[:/]([^/]+/[^/]+)$|\1|' | sed 's/\.git$//' || basename $(pwd)); echo "CHANGED_REPO: ${repo_dir%/} -> $repo_name"; fi; fi; done; cd "$workspace_root"; fi; done; shopt -u nullglob; cd "$workspace_root"; fi`.</action>
          <action>Stop and report that there is nothing to push if the detection phase finds no changed repositories.</action>
        </actions>
        <validation>The target repository list is explicit and complete before any commits or pushes occur.</validation>
      </step>
      <step number="2">
        <title>Determine the branch name and commit message for each repository</title>
        <description>Inspect the outstanding work so the pushed branch and any required commit reflect the actual intent of the change.</description>
        <actions>
          <action>For each repository, run `cd <REPO_DIR> && echo "=== Analyzing $(basename $(pwd)) ===" && git remote get-url origin && git status && (git diff --stat HEAD 2>/dev/null || git diff --stat) && (if git rev-parse --abbrev-ref --symbolic-full-name @{u} >/dev/null 2>&1; then git log @{u}..HEAD --oneline; else git log HEAD --not --remotes=origin --oneline; fi || echo "No commits yet")`.</action>
          <action>Choose a branch name using `feature/<short-description>-<TASK_ID>` or `fix/<short-description>-<TASK_ID>`.</action>
          <action>Choose a conventional commit message for repositories that still need a local commit.</action>
        </actions>
        <validation>Each repository has a branch name, repository identifier, and commit message when a commit is required.</validation>
      </step>
    </steps>
  </phase>

  <phase name="implementation">
    <description>Create or reuse the delivery head branch, commit pending work when necessary, and push the resulting branch to the remote.</description>
    <steps>
      <step number="3">
        <title>Create the branch and commit pending work</title>
        <description>Ensure the repository is on a delivery branch created from the provided base/default branch and convert working tree changes into a commit when needed.</description>
        <actions>
          <action>For each repository, determine the current branch and the provided base/default branch for this run. If no branch is provided for the run, use the repository default branch.</action>
          <action>Fetch the provided base branch with `cd <REPO_DIR> && git fetch origin <base-branch-for-this-repo>`.</action>
          <action>If a new delivery branch is needed, run `cd <REPO_DIR> && git checkout -b <branch-name-for-this-repo> origin/<base-branch-for-this-repo>` before staging or committing pending work. If already on an explicit existing delivery branch for this task, keep it.</action>
          <action>For each repository with working tree changes, run `cd <REPO_DIR> && git add -A && git diff --cached --name-status`.</action>
          <action>After `git add -A`, explicitly compare `git diff --cached --name-status` against the intended deliverables for this task. If any staged path is unexpected, unstage it with `git restore --staged <path>` before committing. Treat generated or untracked files as excluded by default unless they are clearly part of the requested delivery.</action>
          <action>After the staged-path review is complete, for each repository with working tree changes run `cd <REPO_DIR> && git commit -m '<commit-message-for-this-repo>'`.</action>
          <action>If the repository already has unpushed commits and no working tree changes, skip only the commit while still ensuring the branch is correct.</action>
          <action>If pre-commit hooks fail, fix the underlying formatting or validation issue. Do not use `git commit --no-verify` unless no safer option remains.</action>
        </actions>
        <validation>Each repository is on a delivery branch created from the provided base/default branch, or is explicitly identified as already on an existing delivery branch for this task.</validation>
      </step>
      <step number="4">
        <title>Push the branch for each repository</title>
        <description>Publish the resulting branch to the remote so the work is available for later pull request creation.</description>
        <actions>
          <action>Before pushing, review the outgoing diff for secrets. List what changed with `git diff --stat @{u}..HEAD`, then scan the patch content itself with `git diff @{u}..HEAD | grep -nEi '(api[_-]?key|secret|passwo?rd|BEGIN [A-Z ]*PRIVATE KEY|xox[baprs]-|ghp_|github_pat_|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16})'` and read every hit in context. When the branch has no upstream yet, use `origin/<base-branch-for-this-repo>..HEAD` as the range. Do not limit the read to configuration files: a leaked token is just as likely to sit in source, a test fixture, or a captured log. If `gitleaks` is on PATH, also run `gitleaks git --log-opts='@{u}..HEAD'`; its absence does not excuse the manual review. Treat any real credential as a hard blocker: do not push, remove it from the commit before any retry, report it, and tell the user the credential must be rotated.</action>
          <action>For each repository, always run `cd <REPO_DIR> && git push --no-verify -u origin HEAD`. Use `-u origin HEAD` unconditionally: a branch created with `git checkout -b <branch> origin/<base>` already has an upstream of `origin/<base>`, so a bare `git push` fatals on the branch-name mismatch. Pre-push hooks commonly re-run full lint/typecheck/test suites, and in Roomote sandboxes those frequently fail on host tooling differences rather than on real defects, which agents then misreport as missing Git credentials. Skipping pre-push also skips any local secret or policy scanner the repository attaches to that hook, and equivalent server-side coverage is not guaranteed, which is why the secret review above is mandatory rather than optional.</action>
          <action>If the push still fails, classify the error before reporting it. A rejection that names a secret, credential, key, or policy violation is a real finding, not an environment problem: that covers `remote:` push-protection rejections such as GitHub `GH013` and any hook output naming a leaked credential. Stop, report it, strip the secret from the commit, and never retry those with `--no-verify`. Otherwise, `remote:` lines, HTTP 403, `Permission denied`, `Authentication failed`, or a credential prompt are remote or auth failures, while a non-zero exit printed by the repository's local hook manager (husky, lefthook, pre-commit, simple-git-hooks, or `.git/hooks/`) is a hook failure. Report the exact error text and never substitute a credentials story for a hook failure.</action>
          <action>Record the pushed repository and branch for final reporting.</action>
        </actions>
        <validation>Every targeted repository has a confirmed pushed branch or a clearly reported blocker.</validation>
      </step>
    </steps>
  </phase>

  <phase name="validation">
    <description>Summarize the pushed branches clearly so the user can move directly into pull request creation if desired.</description>
    <steps>
      <step number="5">
        <title>Report the pushed branches and next step</title>
        <description>Provide the repository, branch, and follow-up pull-request path for each pushed target.</description>
        <actions>
          <action>Report each repository and pushed branch in a concise structured summary.</action>
          <action>Offer pull request creation as the follow-up step for each pushed branch: a `create-pr` run delivers it through the provider-neutral `mcp__roomote__manage_source_control` tool, so do not suggest provider-specific CLI commands such as `gh pr create`.</action>
          <action>Mention the org-configured conflict resolver label supplied in the task context so a follow-up pull request run can apply it.</action>
        </actions>
        <validation>The final report includes every pushed branch and gives the user an immediate next step for opening a pull request.</validation>
      </step>
    </steps>
  </phase>

<completion_criteria>
<criterion>Every repository with changes or unpushed commits has been processed exactly once.</criterion>
<criterion>Each targeted repository has a pushed branch or a clearly surfaced blocker.</criterion>
<criterion>The final summary tells the user how to open a pull request for each pushed branch.</criterion>
</completion_criteria>
</workflow>

<best_practices>
<guideline priority="high">
<rule>Push one branch per changed repository rather than mixing repository state in the final report.</rule>
<rationale>Repository-specific reporting makes later pull request creation predictable and auditable.</rationale>
<exceptions>None.</exceptions>
</guideline>
<guideline priority="high">
<rule>Use conventional commit messages and branch names that encode the intent of the change.</rule>
<rationale>Pushed work should remain understandable when reviewed later outside the current task context.</rationale>
<exceptions>Use repository-specific conventions if they are stricter than the default pattern.</exceptions>
</guideline>
<guideline priority="high">
<rule>Review the outgoing diff for secrets, then always push with `git push --no-verify` (or `git push --no-verify -u origin HEAD`) in Roomote sandboxes.</rule>
<rationale>Pre-commit catches real local formatting problems cheaply. Pre-push hooks re-run full lint/typecheck/test suites against host tooling the sandbox does not have, so they create false delivery failures that get misreported as missing Git credentials. Skipping pre-push also skips any local secret or policy scanner the repository attaches to that hook, and equivalent server-side coverage is not guaranteed, so the agent owns the secret review rather than assuming CI does.</rationale>
<exceptions>None for sandbox delivery unless repo-local `AGENTS.md` or the task explicitly requires pre-push hooks to run. Still fix pre-commit hook failures that block the commit itself.</exceptions>
</guideline>
</best_practices>

<patterns>
  <pattern name="workspace_detection">
    <description>Detect whether work must happen in one repository or many before issuing git commands.</description>
    <context>Use for any branch-push workflow.</context>
    <template>Detect repositories, gather changed targets, and short-circuit if there is nothing to push.</template>
  </pattern>
  <pattern name="push_without_pull_request">
    <description>Push work remotely without immediately opening a pull request.</description>
    <context>Use when the user wants backup, collaboration, or later review rather than immediate PR creation.</context>
    <template>Choose branch and commit metadata, create or reuse the branch, push it, then report the follow-up PR command.</template>
  </pattern>
</patterns>

<decision_guidance>
<principles>
<principle>Prefer pushing work remotely over leaving it stranded in ephemeral local state.</principle>
<principle>Do not create a pull request when the user explicitly asked only for a branch push.</principle>
<principle>Stop and report blockers rather than pretending the branch was pushed when it was not.</principle>
</principles>
<constraints>Use only non-interactive git commands, push with `--no-verify` so local pre-push hook suites do not block delivery, and avoid destructive history rewriting unless the user explicitly asked for it.</constraints>
<boundaries>
<rule>This workflow handles branch creation, optional commits, remote push, and push reporting.</rule>
<rule>This workflow does not open pull requests automatically.</rule>
<rule>When authentication, branch protection, or remote policy blocks the push, surface the blocker and stop.</rule>
</boundaries>
</decision_guidance>

<examples>
  <example name="push_two_repository_workspace">
    <scenario>The workspace contains two repositories with pending work that should be pushed remotely but not yet packaged into pull requests.</scenario>
    <user_request>Push these changes to branches but do not create PRs.</user_request>
    <workflow>
      <step number="1">
        <description>Identify both repositories that have work to push.</description>
        <approach>Run the workspace detection command and record the changed repositories.</approach>
        <expected_outcome>Both repositories are queued for branch creation and push.</expected_outcome>
      </step>
      <step number="2">
        <description>Create the branch and commit state for each repository.</description>
        <approach>Choose branch names and conventional commit messages based on the repository-specific diffs.</approach>
        <expected_outcome>Each repository is on a reviewable branch with the local work committed when needed.</expected_outcome>
      </step>
      <step number="3">
        <description>Push both branches and report the follow-up pull request commands.</description>
        <approach>Review each outgoing diff for secrets, run `git push --no-verify -u origin HEAD` per repository, and summarize the next command for each one.</approach>
        <expected_outcome>The user can immediately create pull requests later without losing the work.</expected_outcome>
      </step>
    </workflow>
    <completion>The work is safely pushed to remote branches and the user receives exact next-step commands.</completion>
    <key_takeaways>
      <takeaway>Pushing a branch is a valid endpoint even when pull request creation is intentionally deferred.</takeaway>
    </key_takeaways>
  </example>
</examples>

<error_handling>
<scenario name="no_repository_needs_push">
<problem>There is nothing to commit or push.</problem>
<causes>
<cause>The workspace is already clean and synchronized with the remote.</cause>
<cause>The requested work was already pushed earlier.</cause>
</causes>
<recovery>Stop and tell the user that no push action is needed.</recovery>
</scenario>
<scenario name="push_blocked_by_validation_or_permissions">
<problem>The branch cannot be pushed.</problem>
<causes>
<cause>Remote permissions, branch protection, or authentication prevent the push after `git push --no-verify` (primary path already skips local pre-push hooks).</cause>
<cause>Server-side push protection rejected a real secret, which is a finding to report rather than a blocker to work around.</cause>
<cause>An agent incorrectly ran a verifying push; re-run with `--no-verify` as required for sandboxes.</cause>
<cause>Pre-commit hooks blocked the commit before a push was attempted.</cause>
</causes>
<recovery>Always push with `--no-verify` first. If a verifying push was used by mistake, re-run with `--no-verify`. If that still fails, classify the failure by the source of the error text before reporting it, surface the exact remote error, and stop rather than claiming the push succeeded.</recovery>
</scenario>
</error_handling>
