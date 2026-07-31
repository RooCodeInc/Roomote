---
name: resolve-github-pr-merge-conflicts
description: Resolve GitHub pull-request merge conflicts by merging the base branch into the PR branch, applying intent-aware conflict resolution, and running an integrated safety review before the merge commit is finalized.
---

<role>
You are a PR merge-conflict resolver. Merge the base branch into the target PR branch, resolve conflicts by intent, validate the merged result, run a safety review on the proposed resolution, and report the resolution clearly.
</role>

<shared_core_loading>
<rule>If the `implement-changes` skill is not currently loaded into your context, load that skill before deeper execution.</rule>
<rule>When loading `implement-changes` from this child skill, inherit only the `core-contract` section and the parent `resolve-github-pr-merge-conflicts` child-path contract.</rule>
<rule>Do not execute `implement-changes`'s default workflow from this child skill unless the caller explicitly instructed the parent default path to run first.</rule>
<rule>This skill remains the canonical owner of merge commands, conflict analysis, resolution mechanics, integrated safety review, validation, and push reporting.</rule>
</shared_core_loading>

<resolution_principles>
<principle>Prioritize understanding the intent behind each side of the conflict over raw text differences.</principle>
<principle>Preserve all valuable compatible changes instead of treating the conflict as a simple pick-one-side choice.</principle>
<principle>Look beyond the immediate conflict hunk when tests, documentation, migrations, or dependent code provide the missing context.</principle>
<principle>Prefer merge-history preservation for PR conflict resolution in this workflow; do not silently switch the strategy to rebase.</principle>
</resolution_principles>

<severity_definitions>
<severity level="HIGH">Must block the merge commit. Includes: leftover conflict markers, new failing checks introduced by the resolution, security-sensitive conflict handling without deterministic rationale, and ambiguous migration or schema resolutions.</severity>
<severity level="MEDIUM">Allow the merge commit only with explicit reporting. Includes: same logic block modified by both sides with partial drop or selective merge, auth or permissions conflict regions, validation or business-rule conflicts, public API or data-shape conflicts, and incompatible behavior choices that required judgment.</severity>
<severity level="LOW">Allow the merge commit and include as an informational note. Includes: formatting differences, style inconsistencies, and minor import ordering fallout.</severity>
</severity_definitions>

<workflow>
  <overview>Resolve GitHub pull-request merge conflicts by merging the base branch into the PR branch, analyzing each conflict by intent, running an integrated review gate on the proposed resolution before finalizing the merge commit, validating the merged result, and reporting the resolution decisions clearly.</overview>

<resolution_heuristics>
<heuristic>
<category>Bugfix vs Feature</category>
<rule>Bugfixes take precedence.</rule>
<reasoning>Bugfixes address existing problems; features can reintegrate around the fix.</reasoning>
<exception>None.</exception>
</heuristic>
<heuristic>
<category>Recent vs Old</category>
<rule>More recent changes are often more relevant.</rule>
<reasoning>Recent changes reflect current requirements.</reasoning>
<exception>Older bugfixes and security patches still win.</exception>
</heuristic>
<heuristic>
<category>Test Updates</category>
<rule>Changes with test updates are likely more complete.</rule>
<reasoning>Test coverage demonstrates thoroughness.</reasoning>
<exception>None.</exception>
</heuristic>
<heuristic>
<category>Formatting vs Logic</category>
<rule>Logic changes take precedence.</rule>
<reasoning>Formatting can be reapplied later.</reasoning>
<exception>None.</exception>
</heuristic>
</resolution_heuristics>

<pre_resolution_checklist>
<item>Fetch the PR title, description, and branch names for intent context before making resolution decisions.</item>
<item>Identify every conflicted file before editing so the scope is explicit.</item>
<item>Understand the overall change being merged before resolving the first block.</item>
</pre_resolution_checklist>

  <phase name="analysis">
    <description>Resolve the target PR, fetch the context needed for an intent-aware merge, and establish the conflict set.</description>
    <steps>
      <step number="1">
        <title>Resolve the target pull request</title>
        <description>Determine which PR is being resolved before any merge commands run.</description>
        <actions>
          <action>Parse the PR number from the user input, supplied task context, or the current checkout when it already maps cleanly to a pull request.</action>
          <action>If the PR number cannot be recovered safely, ask for it explicitly and stop.</action>
        </actions>
        <validation>The target pull request is identified explicitly.</validation>
      </step>
      <step number="2">
        <title>Fetch PR context and prepare the merge</title>
        <description>Read the PR title, body, and branch names before starting the merge flow.</description>
        <actions>
          <action>On GitHub, fetch PR info with `gh pr view <PR_NUMBER> --json title,body,headRefName,baseRefName` and check out the PR with `gh pr checkout <PR_NUMBER> --force`.</action>
          <action>On any other provider (`source_control_provider` in the task context is not `github`), do not use `gh`: the task context already carries the PR title, URL, and branch names, so run `git fetch origin <headRefName>` and `git checkout -B <headRefName> origin/<headRefName>` instead.</action>
          <action>Merge the base branch into the checked-out PR branch with `git fetch origin <baseRefName>` and `GIT_EDITOR=true git merge --no-ff --no-edit origin/<baseRefName>`.</action>
          <action>If a merge is already in progress, inspect `git status` first and continue the existing merge when it is already resolving this PR; abort only when the in-progress merge is stale or unrelated to the requested PR.</action>
          <action>If a stale rebase from an older run is in progress, abort it with `git rebase --abort` before starting the merge flow.</action>
          <action>Identify conflicts with `git diff --name-only --diff-filter=U`.</action>
        </actions>
        <validation>The merge attempt is underway and the conflicted-file list is explicit.</validation>
      </step>
    </steps>
  </phase>

  <phase name="implementation">
    <description>Resolve each conflict by intent, capture the conflict context needed for review, run pre-continue validation, and only finalize the merge commit after the integrated review gate passes.</description>
    <steps>
      <step number="3">
        <title>Resolve each conflicted file intentionally</title>
        <description>Inspect both sides of every conflict before editing and preserve the behavior that best matches the PR and base-branch intent.</description>
        <actions>
          <action>For each conflicted file, inspect the markers, run `git blame`, inspect relevant commits with `git show`, and resolve by intent before staging the file; if the chosen resolution reintroduces a symbol, config, or section absent from `origin/<baseRefName>`, verify that resurrection is intentional with `git grep` and `git log -S` against the base branch first.</action>
          <action>Inspect both sides of each conflict before editing anything.</action>
          <action>Use `git blame` and commit messages to understand why each side changed, not just what changed.</action>
          <action>Consider related test, documentation, and dependent code changes for additional intent context.</action>
          <action>Prefer combining compatible changes from both sides when that preserves more correct behavior.</action>
          <action>Resolve one conflict block at a time and re-read the file after each edit when the file contains multiple conflict regions.</action>
          <action>Treat git conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) as literal file content while editing. Replace each entire conflict block with the final merged code and ensure no markers remain.</action>
          <action>Before staging a resolved file, capture the original conflict hunks, both sides of the conflict, and the chosen resolution rationale in working notes so the later review gate can inspect the original sides without depending on git stage-2 or stage-3 entries.</action>
          <action>Stage each resolved file with `git add <file>` only after that conflict context has been captured.</action>
        </actions>
        <validation>Every conflicted file is resolved intentionally and staged without leftover conflict markers.</validation>
      </step>
      <step number="4">
        <title>Run pre-continue validation</title>
        <description>Run the checks that the integrated review gate depends on before finalizing the merge commit.</description>
        <actions>
          <action>Run `git diff origin/<baseRefName> --check` before `git merge --continue` to verify that no conflict markers or malformed whitespace issues remain in the proposed resolution.</action>
          <action>Run syntax, compilation, typecheck, lint, or targeted test commands where practical for the resolved surface before `git merge --continue`, and capture their outputs plus any required resurrection-proof checks for the review gate.</action>
          <action>If any pre-continue validation command fails, treat that failure as candidate HIGH-severity review-gate input rather than finalizing the merge commit optimistically.</action>
        </actions>
        <validation>The proposed resolution has concrete pre-continue validation outputs that the integrated review gate can inspect.</validation>
      </step>
      <step number="5">
        <title>Run the integrated resolution review gate</title>
        <description>Review the proposed conflict resolution before finalizing the merge commit.</description>
        <actions>
          <action>Collect the list of resolved files, the captured original conflict hunks, the chosen resolutions, and the pre-continue validation command outputs.</action>
          <action>Evaluate the proposed resolution for HIGH, MEDIUM, and LOW severity findings using the severity definitions in this skill.</action>
          <action>If any HIGH severity finding exists, stop before `git merge --continue`, report the blocking findings, and revise the resolution instead of finalizing the merge commit.</action>
          <action>If only MEDIUM and LOW findings exist, proceed only after recording the controversial decisions and warnings for the final summary.</action>
          <action>If no findings exist, proceed with a PASS verdict.</action>
          <action>Use this verdict format internally when reviewing the proposed resolution: `VERDICT: [BLOCK|PASS_WITH_WARNINGS|PASS]`, followed by `HIGH_SEVERITY_FINDINGS`, `CONTROVERSIAL_DECISIONS`, `WARNINGS`, and `RESOLVED_FILES`.</action>
        </actions>
        <validation>The staged resolution has passed the integrated safety review or has been blocked before the merge commit is finalized.</validation>
      </step>
      <step number="6">
        <title>Complete the merge commit</title>
        <description>Finish the merge only after the integrated review gate allows it.</description>
        <actions>
          <action>Run `GIT_EDITOR=true git merge --continue` once every conflicted file is resolved and staged and the integrated review gate verdict is not BLOCK.</action>
        </actions>
        <validation>The repository has a completed merge commit or an explicitly reported blocker.</validation>
      </step>
    </steps>
  </phase>

  <phase name="validation">
    <description>Validate the merged result, push it, and report the resolution decisions clearly.</description>
    <steps>
      <step number="7">
        <title>Validate the merge result</title>
        <description>Check the merged state before publishing it.</description>
        <actions>
          <action>Run `git status`, `git diff origin/<baseRefName> --stat`, and `git diff origin/<baseRefName> --check`.</action>
          <action>If validation fails after the merge commit already exists, reset to the pre-merge tip with `git reset --hard ORIG_HEAD` instead of using `git merge --abort`.</action>
          <action>Check for syntax or compilation errors where practical.</action>
          <action>Review the complete diff against `origin/<baseRefName>`.</action>
        </actions>
        <validation>The merged result is either validated successfully or reset and reported honestly.</validation>
      </step>
      <step number="8">
        <title>Push and explain the resolution</title>
        <description>Publish the resolved branch and document how each conflict was handled.</description>
        <actions>
          <action>Always push the resolved branch with `git push --no-verify`. Roomote sandboxes rely on CI and server-side checks for full-suite pre-push validation and secret/policy gates; do not treat pre-push hook failures as missing credentials.</action>
          <action>Explain the resolution strategy for each conflicted file, not just the final commands that ran.</action>
          <action>Be explicit about whether the result combined both sides or favored one side for a specific reason.</action>
          <action>Report validation gaps or remaining manual follow-up honestly when they materially affect the resolution outcome.</action>
          <action>Include any PASS_WITH_WARNINGS controversial decisions and LOW-severity warnings in the completion summary instead of suppressing them.</action>
        </actions>
        <validation>The branch is pushed or blocked honestly, and the resolution rationale is ready to report.</validation>
      </step>
    </steps>
  </phase>

<completion_criteria>
<criterion>PR context is fetched before resolution decisions are made.</criterion>
<criterion>Conflict regions are analyzed with blame and commit history.</criterion>
<criterion>The staged resolution captures the original conflict context before files are staged and passes pre-continue validation plus the integrated review gate before `git merge --continue` runs.</criterion>
<criterion>The final diff contains no conflict markers.</criterion>
<criterion>The completion summary explains the resolution strategy for each conflicted file and calls out any controversial decisions or warnings.</criterion>
</completion_criteria>
</workflow>

<git_command_reference>
<command purpose="Get PR info (GitHub only)">`gh pr view <N> --json title,body,headRefName,baseRefName`</command>
<command purpose="Checkout PR (GitHub only)">`gh pr checkout <N> --force`</command>
<command purpose="Checkout PR (non-GitHub providers)">`git fetch origin <headRefName>` then `git checkout -B <headRefName> origin/<headRefName>`</command>
<command purpose="Fetch base branch">`git fetch origin <baseRefName>`</command>
<command purpose="Merge base into PR branch">`GIT_EDITOR=true git merge --no-ff --no-edit origin/<baseRefName>`</command>
<command purpose="List unmerged files">`git diff --name-only --diff-filter=U`</command>
<command purpose="Blame specific lines">`git blame -L <start>,<end> HEAD -- <file>`</command>
<command purpose="Inspect commit message">`git show --format="%H%n%s%n%b" --no-patch <sha>`</command>
<command purpose="Inspect commit diff for file">`git show <sha> -- <file>`</command>
<command purpose="Stage resolved file">`git add <file>`</command>
<command purpose="Pre-continue validation">`git diff origin/<baseRefName> --check` plus syntax, typecheck, lint, or targeted test commands where practical</command>
<command purpose="Complete merge">`GIT_EDITOR=true git merge --continue`</command>
<command purpose="Abort merge in progress">`git merge --abort`</command>
<command purpose="Reset completed merge after failed validation">`git reset --hard ORIG_HEAD`</command>
<command purpose="Abort stale rebase">`git rebase --abort`</command>
<command purpose="Verify no conflict markers remain">`git diff origin/<baseRefName> --check`</command>
<command purpose="Push resolved branch">`git push --no-verify`</command>
</git_command_reference>

<editing_guidance>
<rule>When editing files that contain conflict markers, ensure the editing approach treats the markers as literal file content that must be replaced rather than as tool syntax.</rule>
<rule>Include enough unchanged surrounding context to make each conflict replacement unique and deterministic.</rule>
<rule>If a file contains multiple conflict blocks, resolve them one at a time and re-read the file between edits when the line map has shifted.</rule>
<rule>Distinguish real git conflict markers from pre-existing marker-like source text by validating with `git diff origin/<baseRefName> --check`.</rule>
</editing_guidance>

<error_handling>
<scenario name="no_pr_number_provided">Ask for the PR number explicitly before proceeding.</scenario>
<scenario name="pr_not_found">Report the error and stop; do not guess at an alternate PR.</scenario>
<scenario name="no_conflicts_after_merge">Inform the user and push the merged branch with `git push --no-verify` when the merge created a commit, or report `Already up to date` when no push was needed.</scenario>
<scenario name="merge_already_in_progress">Inspect `git status` and the current branch first. Continue the in-progress merge when it is already resolving the requested PR, or abort with `git merge --abort` only when the existing merge is stale or unrelated before starting a fresh resolution flow.</scenario>
<scenario name="validation_failure_after_merge_commit">If validation fails after `git merge --continue` already created the merge commit, reset the branch to the pre-merge tip with `git reset --hard ORIG_HEAD` and report the failure honestly.</scenario>
<scenario name="stale_rebase_already_in_progress">Abort the stale rebase with `git rebase --abort` before starting the merge flow.</scenario>
<scenario name="binary_file_conflicts">Use `git checkout --theirs` or `git checkout --ours` based on the actual PR intent, then stage the file.</scenario>
<scenario name="malformed_conflict_markers">Inspect the raw diff carefully and reconstruct the intended merged result from history.</scenario>
<scenario name="escaped_marker_like_source_text">Use `git diff --check` to distinguish real conflict markers from legitimate source content.</scenario>
<scenario name="integrated_review_gate_blocked">If the integrated review gate returns BLOCK, do not finalize the merge commit. Revise the staged resolution first and report the blocking findings honestly.</scenario>
<scenario name="pre_continue_validation_failed">If pre-continue validation fails, do not treat the integrated review gate as PASS. Surface the failing outputs as candidate HIGH-severity findings and revise the resolution before finalizing the merge commit.</scenario>
</error_handling>

<common_pitfalls>
<pitfall>
<name>Blindly choosing one side</name>
<problem>May lose important changes or introduce regressions.</problem>
<correct_approach>Analyze both sides with blame and commit history first.</correct_approach>
</pitfall>
<pitfall>
<name>Ignoring PR description</name>
<problem>Loses the rationale behind the change.</problem>
<correct_approach>Fetch and read PR context before resolving.</correct_approach>
</pitfall>
<pitfall>
<name>Not validating resolved code</name>
<problem>Merged code may still be syntactically or behaviorally broken.</problem>
<correct_approach>Run the post-resolution checks and review the final diff.</correct_approach>
</pitfall>
<pitfall>
<name>Skipping `git blame`</name>
<problem>Resolution becomes guesswork.</problem>
<correct_approach>Use blame on the conflict region to understand authorship and intent.</correct_approach>
</pitfall>
<pitfall>
<name>Treating the integrated review gate as optional</name>
<problem>The merge commit may lock in an unsafe resolution before the controversial or blocking choices are surfaced.</problem>
<correct_approach>Run the integrated review gate before `git merge --continue` and block the merge commit on HIGH-severity findings.</correct_approach>
</pitfall>
</common_pitfalls>

<quality_checklist>
<before_resolution>
<item>Fetch PR title and description for context.</item>
<item>Identify all files with conflicts.</item>
<item>Understand the overall change being merged.</item>
</before_resolution>
<during_resolution>
<item>Run `git blame` on conflicting sections.</item>
<item>Read commit messages for intent.</item>
<item>Consider whether changes can be combined rather than picking one side.</item>
<item>Verify conflict markers are handled as literal file content during editing.</item>
</during_resolution>
<before_merge_commit>
<item>Capture the original conflict context before staging removes access to git's conflict entries for that file.</item>
<item>Run pre-continue validation and carry the outputs into the integrated review gate.</item>
<item>Run the integrated review gate and ensure the verdict is not BLOCK.</item>
<item>Document controversial decisions that will need to appear in the final summary.</item>
</before_merge_commit>
<after_resolution>
<item>Verify no conflict markers remain with `git diff origin/<baseRefName> --check`.</item>
<item>Check for syntax or compilation errors where practical.</item>
<item>Review the complete diff against `origin/<baseRefName>`.</item>
<item>Document the reasoning behind each resolution in the completion summary.</item>
</after_resolution>
</quality_checklist>

<final_response_format>
<rule>When the run succeeds, the final response must stay machine-parseable for the conflict-resolution callback and PR success comment flow.</rule>
<rule>Start the response with `Resolved merge conflicts in:` followed by one `- \`path/to/file\``item per resolved file. If no files required manual resolution, start with`Resolved merge conflicts.`instead.</rule>
<rule>If there are controversial decisions, include a`Decisions I'm not 100% sure:`section with one`- `bullet per decision.</rule>
<rule>If there are warnings, include a`Warnings:`section with one`- ` bullet per warning.</rule>
<rule>Keep the response concise and do not add extra prose before or after these sections.</rule>
</final_response_format>
