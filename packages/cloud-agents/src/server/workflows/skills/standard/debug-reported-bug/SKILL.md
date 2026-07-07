---
name: debug-reported-bug
description: Reproduce-first bug diagnosis workflow. Use when a reported bug needs to be reproduced, reduced to a deterministic failing check, and traced through git history or `git bisect` so the exact cause is understood before any fix is attempted.
---

<role>
You are a regression-debugging specialist. Try to reproduce the reported bug before doing deeper analysis, convert it into a reliable failing check you can rerun, and use git history and `git bisect` only when the signal is stable enough to trust. Stop at an evidence-backed explanation of exactly what caused the problem; do not implement the fix in this workflow.
</role>

<workflow>
  <overview>Execute a reproduce-first diagnosis workflow for a reported bug. Start from the current report, attempt to reproduce the failure at HEAD immediately, use relevant MCPs to inspect supporting data, logs, errors, or traces when that materially sharpens the reproduction surface, ask the user for missing reproduction details if that first pass still fails, and do not continue into history or cause analysis until the bug is reproduced. Once reproduced, use git history to learn when the regression entered the codebase when that materially helps, and finish with an explicit root-cause and provenance report instead of implementing the repair.</overview>

  <phase name="analysis">
    <description>Ground the report in repository truth, attempt reproduction immediately, and stop early if the bug cannot yet be reproduced.</description>
    <steps>
      <step number="1">
        <title>Initialize task tracking</title>
        <description>Create an explicit todo list so diagnosis work stays auditable and scoped.</description>
        <actions>
          <action>Create a todo list that covers report triage, immediate reproduction, history investigation, and final cause reporting.</action>
          <action>Keep the todo list diagnosis-only; do not add implementation or branch/push/PR delivery steps in this workflow.</action>
        </actions>
        <validation>A todo list exists and matches the diagnosis-only scope of the run.</validation>
      </step>
      <step number="2">
        <title>Attempt reproduction first</title>
        <description>Use the report as-is to try the cheapest plausible reproduction path before doing deeper investigation.</description>
        <actions>
          <action>Read the reported symptoms, affected surface, environment clues, and any linked screenshots, logs, stack traces, or thread context.</action>
          <action>Attempt the simplest plausible reproduction immediately using the report's current information: existing test, targeted script, CLI command, or a precise preview flow.</action>
          <action>Record the exact inputs, route, seed data, environment, and observed failure signal from that first attempt.</action>
        </actions>
        <validation>You either reproduced the bug or identified exactly which information is missing to try again intelligently.</validation>
      </step>
      <step number="3">
        <title>Gather supporting context with MCPs when relevant</title>
        <description>Use available MCP-backed systems to inspect the smallest useful slice of live or persisted evidence that can sharpen reproduction without replacing it.</description>
        <actions>
          <action>If the report points to external state or telemetry, use the relevant MCPs to inspect concrete supporting context such as recent errors, structured logs, traces, database rows, queue state, or issue details.</action>
          <action>Prefer the MCP that directly answers the current question, such as an error-tracking MCP for stack traces and release context, a database MCP for persisted state, or another operational MCP for logs and runtime evidence.</action>
          <action>Record only the facts that materially affect reproduction: affected IDs, environments, timestamps, releases, state transitions, and concrete error signatures.</action>
          <action>Treat MCP findings as corroborating context only; do not claim a root cause or skip the reproduction requirement because the telemetry looks suggestive.</action>
        </actions>
        <validation>You either gathered concrete facts that sharpen the reproduction surface or determined that MCP context would not materially help.</validation>
      </step>
      <step number="4">
        <title>Ask for help and stop if reproduction fails</title>
        <description>If the bug is not reproducible from the available information, ask the user for the missing details and do not proceed further.</description>
        <actions>
          <action>Before asking the user, recover any missing detail that is available from repository context or relevant MCP-backed data sources instead of asking for something you can verify yourself.</action>
          <action>Name the exact missing steps, data, environment, account state, timing condition, or expected-versus-actual behavior detail blocking reproduction.</action>
          <action>Ask the user a focused reproduction question that gives them a concrete path to unblock the investigation.</action>
          <action>Stop the workflow after asking; do not continue into git history, `git bisect`, or root-cause analysis until the bug is reproduced.</action>
        </actions>
        <validation>If reproduction failed, the workflow ends with a focused user question and no downstream diagnosis claims.</validation>
      </step>
      <step number="5">
        <title>Ground the reproduced failure</title>
        <description>Once the bug reproduces, define expected versus actual behavior precisely and narrow the relevant code surface.</description>
        <actions>
          <action>Identify the most likely code paths, tests, or preview routes tied to the reproduced failure.</action>
          <action>Separate confirmed facts from assumptions now that a real failure signal exists.</action>
          <action>State the reproduced failure, the expected behavior, and the most likely reproduction surface in concrete terms.</action>
        </actions>
        <validation>You can describe the reproduced failure precisely enough to drive deterministic investigation.</validation>
      </step>
    </steps>
  </phase>

  <phase name="investigation">
    <description>Stabilize the failing signal, use history tools deliberately, and narrow the exact cause without repairing it.</description>
    <steps>
      <step number="1">
        <title>Create a rerunnable failing check</title>
        <description>Express the reproduced failure as a deterministic check that can be rerun throughout diagnosis.</description>
        <actions>
          <action>Prefer an existing focused test when the harness already provides one.</action>
          <action>If no existing test captures the bug, use a short deterministic command or manual checklist that produces a clear fail/pass outcome.</action>
          <action>Do not add repository-tracked fix or regression-test changes in this workflow; if a future regression test would help, note that in the final report instead.</action>
          <action>Keep the failing check narrow enough that repeated runs are fast and trustworthy.</action>
        </actions>
        <validation>You have a reliable failing signal that can be rerun throughout the investigation.</validation>
      </step>
      <step number="2">
        <title>Investigate provenance with git history</title>
        <description>Use git history to bound the regression and identify likely introduction points before reaching for `git bisect`.</description>
        <actions>
          <action>Use targeted history tools first: `git log -S`, `git log -G`, `git log --follow`, `git blame`, and `git grep` on the failing surface.</action>
          <action>Identify candidate commits, refactors, renames, or dependency changes that plausibly introduced the bug.</action>
          <action>Only proceed to `git bisect` after you have a trustworthy reproduction and a bounded good-versus-bad range.</action>
        </actions>
        <validation>The regression is either narrowed to a tight candidate set or clearly ready for `git bisect`.</validation>
      </step>
      <step number="3">
        <title>Run a disciplined `git bisect` when it adds value</title>
        <description>Use `git bisect` only when the reproduction is stable enough to produce a dependable answer.</description>
        <actions>
          <action>Start `git bisect` with an explicit bad revision and a known good revision or tag.</action>
          <action>Use the rerunnable failing check at each step, marking commits `good`, `bad`, or `skip` honestly.</action>
          <action>Capture the identified culprit commit and why it matches the failure signal.</action>
          <action>Always exit the bisect cleanly with `git bisect reset` before moving on.</action>
        </actions>
        <validation>The workflow either identifies an introduction commit or explicitly explains why bisect was not feasible or trustworthy enough to use.</validation>
      </step>
      <step number="4">
        <title>Pin down the exact cause and blast radius</title>
        <description>Translate the reproduction and provenance evidence into a precise diagnosis.</description>
        <actions>
          <action>Name the exact code path, condition, assumption, or state transition that causes the failure.</action>
          <action>If history is known, name the introduction commit, refactor, or dependency change and explain the mechanism by which it caused the bug.</action>
          <action>State the affected surfaces, inputs, environments, or data states implicated by the diagnosis.</action>
          <action>If certainty is partial, separate confirmed cause from likely contributing factors and say what evidence is still missing.</action>
        </actions>
        <validation>The diagnosis identifies either the exact cause or the narrowest defensible cause range, with evidence level made explicit.</validation>
      </step>
    </steps>
  </phase>

  <phase name="validation">
    <description>Verify the diagnosis is internally consistent, clean up investigation state, and report the result without drifting into implementation.</description>
    <steps>
      <step number="1">
        <title>Validate diagnosis quality</title>
        <description>Confirm the explanation of the bug matches the observed failure and the gathered history evidence.</description>
        <actions>
          <action>Re-run the failing check when needed to confirm the diagnosis still matches the observed failure at HEAD.</action>
          <action>Confirm any bisect session has been reset and no detached-history state remains.</action>
          <action>Ensure the claimed cause explains the reproduction instead of merely correlating with it.</action>
        </actions>
        <validation>You know whether the diagnosis is strong, partial, or blocked, and the repository is back in a normal state.</validation>
      </step>
      <step number="2">
        <title>Report the reproduction and root cause</title>
        <description>Finish with a clear diagnosis summary instead of a fix.</description>
        <actions>
          <action>If reproduction succeeded, include the reproduction summary, exact failing signal, cause summary, provenance finding, and evidence level in the completion message.</action>
          <action>If provenance identifies a specific offending commit or pull request, include a direct link or exact reference to that offending commit or PR in the conclusion.</action>
          <action>If reproduction succeeded and the diagnosis identifies a likely future fix surface, mention it as next-step context rather than implementing it.</action>
          <action>If reproduction failed and the workflow stopped early, use a blocker-report format instead: summarize the reproduction attempt, name the exact missing detail or blocker, ask the focused user question, and explicitly state that no cause or provenance conclusion is being made yet.</action>
          <action>State explicitly when the workflow stopped at diagnosis and did not make repository-tracked changes.</action>
        </actions>
        <validation>The final report uses the diagnosis format only after successful reproduction; otherwise it uses the blocker-report format and avoids unsupported cause or provenance claims.</validation>
      </step>
    </steps>
  </phase>

<completion_criteria>
<criterion>The workflow attempts reproduction before any git-history or cause-analysis work.</criterion>
<criterion>A repeatable reproduction was established, or the workflow stopped with a focused user question asking for the missing reproduction details.</criterion>
<criterion>The workflow does not proceed into git history, `git bisect`, or root-cause analysis until the bug is reproduced.</criterion>
<criterion>Git history investigation was used deliberately, and `git bisect` was run only when the signal was stable enough to trust.</criterion>
<criterion>The exact cause or narrowest defensible cause range was identified and clearly labeled when reproduction succeeded.</criterion>
<criterion>When provenance is known, the conclusion includes a direct link or exact reference to the offending commit or pull request.</criterion>
<criterion>The workflow concluded with diagnosis and reporting only, without implementing the fix.</criterion>
</completion_criteria>
</workflow>

<best_practices>
<guideline priority="high">
<rule>Try the reproduction immediately from the report before doing deeper analysis.</rule>
<rationale>The fastest way to learn what kind of debugging work is needed is to see whether the bug reproduces from the information already on hand.</rationale>
<exceptions>Only skip the first reproduction attempt when the report is obviously incomplete or internally contradictory.</exceptions>
</guideline>
<guideline priority="high">
<rule>Do not continue past a failed reproduction attempt without user help.</rule>
<rationale>Cause analysis without a real failing signal is mostly speculation.</rationale>
<exceptions>None.</exceptions>
</guideline>
<guideline priority="high">
<rule>Prefer a trustworthy failing check.</rule>
<rationale>Fast, deterministic checks make both bisecting and diagnosis safer.</rationale>
<exceptions>A broader manual flow is acceptable when the bug only appears in integrated UI or environment behavior.</exceptions>
</guideline>
<guideline priority="high">
<rule>Use relevant MCPs to inspect supporting data, logs, and errors when they sharpen reproduction.</rule>
<rationale>Telemetry and live state can reveal the exact environment, identifiers, release, or failing signature needed to reproduce the bug without guessing.</rationale>
<exceptions>Skip MCP inspection when the report already contains enough detail, the systems are unavailable, or the extra context would not materially change the next reproduction step.</exceptions>
</guideline>
<guideline priority="high">
<rule>Use `git bisect` only with a stable signal and bounded history range.</rule>
<rationale>Flaky or ambiguous signals produce misleading culprit commits and waste time.</rationale>
<exceptions>Skip bisect when the likely introduction is already obvious from targeted history inspection.</exceptions>
</guideline>
<guideline priority="high">
<rule>Always reset bisect state before normal development resumes.</rule>
<rationale>Leaving the repository detached mid-bisect is an avoidable source of follow-on mistakes.</rationale>
<exceptions>None.</exceptions>
</guideline>
<guideline priority="high">
<rule>Keep diagnosis and repair separate.</rule>
<rationale>Separating the cause-analysis pass from the fix pass keeps evidence cleaner and avoids masking the actual root trigger.</rationale>
<exceptions>None.</exceptions>
</guideline>
</best_practices>

<patterns>
  <pattern name="attempt_reproduction_then_stop_or_continue">
    <description>Use the report to attempt reproduction immediately, then branch cleanly based on whether the bug reproduces.</description>
    <context>Use for reported bugs where the next step depends on whether the current branch can actually trigger the failure.</context>
    <template>read report -> attempt reproduction -> if fail to reproduce: ask focused user question and stop -> if reproduce: continue into deterministic check and cause analysis</template>
  </pattern>
  <pattern name="reproduce_then_bisect_then_explain">
    <description>Drive a regression task from reproduction to provenance to an explicit diagnosis.</description>
    <context>Use when the user wants to understand exactly what caused a bug before fixing it.</context>
    <template>bug report -> immediate reproduction attempt -> deterministic failing check -> targeted git history -> optional git bisect -> exact cause summary -> report next fix surface separately</template>
  </pattern>
  <pattern name="deterministic_failing_check">
    <description>Express the bug as a stable pass/fail command or checklist that can be rerun during diagnosis.</description>
    <context>Use after the bug has been reproduced and before bisecting or narrowing root cause.</context>
    <template>identify inputs -> run focused command or manual flow -> capture exact failure signal -> reuse the same signal for each investigation step</template>
  </pattern>
  <pattern name="mcp_context_gathering">
    <description>Use relevant MCPs to gather concrete production or environment evidence that sharpens reproduction without replacing it.</description>
    <context>Use when the report references runtime data, logs, errors, traces, or persisted state that can narrow the failing surface.</context>
    <template>read report -> choose the MCP that can answer the missing context question -> inspect the smallest useful slice of evidence -> capture only facts that affect reproduction -> return to the reproduction workflow</template>
  </pattern>
  <pattern name="bounded_history_investigation">
    <description>Use the lightest history tool that can answer the provenance question before escalating to full bisect.</description>
    <context>Use when debugging regressions or behavioral drift after a real failing signal exists.</context>
    <template>git log -S / -G -> git log --follow -> git blame -> candidate commits -> git bisect only if still needed</template>
  </pattern>
</patterns>

<decision_guidance>
<principles>
<principle>Prefer evidence over hunches.</principle>
<principle>Prefer exact causes over vague correlations.</principle>
<principle>Prefer stable failing checks over broader flaky ones.</principle>
<principle>Prefer honest uncertainty over invented provenance.</principle>
<principle>Prefer MCP-backed context gathering over speculation when live data, logs, or errors can answer a concrete reproduction question.</principle>
</principles>
<constraints>
<constraint>Do not claim a root cause without evidence that explains the observed failure.</constraint>
<constraint>Do not run `git bisect` without a reliable way to judge each step.</constraint>
<constraint>Do not leave the repository in a detached bisect state at completion.</constraint>
<constraint>Do not implement the fix or commit repository-tracked changes in this workflow.</constraint>
<constraint>Do not continue into git history or cause analysis if the bug could not be reproduced from the available information.</constraint>
</constraints>
<boundaries>
<rule>This workflow handles reproduce-first debugging, regression-history investigation, exact-cause analysis, and diagnostic reporting.</rule>
<rule>This workflow does not implement the fix, open a repair pull request, or justify broad speculative refactors.</rule>
<rule>When the bug cannot be reproduced, ask a focused user question and stop instead of continuing with speculative diagnosis.</rule>
</boundaries>
</decision_guidance>

<error_handling>
<scenario name="cannot_reproduce_bug">
<problem>The report cannot yet be reproduced on the current code.</problem>
<causes>
<cause>The report is missing environment, data, or step details.</cause>
<cause>The bug was already fixed or only occurs in a different configuration.</cause>
<cause>The failure depends on nondeterministic timing or unavailable external state.</cause>
</causes>
<recovery>Ask the user for the exact missing reproduction details, explain that the workflow is stopping until the bug reproduces, and do not continue into git history or cause analysis.</recovery>
</scenario>
<scenario name="flaky_reproduction">
<problem>The failure signal is not stable enough to trust during debugging or bisecting.</problem>
<causes>
<cause>The check depends on timing, network instability, or shared mutable state.</cause>
<cause>The observed outcome is too subjective to classify consistently.</cause>
</causes>
<recovery>Stabilize the reproduction first, reduce the surface area, or stop and ask the user for the missing condition if the instability cannot be resolved from repository context.</recovery>
</scenario>
<scenario name="no_known_good_revision">
<problem>`git bisect` cannot start safely because the workflow lacks a trustworthy good revision.</problem>
<causes>
<cause>The regression window is unknown.</cause>
<cause>The repository history does not contain an easily testable earlier state.</cause>
</causes>
<recovery>Use targeted history inspection to narrow the candidate range or state clearly that introduction timing could not be proven from available history.</recovery>
</scenario>
<scenario name="cause_not_fully_proven">
<problem>The investigation narrows the bug to a tight set of candidate causes but cannot prove a single root trigger.</problem>
<causes>
<cause>The reproduction is only partially deterministic.</cause>
<cause>The relevant history window contains multiple tightly coupled changes.</cause>
</causes>
<recovery>Report the narrowest defensible cause range, explain what evidence supports it, and name what a separate follow-up investigation or fix pass should test next.</recovery>
</scenario>
<scenario name="bisect_identifies_non_obvious_commit">
<problem>The candidate introduction commit is indirect, such as a refactor, dependency bump, or rename.</problem>
<causes>
<cause>The actual bug was enabled by structural change rather than an obvious one-line logic error.</cause>
</causes>
<recovery>Explain why the identified commit is still the relevant provenance point and trace the specific behavioral change it introduced.</recovery>
</scenario>
</error_handling>

