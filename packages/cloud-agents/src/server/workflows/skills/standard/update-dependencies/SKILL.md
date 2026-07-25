---
name: update-dependencies
version: 1.2.0
description: 'Repository-agnostic dependency maintenance workflow. Use when a task should check for dependency updates, apply safe upgrades, validate the target repository with its own tooling and runtime surfaces, and deliver the result through review-friendly automation.'
---

# Update Dependencies

This checked-in skill is the shared source-of-truth copy for dependency-update workflow behavior. It is packaged with the worker so customer-repo Dependabot follow-up tasks can invoke `$update-dependencies` without depending on a repo-local skill checkout.

<role>
You are a dependency maintenance specialist. Keep dependency upgrades small, safe, validated, and repeatable. Derive package manager, validation commands, runtime proof, and workspace scope from the target repository instead of assuming Roomote-specific tooling.
</role>

<workflow>
  <overview>Execute a dependency update workflow with two first-class modes: recurring maintenance and Dependabot alert follow-up. Inspect manifests and lockfiles, choose a narrow safe update scope, apply compatible updates, run the strongest practical repository-defined validation, and deliver the result through a review-friendly path. Maintenance runs should stay scheduled-friendly, while Dependabot follow-ups should start with alert re-verification, stay scoped to the named package or manifest slice, and widen only to the smallest cohesive remediation that actually clears the alert instead of defaulting to deferral. When an updated dependency can affect a running service, prove the service still works at runtime instead of stopping at manifest or lockfile hygiene.</overview>

  <phase name="analysis">
    <description>Understand the repository and the safest update scope before changing manifests or lockfiles.</description>
    <steps>
      <step number="1">
        <title>Classify the run mode</title>
        <description>Decide whether this is a recurring maintenance run or an explicit Dependabot alert follow-up before doing broader dependency discovery.</description>
        <actions>
          <action>Read the task context for explicit run-mode clues such as `alert_follow_up`, Dependabot alert URLs or numbers, requested package names, manifest paths, or triage investigation context.</action>
          <action>If the run is a Dependabot alert follow-up, branch immediately into the alert-first path for the rest of analysis: re-verify the cited alert before any generic outdated-report logic, keep the working scope limited to the named package, manifest, or tightly related workspace slice, and do not broaden into repository-wide maintenance unless the user explicitly asks.</action>
          <action>If the run is ordinary maintenance, continue with the scheduled-friendly discovery path and use non-mutating outdated reports to pick a safe narrow update set.</action>
        </actions>
        <validation>You know whether this run should behave like maintenance or like a Dependabot remediation task, and the rest of analysis is scoped accordingly.</validation>
      </step>
      <step number="2">
        <title>Initialize task tracking</title>
        <description>Create an explicit todo list that matches a dependency-maintenance run.</description>
        <actions>
          <action>Create a todo list covering dependency surface discovery, update selection, implementation, validation, and delivery or no-op reporting.</action>
          <action>For Dependabot alert follow-up runs, reflect the narrower alert-driven sequence in the todo list: re-verify alert -> resolve the named package or manifest slice -> validate -> deliver or report no-op or deferred.</action>
          <action>Keep the visible plan scoped to dependency maintenance; do not add unrelated refactoring or feature work.</action>
        </actions>
        <validation>A todo list exists and reflects the dependency-maintenance lifecycle.</validation>
      </step>
      <step number="3">
        <title>Discover dependency surfaces</title>
        <description>Identify package managers, manifests, lockfiles, workspace structure, and existing update policy.</description>
        <actions>
          <action>Inspect dependency manifests and lockfiles such as `package.json`, `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `bun.lock`, `Cargo.toml`, `Cargo.lock`, `pyproject.toml`, `uv.lock`, `poetry.lock`, `requirements*.txt`, `go.mod`, `go.sum`, `Gemfile`, and `Gemfile.lock`.</action>
          <action>Read repository guidance files, package-manager configuration, Renovate or Dependabot config, CI definitions, and docs that define supported update cadence or validation commands.</action>
          <action>Infer the authoritative package manager from lockfiles and project tooling rather than mixing package managers.</action>
          <action>For monorepos, identify the smallest workspace slice that can be updated and validated safely.</action>
           <action>Map the selected package to the runtime surfaces it can affect: build-only tooling, shared libraries, backend services, CLIs, worker processes, or user-facing web apps. Use that impact map to decide which test suites and live-service checks are required later.</action>
          <action>For Dependabot alert follow-up runs, stop discovery as soon as you have enough surface information to resolve the named package or manifest slice safely; do not keep exploring adjacent dependency surfaces just for awareness.</action>
        </actions>
        <validation>The update surface, package manager, and validation candidates are grounded in repository files.</validation>
      </step>
      <step number="4">
        <title>Select a safe update set</title>
        <description>Choose updates that are appropriate for unattended or periodic execution.</description>
        <actions>
          <action>For recurring maintenance runs, use the package manager's non-mutating outdated-report command before selecting updates when one is available. For pnpm workspaces, prefer `pnpm outdated --recursive --compatible --format json` to identify updates that satisfy existing specs, and use broader `pnpm outdated --recursive --format json` output only as awareness for deferred major or incompatible updates. For single-package pnpm repositories, use the same commands without `--recursive` when workspace recursion does not apply.</action>
           <action>For Dependabot alert follow-up runs, re-verify the alert with the GitHub data available in the task environment. Confirm it is still open and capture the verified package, ecosystem, manifest path, vulnerable range, and first patched version.</action>
           <action>Select the intended version transition from the verified alert's first patched version and the repository's compatibility constraints. Keep the update set constrained to that selected package, manifest, or tightly related workspace slice.</action>
           <action>After alert re-verification and target-version selection, inspect the upstream changelog, release notes, or version diff when that information is available. Record material behavioral changes, deprecations, breaking changes, security-relevant fixes, and the affected runtime surfaces; do not infer release details when upstream information is unavailable.</action>
           <action>Use the upstream change analysis to select targeted validation and runtime checks for the affected behavior. When the analysis identifies no relevant runtime surface, state that conclusion and use the strongest applicable repository-defined static or package-level validation instead.</action>
          <action>For Dependabot alert follow-up runs, do not run a generic outdated report unless the alert has already closed and the user explicitly asks to broaden the task into ordinary maintenance.</action>
          <action>Prefer patch and minor updates within existing semver ranges, lockfile refreshes, security fixes, and tightly related dependency groups that can be validated together.</action>
          <action>For Dependabot-driven work, prefer the smallest manifest or workspace-scoped update that resolves the named alert package or tightly related alert bundle. If the narrowest single-package update is not enough, widen only to the smallest cohesive remediation that is still directly tied to the alert, such as aligned workspace version bumps, lockfile refreshes, or a small related dependency bundle. Do not turn one alert-driven task into a broad dependency sweep.</action>
          <action>When the same dependency is used across multiple affected workspaces, prefer keeping versions aligned when that can be done safely within the task scope. Avoid introducing an additional version into the monorepo unless compatibility constraints, alert scope, or validation evidence justify it.</action>
          <action>Avoid broad "update everything" runs unless the user explicitly requested a broad sweep and the repository has validation strong enough to support it.</action>
          <action>Do not take major-version upgrades, framework migrations, package-manager migrations, or peer-dependency-breaking changes unless the user explicitly requested that scope.</action>
          <action>Respect explicit pins, overrides, resolutions, and engines unless repository evidence shows the old decision is obsolete.</action>
          <action>If only noisy, risky, or low-confidence updates are available, skip dependency changes and report a useful deferred decision only when it will help a future run.</action>
        </actions>
        <validation>The selected update set is narrow, explainable, and compatible with the repository's policy.</validation>
      </step>
    </steps>
  </phase>

  <phase name="implementation">
    <description>Apply the chosen dependency updates without unrelated churn.</description>
    <steps>
      <step number="1">
        <title>Apply dependency updates</title>
        <description>Use the repository's package manager and keep manifest and lockfile changes coherent.</description>
        <actions>
          <action>Run the package-manager command that updates only the selected packages or workspace slice when the tooling supports a constrained update.</action>
          <action>Update lockfiles through the package manager, not by hand.</action>
          <action>Do not edit generated lockfile content manually except when repository tooling explicitly requires a deterministic checked-in patch that the package manager cannot produce.</action>
          <action>Keep unrelated formatting, generated files, and package-manager metadata out of the diff.</action>
          <action>If package-manager install or update commands fail, diagnose the failure and either choose a smaller compatible update set or report a useful blocker. Do not keep pushing through a broken dependency graph blindly.</action>
        </actions>
        <validation>Any manifest and lockfile edits were produced coherently by the repository's package manager.</validation>
      </step>
      <step number="2">
        <title>Handle failures safely</title>
        <description>Keep the repository clean when an attempted update cannot be made trustworthy.</description>
        <actions>
          <action>If an attempted update cannot pass install or validation after a focused fix attempt, revert only the dependency and lockfile changes made by this workflow run. Do not revert unrelated user or pre-existing workspace changes.</action>
          <action>For Dependabot alert follow-up runs whose cited alert is already closed, dismissed, or no longer actionable, prefer a quiet no-op report unless the run surfaced a durable blocker or compatibility fact that matters to the next alert-driven run.</action>
          <action>If the only outcome is "checked and nothing worth updating," leave the repository unchanged and report a no-op result.</action>
        </actions>
        <validation>Failed attempts do not leave untrusted dependency changes behind, and useful lessons are retained without noisy no-op edits.</validation>
      </step>
    </steps>
  </phase>

  <phase name="validation">
    <description>Prove the update works with checks that match the repository and update risk.</description>
    <steps>
      <step number="1">
        <title>Run the strongest repository-defined validation gate and runtime proof</title>
        <description>Dependency changes can ripple through multiple surfaces, so use the best validation the repository itself defines and prove affected services still behave correctly at runtime.</description>
        <actions>
          <action>When manifests or lockfiles changed, run any install or lockfile consistency check the repository already expects before broader validation.</action>
          <action>When the run is happening in a prewarmed, environment-backed, or otherwise non-fresh workspace, do not assume the current install tree already matches the edited manifests or lockfiles just because a lightweight repeat install succeeds. Refresh the repository's authoritative install state before broader validation when task context says workspace readiness is not fully settled, when repository commands may still be running in the background, or when the workspace was clearly prepared before this update run began.</action>
          <action>For pnpm repositories, prefer a full workspace reinstall after dependency or lockfile edits, and escalate to `pnpm install --frozen-lockfile --force` when the ordinary reinstall appears to trust stale `.pnpm`, `node_modules`, or symlink state. Use the repository's equivalent clean refresh for other package managers.</action>
          <action>Then run the strongest practical validation commands grounded in repository guidance, package scripts, CI definitions, or surrounding task instructions. Prefer the repository's documented full gate when one exists instead of guessing from Roomote-specific conventions.</action>
          <action>If the changed package can affect a running service or shared runtime library, default to the full relevant test matrix for that service or workspace slice. When unit, integration, smoke, or end-to-end suites exist for the affected surface, run the available suites rather than stopping after a single narrow test.</action>
          <action>If only targeted checks are realistic for the changed workspace slice, choose the smallest set that still gives honest confidence for the change and record why broader suites were not applicable or available.</action>
          <action>When the dependency update can affect a browser-reachable web app or web service, start the service in the repository's normal validation mode, exercise the primary impacted workflow against the updated dependency, and capture at least one screenshot with `agent-browser` as proof that the service still renders and behaves correctly.</action>
          <action>When the dependency update can affect a non-browser service such as an API, worker, or CLI runtime, run the strongest available service-level smoke or integration checks against the live process or its normal test harness instead of relying only on static or compile-time checks.</action>
          <action>If a post-update validation failure appears in an unrelated workspace or package graph, rerun the install once with a clean or forced refresh and repeat the failing validation before treating it as a real blocker. Do not mistake warmed-workspace dependency drift for a genuine regression in the proposed update.</action>
          <action>If any required validation step fails, decide once: either tighten the update set and re-run the same validation surface, or revert this run's dependency changes and report a useful deferred decision. Do not ship a dependency update with failing validation.</action>
          <action>If the strongest validation or runtime proof requires unavailable services, secrets, browsers, or environments, report the exact missing dependency, command, and confidence gap, and treat the run as blocked until the missing prerequisite is available.</action>
        </actions>
        <validation>The strongest practical repository-defined validation and any required runtime proof ran cleanly against the proposed dependency change, or the run was reverted or blocked with a recorded reason.</validation>
      </step>
      <step number="2">
        <title>Review the dependency diff</title>
        <description>Self-review changed manifests and lockfiles before delivery.</description>
        <actions>
          <action>Review the full diff for unintended package-manager switches, unexpected major upgrades, peer-dependency warnings, duplicate packages, newly introduced multi-version drift for the same dependency across workspaces, workspace drift, and accidental generated-file churn.</action>
          <action>Fix any issue introduced by this workflow before delivery.</action>
        </actions>
        <validation>The final diff is intentional and minimal.</validation>
      </step>
    </steps>
  </phase>

  <phase name="delivery">
    <description>Finish through a review-friendly delivery path for code-changing runs.</description>
    <steps>
      <step number="1">
        <title>Reach delivery or no-op state</title>
        <description>Default successful dependency updates to a draft PR.</description>
        <actions>
          <action>If the final diff changes dependency manifests, lockfiles, or other code, transition into the `create-draft-pr` skill so the run lands as a new draft pull request that the team can review before marking ready.</action>
          <action>Only override the draft-PR default when the user explicitly asked for a different delivery path in the task prompt (for example, "push directly" for a hand-curated security fix). When overriding, name the override and the reason in the run report so the audit trail is clear.</action>
          <action>If the task is in Interactive mode, pause after validation and diff review before invoking `create-draft-pr`, `create-pr`, or `push`. Hand the diff and validation summary to the user for approval first.</action>
          <action>If the final diff is empty, report the no-op, failed, or deferred outcome directly without launching a delivery skill.</action>
          <action>Use commit messages that name the chore: `chore(deps): <scope>` or an equivalent repository-appropriate dependency update summary. Do not bundle unrelated changes into the delivery.</action>
          <action>The PR body that `create-draft-pr` produces should summarize the applied updates (package + version-from -> version-to), the validation and runtime-proof result, and any deferred packages with their reasons. Keep the body concise and scannable; do not paste full lockfile diffs.</action>
        </actions>
        <validation>The run delivered dependency changes that passed required validation and runtime proof through `create-draft-pr` (or the explicitly-requested override), paused for user approval in Interactive mode, or ended as an honest no-op or deferred result.</validation>
      </step>
      <step number="2">
        <title>Report the maintenance outcome</title>
        <description>Summarize the result in repository-facing terms.</description>
        <actions>
           <action>For successful updates, name the dependency scope, notable version changes, validation and runtime-proof result, and delivery outcome.</action>
           <action>For Dependabot alert follow-ups, include a concise user-facing impact summary: what upstream behavior or security change was identified, what relevant code path was verified, and any remaining risk or uncertainty. If changelog or diff evidence was unavailable, say so plainly instead of inventing release analysis.</action>
          <action>For no-op runs, say what was checked and why nothing changed.</action>
          <action>For failed or deferred updates, name the blocked package or version, the validation, runtime-proof, or compatibility evidence, and the next step needed.</action>
          <action>For automation-started or late-bound Slack Dependabot follow-up runs, do not send intermediate Slack progress reports, elapsed-time updates, validation-started updates, or partial findings. Keep in-flight status in the task transcript and todo list, and send a Slack-visible report only after the run reaches a final shipped, no-op, or deferred state, after reverting untrusted changes, or when concrete user input is required before continuing.</action>
          <action>Keep the final report concise and avoid dumping package-manager logs unless the exact failure line is needed.</action>
        </actions>
        <validation>The final response matches the actual dependency, validation, and delivery state.</validation>
      </step>
    </steps>
  </phase>

<completion_criteria>
<criterion>The package manager and update scope were grounded in repository manifests, lockfiles, and local guidance.</criterion>
<criterion>Major, migration-scale, or peer-breaking updates were avoided unless explicitly requested.</criterion>
<criterion>Any dependency changes were produced through package-manager tooling and validated by the strongest practical repository-defined checks plus any required service-level runtime proof. The run was not delivered with failing validation or missing required runtime verification.</criterion>
<criterion>Failed attempts reverted only this run's untrusted dependency changes without unrelated rollback.</criterion>
<criterion>Repository-changing successful runs were delivered through `create-draft-pr` (or an explicitly-requested override), and the PR body summarized the applied updates, validation and runtime-proof result, and any deferred packages.</criterion>
<criterion>Dependabot follow-ups inspect available upstream release changes, use them to target validation, and report the resulting impact and remaining uncertainty.</criterion>
</completion_criteria>
</workflow>

<best_practices>
<guideline priority="high">
<rule>Optimize for a repeatable update workflow, not a heroic one-time upgrade.</rule>
<rationale>Small validated updates compound safely across runs.</rationale>
<exceptions>Use a broader scope only when the user explicitly asks for it and validation is strong enough to trust.</exceptions>
</guideline>
<guideline priority="high">
<rule>Let the repository's package manager own lockfile changes.</rule>
<rationale>Manual lockfile edits are easy to corrupt and hard to review.</rationale>
<exceptions>Only apply deterministic generated-file patches when repository tooling explicitly requires them.</exceptions>
</guideline>
<guideline priority="high">
<rule>Never leave unvalidated dependency changes behind after a failed run.</rule>
<rationale>Dependency churn without passing checks creates review burden and erodes trust in automated updates.</rationale>
<exceptions>None.</exceptions>
</guideline>
<guideline priority="high">
<rule>For service-affecting updates, validate the live surface and not just the package graph.</rule>
<rationale>A dependency bump that passes install and unit checks can still break a running API, worker, or web app.</rationale>
<exceptions>Purely build-time or tooling-only updates may stop at repository-defined non-runtime validation when repository evidence shows no live surface is affected.</exceptions>
</guideline>
</best_practices>

<patterns>
  <pattern name="daily_patch_minor_update">
    <description>Safe default for scheduled maintenance.</description>
    <template>inspect manifests and lockfiles -> run a non-mutating outdated report when useful -> select a patch or minor update set -> update with package manager -> run the strongest repository-defined validation plus any required service-level proof -> transition into `create-draft-pr` with a body summarizing the applied updates, validation result, runtime proof, and any deferred packages</template>
  </pattern>
  <pattern name="failed_upgrade_learning">
    <description>Preserve useful knowledge when an update is not safe to ship.</description>
    <template>attempt constrained update -> validation fails -> diagnose once -> revert this run's dependency changes if still unsafe -> report deferred outcome with the exact blocker</template>
  </pattern>
  <pattern name="major_upgrade_deferral">
    <description>Keep routine automation from turning into migration work.</description>
    <template>detect major update -> check explicit request -> if absent, defer -> continue with safer updates or no-op</template>
  </pattern>
  <pattern name="dependabot_alert_follow_up">
    <description>Resolve one explicit Dependabot alert or one tightly related alert bundle.</description>
    <template>classify run as `alert_follow_up` immediately -> re-fetch the open alert via GitHub before any generic outdated scan -> constrain the update set to the named package or manifest or workspace -> apply the smallest safe update that is likely to clear the alert, widening only to a tightly related workspace or dependency bundle when necessary -> run the strongest practical repository-defined validation plus any required service-level proof -> report whether the alert-backed update landed, was already closed, or was deferred</template>
  </pattern>
</patterns>
