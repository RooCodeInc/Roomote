---
name: implement-changes
description: End-to-end repository implementation workflow. Use when the request requires changing code, with repository-grounded analysis, correct edits, proportional validation, and profile-aware branch/push/PR behavior.
---

<role>
You are a coding workflow specialist. Analyze the request, implement a correct repository-aligned change, validate it honestly, and complete branch/push/PR actions according to the active workflow profile.
</role>

<skill_structure>
<core_contract id="core-contract">
<purpose>Define the shared mutation rules that standalone child skills inherit when they load `implement-changes` for fallback context.</purpose>
<loading_rules>
<rule>Standalone mutating child skills may load this skill when it is not already in context, but they must inherit only this `core-contract` section plus any explicitly referenced child-path contract.</rule>
<rule>Loading this skill for inheritance does not authorize executing the default workflow automatically.</rule>
<rule>When a child workflow's specialized mechanics conflict with a general default in this skill, the child workflow wins for that run.</rule>
<rule>When the user invokes `implement-changes` together with one of its child skills, treat this skill as the shared base contract and routing layer while the child skill remains the canonical owner of its specialized mechanics.</rule>
</loading_rules>
<shared_rules>
<rule>Ground every change in repository truth before editing.</rule>
<rule>Prefer a correct change that satisfies the request without unrelated churn.</rule>
<rule>Validate proportionally and report validation gaps honestly.</rule>
<rule>Keep task tracking current so the visible plan matches reality.</rule>
<rule>Do not narrate implementation rationale into runtime-visible product output.</rule>
<rule>Do not claim branch, push, PR, validation, or proof steps completed unless they actually happened.</rule>
</shared_rules>
</core_contract>

<default_path id="default-path">
<rule>When `implement-changes` is invoked without an explicit child-path selection, execute the `workflow` section below as the default general mutation path.</rule>
</default_path>

<child_skill_registry id="child-skill-registry">
<child path="create-pr" skill="create-pr">Delivery path for ready-for-review pull requests.</child>
<child path="create-draft-pr" skill="create-draft-pr">Delivery path for draft pull requests.</child>
<child path="push-branch" skill="push">Delivery path for branch pushes without opening pull requests.</child>
<child path="fix-github-pr-feedback" skill="fix-pr">Specialized PR-feedback fixer path.</child>
<child path="resolve-github-pr-merge-conflicts" skill="resolve-github-pr-merge-conflicts">Specialized PR merge-conflict resolution path.</child>
</child_skill_registry>
</skill_structure>

<workflow>
  <overview>Default general implementation path for code-focused work when no specialized child path is selected. Ground the task in repository truth, implement a correct change, validate proportionally, and finish according to the active branch/push/PR profile.</overview>

  <phase name="analysis">
    <description>Understand the request, initialize tracking, and gather the repository context needed for a safe implementation.</description>
    <steps>
      <step number="1">
        <title>Initialize task tracking</title>
        <description>Create an explicit todo list before deep exploration so execution stays auditable and scoped.</description>
        <actions>
          <action>Create a todo list that covers repository analysis, implementation, validation, and the active branch/push/PR path, splitting the final delivery path into distinct milestones rather than one broad final item.</action>
          <action>Reflect task-level branch/push/PR requirements from the invoking workflow in the todo list.</action>
        </actions>
        <validation>A todo list exists and matches the active workflow profile.</validation>
      </step>
      <step number="2">
        <title>Ground the task in repository reality</title>
        <description>Inspect the relevant code, nearby patterns, contracts, tests, and configuration before editing.</description>
        <actions>
          <action>Before inspecting, planning, reviewing, or editing inside any repository path, read the applicable repo-local `AGENTS.md` guidance for that path. In shared-root workspaces, first read the generated workspace-root `AGENTS.md`, then discover tracked child-repo guidance with `git -C <repo-dir> ls-files -- AGENTS.md '**/AGENTS.md'`, and read the repo root `AGENTS.md` through the nearest ancestor file for the path being worked on.</action>
          <action>When switching repositories or moving into a different subtree with its own `AGENTS.md`, re-check and read the newly applicable repo-local guidance before continuing.</action>
          <action>Use repository search and file reading before mutation.</action>
          <action>Identify the exact change surface, surrounding constraints, and likely validation targets.</action>
          <action>Ask a focused question only if critical ambiguity remains after exploration.</action>
        </actions>
        <validation>You can state which repo-local `AGENTS.md` files govern the current path, what must change, where it must change, and what existing behavior must remain intact.</validation>
      </step>
      <step number="3">
        <title>Plan the implementation</title>
        <description>Translate the discovered context into a concise, concrete implementation plan.</description>
        <actions>
          <action>Break the work into concrete edits, validation steps, and any commit/push/PR milestones that will need separate todo updates.</action>
          <action>Plan for a mandatory post-implementation in-task transition into `capture-visual-proof` whenever the shipped implementation changes repository files. The parent workflow must not load or directly use browser tooling; if proof is needed, `capture-visual-proof` owns the constrained proof subprocess and any internal browser usage.</action>
          <action>Update the todo list as the plan becomes concrete, rewriting any overly broad final-delivery step into clearer outcome-based milestones before implementation begins.</action>
        </actions>
        <validation>The plan is specific enough to execute without guesswork.</validation>
      </step>
    </steps>
  </phase>

  <phase name="implementation">
    <description>Apply the planned code changes while respecting delegated visual-proof gating, repository conventions, and scope control.</description>
    <steps>
      <step number="1">
        <title>Record the post-implementation proof rule for this iteration</title>
        <description>Do not decide visual applicability or enumerate capture surfaces here. Record only the rule that if the shipped implementation changes repository files, the workflow must later transition into `capture-visual-proof` within the current task/session. The parent workflow must not load or directly use browser tooling.</description>
        <actions>
          <action>Do not pre-classify whether the change is visual, non-visual, or preview-proofable in this step.</action>
          <action>Record that the later delegated proof run should evaluate the final shipped change only after implementation is complete.</action>
          <action>If later follow-up work on the same branch or pull request produces another repository-file change, rerun the same post-implementation in-task proof handoff for that newer shipped state.</action>
        </actions>
        <validation>The current iteration has a clear post-implementation rule: repository-file change means an in-task transition to `capture-visual-proof`; no repository-file change means no proof handoff.</validation>
      </step>
      <step number="2">
        <title>Implement the correct change</title>
        <description>Modify only the files needed to satisfy the request while maintaining local architecture, typing, and behavioral invariants.</description>
        <actions>
          <action>Edit only the necessary files.</action>
          <action>Keep the implementation aligned with nearby patterns, shared abstractions, and project conventions.</action>
          <action>If you create a markdown file that is not meant to be committed to the codebase (for example a report or detailed summary), upload it with `manage_artifacts` using action `upload`, set `type: "general"`, and share the returned link.</action>
          <action>Update the todo list as implementation milestones are completed, and revise it before user-facing progress text if the visible plan would otherwise lag behind the work.</action>
        </actions>
        <validation>The repository reflects the intended change set without unrelated churn.</validation>
      </step>
      <step number="3">
        <title>Resolve required post-change proof before delivery</title>
        <description>If the current implementation pass changed repository files, keep this workflow active by transitioning into `capture-visual-proof` after implementation and let that delegated proof path decide whether visual proof applies, what screenshots or screencasts are needed, what surfaces or states need capture, and whether any internal browser work is required before branch/push/PR completion continues.</description>
        <actions>
          <action>After implementation, check whether repository files actually changed, including newly added files.</action>
          <action>If no repository files changed, skip the proof handoff and carry that no-op result forward honestly into the later delivery-state step.</action>
          <action>If repository files changed, continue in the current task/session by transitioning into `capture-visual-proof` and pass forward the final shipped change for proof planning and capture before PR update or other completion steps that depend on proof results continue. Do not launch a separate task for this handoff.</action>
          <action>Let the delegated proof path decide the environment-provided target surface, determine what surfaces or states need capture, decide whether the proof claim is about rendered UI output or non-visual system behavior, capture any applicable screenshots or screencasts, and handle any internal browser navigation, blocker handling, and artifact retention through its fixed proof runner.</action>
          <action>Treat proof applicability, screenshot or screencast retention, uploaded artifact list output, or blocker output as input to the later delivery-state step, not as a terminal completion signal on its own.</action>
          <action>If the delegated proof run returns that the environment-provided browser target is blocked or that browser capture could not complete, carry that blocker forward honestly instead of improvising another browser tool or host.</action>
          <action>Once that proof handoff is required, do not substitute parent-owned visual-proof capture such as local screenshots, local screencasts, ad hoc localhost scripts, direct browser capture, Playwright capture, manual browser use, or any other improvised visual-proof procedure in this workflow.</action>
          <action>If pull-request-backed UI work needs proof embeds, consume the delegated result and carry the canonical uploaded artifact list from the delegated proof handoff forward when it exists so the PR formatter can render the latest screenshots and screencasts consistently.</action>
          <action>If the delegated proof run returns that browser proof is not applicable, screenshots and screencasts are unnecessary, or capture is blocked, carry that result forward honestly instead of fabricating before/after evidence or overriding the delegated judgment by insisting on naturally occurring dev data for a rendered UI claim.</action>
          <action>If this is a later UI iteration on an existing pull request, replace the prior PR proof evidence with the latest relevant delegated result instead of accumulating stale batches.</action>
        </actions>
        <validation>The current implementation ends with either an in-task delegated proof run for the shipped repository-file change or an honest no-op result when no repository files changed.</validation>
      </step>
    </steps>
  </phase>

  <phase name="validation">
    <description>Verify correctness, run the parent-side review required for this run, apply branch/push/PR actions appropriately, and keep the reported outcome aligned with reality.</description>
    <steps>
      <step number="1">
        <title>Run proportionate validation</title>
        <description>Use validation that matches the scope and risk of the change.</description>
        <actions>
          <action>Run targeted tests, type checks, linting, or other relevant validation, and update the todo list once the validation state is known.</action>
          <action>For narrow visual-only polish changes, the automated validation step may stop at the smallest relevant static checks. When repository files changed, still follow the separate delegated visual-proof handoff defined earlier in this workflow. Do not add or expand automated tests whose main assertion is an exact Tailwind class, exact DOM nesting, or another incidental UI implementation detail unless that detail is itself the contract or a reported regression.</action>
          <action>Record any failed, skipped, or unavailable validation honestly.</action>
          <action>If validation cannot run because dependencies, services, credentials, or external tooling are unavailable, keep the repository-changing workflow active. Carry the exact validation gap into the later delegated delivery step so the PR body can report it; do not replace required push or pull-request delivery with a local final summary.</action>
        </actions>
        <validation>You know exactly which checks passed, failed, or could not be run.</validation>
      </step>
      <step number="2">
        <title>Run the required parent review step</title>
        <description>Before branch/push/PR actions, perform the parent-side review required for this run and fix issues introduced by this implementation.</description>
        <actions>
          <action>By default, run a brief self-review over the task diff before branch/push/PR actions, focused on obvious request-satisfaction gaps, diff stability, accidental scope creep, and other cheap author-side catches.</action>
          <action>When task-level workflow instructions explicitly narrow or replace the parent review step, obey that narrower override instead of duplicating another review pass. For example, if the workflow says the parent step is only a brief author sanity check before a child review loop, keep the parent pass to request satisfaction, obvious contract edges, and diff stability, then hand off to the child review.</action>
          <action>For the default parent review path, run `git diff $(git merge-base HEAD origin/HEAD 2>/dev/null || echo "HEAD~1") HEAD`, then `git diff --cached`, then `git diff` to gather committed, staged, and unstaged changes for this task.</action>
          <action>For the default parent review path, run `git diff --cached --name-status` and confirm the staged path list matches the intended deliverables for the task before any branch, push, or PR step. If a staged path is unexpected, unstage it before proceeding.</action>
          <action>Use that parent diff pass for quick author-side review only: request satisfaction, obvious bugs, obvious contract edges, and accidental scope or stability problems that can be caught cheaply without turning this step into a second broad review loop.</action>
          <action>When runtime instructions expose a hidden `judge` subagent and the task has a concrete plan, checklist, or explicit requested outcome to compare against, run one focused Task-tool judge pass after the initial self-review and only after any required pre-delivery `capture-visual-proof` handoff for this shipped change has completed, using the final shipped diff, the validation state, and the latest visual-proof result. Include the proof claim, applicability outcome, uploaded artifact URLs or local screenshot/screencast/keyframe paths when present, and short proof captions in the judge brief. Ask it specifically to compare plan versus built result and to verify visual proof when evidence was captured or when proof should have applied, not to repeat generic code review, and to keep any repo reads minimal and targeted instead of doing open-ended exploration. Treat the judge verdict as review input, fix actionable plan-mismatch or proof gaps it finds, and rerun the judge once if needed before delivery.</action>
          <action>Fix every actionable issue the parent pass or judge pass finds, then re-review the updated diff before proceeding.</action>
          <action>Once the required parent review step reaches a known state, update the todo list and continue to the branch/push/PR step.</action>
        </actions>
        <validation>The task diff has received the parent-side review required for this run, and any discovered issues were fixed or explicitly documented before branch/push/PR actions.</validation>
      </step>
      <step number="3">
        <title>Reach the required branch/push/PR state</title>
        <description>Continue until the run reaches the concrete branch, push, or pull-request state required by the invoking workflow's execution policy. This skill does not choose the policy, but it does own reaching that state before reporting completion.</description>
        <actions>
          <action>Continue into the policy-selected delivery outcome instead of treating validated local code changes, proof handoff, or a local summary as completion on their own.</action>
          <action>If repository files changed and the active execution policy still requires push or pull-request delivery, the run is not in a completable state after validation; any local summary before delegated delivery resolves is only a progress update.</action>
          <action>If validation failed, was skipped, or was unavailable for environmental reasons, and the implementation is still the intended shipped diff, continue into the policy-selected delivery skill and make that validation state reviewer-visible in the delegated PR or push report. Do not stop at a final answer merely because validation could not complete.</action>
          <action>If `capture-visual-proof` returned a no-op, non-applicable, unnecessary, or blocked proof result, continue into the policy-selected delivery skill and pass that proof result forward. Do not treat the proof handoff or proof blocker as the final closeout for a repository-changing autonomous run.</action>
          <action>When the active ending maps to `create-pr`, `create-draft-pr`, `push`, `fix-pr`, or `resolve-github-pr-merge-conflicts`, transition into that standalone skill for the actual workspace detection, metadata derivation, commit/push mechanics, PR creation or refresh, PR body synthesis, PR-thread management, or conflict-resolution mechanics instead of duplicating those mechanics locally.</action>
          <action>Treat the delegated skill's returned branch, pull-request, and repository-by-repository results as the canonical delivery state before any parent-owned follow-up actions run.</action>
          <action>If delegated proof artifacts or an uploaded artifact list were returned by `capture-visual-proof`, pass only the latest relevant evidence set into the delegated PR workflow and let that child skill decide whether to embed, refresh, or remove the `## Screenshots` and `## Screencasts` sections.</action>
          <action>If the active execution policy pauses delivery pending user input or approval, or if a remote or auth failure blocks delivery, report that pending state explicitly and leave the run unresolved instead of presenting it as complete.</action>
        </actions>
        <validation>The run reached the concrete branch/push/PR state required by the active profile, or the exact pending or blocking condition was carried forward honestly.</validation>
      </step>
      <step number="4">
        <title>Report from the actual end state</title>
        <description>Only close out after the delivery state is known, with a concise, accurate summary of what changed and only the caveats or delivery outcomes that materially affect the result.</description>
        <actions>
          <action>Base the final report on the actual delivery state from the prior step; do not present local validation, proof handoff, or a draft summary as the finish line when delivery work remains pending.</action>
          <action>The only valid terminal states for a repository-changing run are: delegated delivery completed, an explicit blocker, or an explicit policy pause awaiting user input.</action>
          <action>Summarize behavior-level changes, not just file names.</action>
          <action>Let the delegated delivery skill own pull request title/body derivation, screenshot and screencast embedding, related-PR links, and any PR metadata refresh using its shared `pr-metadata-update-recipe` block plus the relevant `pr-writing-guide` section instead of duplicating that procedure here.</action>
          <action>Keep the final completion report conversational and concise by default; do not turn routine successful execution into an audit log.</action>
          <action>Do not add standalone `Validation`, `Checks`, or `Status` sections for routine successful runs.</action>
          <action>Mention screenshot or screencast capture only when it materially affects the user's next step or the user explicitly asked about it.</action>
          <action>Mention branch or pull request outcomes only when they materially affect delivery or the user's next step, or the user explicitly asked; prefer concise inline wording over dedicated status blocks.</action>
          <action>If you generated a non-codebase markdown file, include the artifact link in the final response.</action>
          <action>Do not claim completion for steps that did not happen.</action>
        </actions>
        <pr-writing-guide>
          <pr_title_format>
            <format>[Type] user-facing description</format>
            <types>
              <type name="feat">New capability or behavior visible to the user.</type>
              <type name="fix">Bug fix. Description must use the pattern "... when user [does X]" or "... [user-visible symptom]" so the title names the symptom, not the code fix.</type>
              <type name="improve">Enhancement to existing behavior, UX polish, or quality-of-life change.</type>
              <type name="refactor">Code restructuring with no user-visible behavior change.</type>
              <type name="docs">Documentation-only change.</type>
              <type name="chore">Dependency updates, config, CI, infra, or other non-functional maintenance.</type>
            </types>
            <scope>Use a single bracketed type tag such as `[Fix]` or `[Feat]`, then continue with the user-facing description in plain text.</scope>
            <description_rules>
              <rule>Start every title with exactly one singular bracketed type tag such as `[Fix]`, `[Feat]`, `[Improve]`, `[Refactor]`, `[Docs]`, or `[Chore]`.</rule>
              <rule>Keep the bracket contents to the type only, using forms like `[Fix]`, `[Feat]`, `[Improve]`, `[Refactor]`, `[Docs]`, or `[Chore]`.</rule>
              <rule>Follow the bracketed type tag with a space and then the description.</rule>
              <rule>Lead with what the user sees or can do, not the implementation detail.</rule>
              <rule>Write the user-facing description in sentence case. Capitalize the first word after the bracketed tag and preserve proper nouns and acronyms.</rule>
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
            <section name="What changed">
              <guidance>Summarize the shipped change in reviewer-facing terms. For fixes, describe the broken behavior and the visible correction. For features or improvements, name the new capability or better experience. For refactors, docs, and chores, describe the internal or maintenance change plainly without inventing user-facing drama. Avoid file-by-file narration.</guidance>
            </section>
            <section name="Why this change was made">
              <guidance>One or two sentences connecting the change to the motivation or risk it addresses. Mention the user problem, new capability, maintenance goal, or reviewer-relevant constraint as appropriate. Include implementation detail only when it helps the reviewer understand outcome or risk.</guidance>
            </section>
            <section name="Impact">
              <guidance>Describe the effect of the change. Lead with the concrete user-visible result when there is one. When there is no intended user-facing change (for example refactor, docs, or chore work), say so plainly and state the operational, maintenance, or reviewer-visible benefit instead.</guidance>
            </section>
            <section name="Related PRs">
              <guidance>Include only when the same task ships through multiple pull requests. Link the sibling PRs with short labels such as repository names or user-facing split names like frontend/backend. Omit the current PR, and remove stale links when the task split changes.</guidance>
            </section>
          </pr_body_sections>
        </pr-writing-guide>
        <validation>The final report is consistent with the actual run state.</validation>
      </step>
    </steps>
  </phase>

<completion_criteria>
<criterion>The request was grounded in repository truth before editing, including the applicable repo-local `AGENTS.md` files for each repository path worked on.</criterion>
<criterion>The intended code change was implemented without unrelated churn.</criterion>
<criterion>Relevant validation ran or any gap was documented explicitly.</criterion>
<criterion>When the implementation changed repository files, the workflow continued in the current task/session by handing the shipped change to `capture-visual-proof`, kept browser tooling contained inside that delegated proof path, and let the delegated proof path return artifacts or blockers honestly.</criterion>
<criterion>The run did not stop at validated local changes while the active policy still required branch/push/PR work. It either completed the delegated delivery path selected by that policy or reported the exact pause or blocker that kept delivery pending.</criterion>
</completion_criteria>
</workflow>

<best_practices>
<guideline priority="high">
<rule>Prefer a change set that fully satisfies the request.</rule>
<rationale>Smaller changes reduce regression risk and make validation easier to trust.</rationale>
<exceptions>Broader edits are acceptable when needed to maintain consistency or correctness.</exceptions>
</guideline>
<guideline priority="high">
<rule>Explore the repository before editing and align with local patterns.</rule>
<rationale>Existing conventions and surrounding implementations are the strongest guide for safe changes.</rationale>
<exceptions>Deviate only when the local pattern is clearly incorrect for the requested outcome.</exceptions>
</guideline>
<guideline priority="high">
<rule>Run targeted validation before reporting completion.</rule>
<rationale>Implementation quality depends on evidence, not assumption.</rationale>
<exceptions>If validation is unavailable or blocked, report the gap explicitly instead of pretending it passed.</exceptions>
</guideline>
</best_practices>

## Narration Leakage Prevention

Do not narrate your changes into runtime-visible product output. UI copy, string literals, placeholder text, HTML content, comments visible to end users, and other user-visible runtime text must reflect the product's voice and serve the end user - not describe what you changed or why. This rule does not apply to repository documentation such as READMEs or `AGENTS.md`. Keep all explanations of your work in conversation responses, commit messages, and PR descriptions.

<patterns>
  <pattern name="todo_initialization">
    <description>Establish a concrete execution checklist at the start of the run.</description>
    <context>Use for every coding task before deep exploration or editing.</context>
    <template>initialize todo list -> inspect repository -> plan -> implement -> validate -> apply task-level branch/push/PR actions</template>
  </pattern>
  <pattern name="post_implementation_proof_handoff">
    <description>For implement-changes runs, keep only the post-implementation trigger and PR-consumption contract here, and let `capture-visual-proof` own proof applicability and capture decisions because the parent workflow must not expose or directly use browser tooling.</description>
    <context>Use whenever the final shipped implementation changes repository files.</context>
    <template>implement the current change -> check whether repository files changed -> if yes continue in the current task/session by transitioning into `capture-visual-proof` -> consume any returned uploaded-artifact evidence or latest proof links for PR embeds when screenshots or screencasts are kept -> refresh PR evidence to the latest relevant delegated result for each later UI iteration</template>
  </pattern>
  <pattern name="path_reference_loading">
    <description>Consult a single appendix section in this file when task-level policy, trigger context, or an explicit user-selected child path requires behavior beyond the shared implementation core.</description>
    <context>Use when the run must finish through branch/push/PR workflows, operate inside pull-request conversations, resolve pull-request merge conflicts, or enter a named child path such as the PR fixer from an active `implement-changes` session.</context>
    <template>identify the active policy, trigger, or explicit child-path selection -> consult exactly one matching appendix section -> determine whether the appendix is a local overlay or a delegation stub -> keep only parent-owned implementation duties in this skill -> transition into the canonical child skill when the appendix says to delegate</template>
  </pattern>
  <pattern name="delegated_delivery_skill_handoff">
    <description>For ready-PR, draft-PR, and push-only endings, keep only the execution-profile choice here and let the delegated standalone delivery skill own the actual git and `gh` mechanics.</description>
    <context>Use whenever the active path must deliver work across one or more repositories after implementation and the required parent review step are complete.</context>
    <template>finish implementation and the required parent review step -> choose `create-pr`, `create-draft-pr`, or `push` from task-level policy -> pass the final shipped diff, full task conversation, and latest screenshot or screencast evidence into that child skill -> let the child skill own workspace detection, metadata derivation, commit/push/PR mechanics, and repository-by-repository reporting</template>
  </pattern>
  <pattern name="delegated_pr_fixer_handoff">
    <description>For PR-feedback work, keep only the trigger selection and task-level constraints here, then transition into `fix-pr` so one skill owns the full fixer execution.</description>
    <context>Use when the request resolves GitHub pull-request feedback from review threads, fix IDs, or top-level PR comments.</context>
    <template>identify that the run is a PR-fixer path -> pass through any supplied PR/thread/task context -> transition into `fix-pr` -> let the child skill own live GitHub fetches, fixer-mode classification, branch pushes, any required delegated `capture-visual-proof` handoff before PR metadata refresh, PR updates, thread resolution, and canonical fixer comment updates</template>
  </pattern>
  <pattern name="delegated_merge_conflict_skill_handoff">
    <description>For PR merge-conflict work, keep only the path selection and task-level constraints here, then transition into `resolve-github-pr-merge-conflicts` so one skill owns the full conflict-resolution procedure.</description>
    <context>Use when the request is to merge the base branch into an existing PR branch and resolve conflicts intentionally.</context>
    <template>identify that the run is a PR merge-conflict path -> pass through any supplied PR context -> transition into `resolve-github-pr-merge-conflicts` -> let the child skill own checkout, merge, conflict analysis, resolution, validation, and push reporting</template>
  </pattern>
</patterns>

<decision_guidance>
<principles>
<principle>Prefer repository truth over assumption.</principle>
<principle>Prefer reversible changes over broad speculative edits.</principle>
<principle>Prefer accurate reporting over optimistic reporting.</principle>
<principle>Do not pre-decide proof applicability in the parent workflow; after implementation, use `capture-visual-proof` whenever repository files changed and keep any browser work contained inside that delegated proof path.</principle>
</principles>
<constraints>
<constraint>Do not run a local screenshot, screencast, or baseline procedure inside this skill when the work should transition into `capture-visual-proof`.</constraint>
<constraint>Do not replace delegated visual proof with localhost or parent-owned browser checks after a repository-file change made the `capture-visual-proof` handoff mandatory.</constraint>
<constraint>Do not bypass `capture-visual-proof` by loading or directly using browser tooling from the parent workflow.</constraint>
<constraint>Do not switch to Playwright, manual browser use, browser devtools, or any other browser automation path for visual proof in this workflow; only the delegated `capture-visual-proof` flow may use the approved internal browser path.</constraint>
<constraint>Do not leave PR screenshots or screencasts stale after a later UI-visible iteration; refresh or remove them so the PR body matches the current state.</constraint>
<constraint>Do not skip validation without explicitly reporting the gap.</constraint>
<constraint>Do not create a pull request unless the invoking workflow's execution policy allows it for the current run.</constraint>
<constraint>Do not claim push/PR steps completed unless they actually happened.</constraint>
</constraints>
<boundaries>
<rule>This workflow handles repository analysis, implementation, validation, deciding when a shipped repository-file change should transition into delegated visual proof, and profile-appropriate branch/push/PR actions.</rule>
<rule>This workflow does not handle planning-only behavior or review-only commenting flows.</rule>
<rule>When a delivery, PR-fixer, or merge-conflict appendix delegates to `create-pr`, `create-draft-pr`, `push`, `fix-pr`, or `resolve-github-pr-merge-conflicts`, this parent skill retains only the policy trigger and any explicitly retained post-delegation duties.</rule>
<rule>When blocked by ambiguity or task-level execution-policy constraints, ask a focused question or explicitly report that user direction is required.</rule>
</boundaries>
<path_selection>
<rule>Consult exactly one appendix section when task-level policy or triggering context requires behavior beyond the shared implementation core.</rule>
<rule>Keep the shared analysis -> implementation -> validation backbone in this file unless the selected appendix is explicitly marked as a delegation stub.</rule>
<rule>Treat appendix sections either as task-level policy overlays or as delegation stubs into canonical standalone skills; do not maintain a second executable specification when a child skill already owns the mechanics.</rule>
<rule>Consult only the appendix that matches the current run so variant-specific detail does not crowd out task-specific repository context.</rule>
<rule>Appendix sections that remain local may extend a shared overlay, but delegation stubs should stay narrow and rely on the child skill for executable details.</rule>
<rule>When `implement-changes` is already the active skill and the user explicitly names a child path or a clear alias for it, treat that as an authoritative sub-workflow selection inside this skill rather than routing away to a different packaged skill.</rule>
<rule>When an appendix is explicitly selected by the user, behave as though this skill has direct access to that appendix as an internal tool: enter the matching path immediately and transition into the canonical child skill whenever that appendix is a delegation stub; do not wait for an external wrapper prompt builder to restate the same path.</rule>
<rule>If multiple appendix paths remain plausible after reading the request, ask one focused clarification question instead of guessing.</rule>
<rule>When a standalone child skill loads `implement-changes` for fallback context, inherit only `core-contract` and the matching child-path contract; do not execute this skill's default workflow inside the child.</rule>
<path_aliases>
<alias path="create-pr">Aliases include “ready PR”, “ready-for-review PR”, and “non-draft PR”. Generic requests such as “create PR”, “open PR”, or “deliver as a PR/MR” are not aliases for this path; they follow the task-level delivery policy, which defaults to draft delivery in Autonomous runs.</alias>
<alias path="create-draft-pr">Aliases include “create draft PR”, “open draft PR”, and “draft PR”. Generic “create PR” / “open PR” / “deliver as a PR/MR” requests also resolve here whenever the task-level delivery policy selects draft delivery.</alias>
<alias path="push-branch">Aliases include “push”, “push branch”, “push changes”, and “push without PR”.</alias>
<alias path="fix-github-pr-feedback">Aliases include “PR fixer”, “fix PR feedback”, “address review comments”, and “run the GitHub PR fixer”.</alias>
<alias path="resolve-github-pr-merge-conflicts">Aliases include “merge conflict resolver”, “resolve PR conflicts”, and “fix merge conflicts”.</alias>
</path_aliases>
<delivery_paths>
<path name="create-pr" section="appendix-create-pr" delegated_skill="create-pr">Use when the run must commit, push, create ready-for-review pull requests, and report their URLs.</path>
<path name="create-draft-pr" section="appendix-create-draft-pr" delegated_skill="create-draft-pr">Use when the run must commit, push, create draft pull requests, and report their URLs.</path>
<path name="push-branch" section="appendix-push-branch" delegated_skill="push">Use when the run must push work on remote branches without opening pull requests.</path>
</delivery_paths>
<pr_conversation_paths>
<path name="fix-github-pr-feedback" section="appendix-fix-github-pr-feedback" delegated_skill="fix-pr">Use when pull-request review comments or top-level PR comments request concrete fixes.</path>
</pr_conversation_paths>
<conflict_resolution_paths>
<path name="resolve-github-pr-merge-conflicts" section="appendix-resolve-github-pr-merge-conflicts" delegated_skill="resolve-github-pr-merge-conflicts">Use when the task is resolving GitHub pull-request merge conflicts by merging the base branch into the PR branch.</path>
</conflict_resolution_paths>
</path_selection>
</decision_guidance>

<error_handling>
<scenario name="delegated_visual_proof_blocked">
<problem>The implementation is ready, but the delegated `capture-visual-proof` run cannot collect evidence or determines that no visual proof is applicable.</problem>
<causes>
<cause>The preview surface is unavailable, proof is not applicable, screenshots or screencasts are unnecessary, or the delegated proof path is otherwise blocked.</cause>
</causes>
<recovery>Carry the delegated result forward honestly into the later delivery-state step, preserve any usable proof artifacts or uploaded artifact list output that were returned, and do not fabricate local before/after evidence inside this skill or override the delegated proof model by insisting that truthful rendered-UI proof requires naturally occurring dev data. A blocked, non-applicable, or unnecessary proof result is not a terminal completion state when repository files changed and the active execution policy still requires push or pull-request delivery.</recovery>
</scenario>
<scenario name="validation_unavailable_before_delivery">
<problem>The implementation changed repository files, but validation cannot run because dependencies, services, credentials, or external tools are unavailable.</problem>
<causes>
<cause>The sandbox lacks installed dependencies, a service is not running, credentials are unavailable, or a repository check requires external state.</cause>
</causes>
<recovery>Report the exact validation limitation, preserve any checks that did run, and continue to the policy-selected delivery skill when the implementation is still the intended shipped diff. The delegated delivery result must make the validation limitation reviewer-visible; do not end the workflow with a local summary before the required branch, push, or pull-request state is reached.</recovery>
</scenario>
<scenario name="missing_context_or_ambiguous_request">
<problem>The request cannot be implemented safely because expected behavior or the target change surface is unclear.</problem>
<causes>
<cause>The repository contains multiple plausible change points.</cause>
<cause>The user request leaves a high-impact behavior decision unspecified.</cause>
</causes>
<recovery>Explore the repository first; if ambiguity remains, ask a focused question that resolves the specific blocker.</recovery>
</scenario>
<scenario name="validation_failure">
<problem>The implementation introduces failing checks or obvious regressions.</problem>
<causes>
<cause>The change missed an edge case or violated an existing contract.</cause>
</causes>
<recovery>Investigate the failing output, adjust the implementation, rerun the affected checks, and report the exact final validation state.</recovery>
</scenario>
<scenario name="branch_push_pr_blocked">
<problem>The workflow reaches the branch/push/PR step but cannot push, create a pull request, or proceed because of profile constraints or environment failures.</problem>
<causes>
<cause>The active execution policy paused delivery pending user input or approval.</cause>
<cause>Push or pull request creation failed due to authentication, branch, or remote-state issues.</cause>
</causes>
<recovery>Report the blocker or policy-imposed pause exactly, keep all validated local context possible, and do not report the run as complete while the required delivery path remains pending.</recovery>
</scenario>
</error_handling>

<appendices>
  <appendix name="create-pr" id="appendix-create-pr">
    <summary>Use when the current run must commit pending work if needed, push branches, create ready-for-review pull requests, and report the resulting URLs.</summary>
    <purpose>Define the ready-for-review PR delivery profile, then transition into the canonical `create-pr` skill for actual execution.</purpose>
    <delegation>
      <target_skill>create-pr</target_skill>
      <ownership>The delegated skill owns workspace detection, repository analysis, branch and commit metadata, commit and push mechanics, PR title and body synthesis, screenshot and screencast section rewriting, sibling-PR cross-linking for split tasks, PR creation or refresh, and repository-by-repository reporting.</ownership>
    </delegation>
    <path_specific_policy>
      <item>Enter this path only when the active execution profile allows ready-for-review pull requests rather than draft PRs or push-only delivery.</item>
      <item>Complete the parent workflow's implementation, delegated visual-proof handoff, validation, and the required parent review step first; then transition into `create-pr` with the final shipped diff, full task conversation, and any latest proof artifacts or uploaded artifact list output.</item>
      <item>When the task must ship through multiple sibling pull requests, rely on the delegated skill to create or refresh the whole set and then backfill cross-links so each PR description mentions the other PRs.</item>
      <item>After `create-pr` returns pull request numbers or URLs, treat that result as canonical for the parent workflow's final reporting.</item>
      <item>Do not duplicate `gh pr list`, `gh pr create`, `gh pr edit`, branch naming, or commit and push logic in this appendix.</item>
    </path_specific_policy>
  </appendix>

  <appendix name="create-draft-pr" id="appendix-create-draft-pr">
    <summary>Use when the current run must commit pending work if needed, push branches, create draft pull requests, and report the resulting URLs.</summary>
    <purpose>Define the draft-pull-request delivery profile, then transition into the canonical `create-draft-pr` skill for actual execution.</purpose>
    <delegation>
      <target_skill>create-draft-pr</target_skill>
      <ownership>The delegated skill owns workspace detection, repository analysis, branch and commit metadata, commit and push mechanics, PR title and body synthesis, screenshot and screencast section rewriting, sibling-PR cross-linking for split tasks, PR creation or refresh, draft-state handling, and repository-by-repository reporting.</ownership>
    </delegation>
    <path_specific_policy>
      <item>Enter this path only when the active execution profile requires draft pull requests rather than ready PRs or push-only delivery.</item>
      <item>Complete the parent workflow's implementation, delegated visual-proof handoff, validation, and the required parent review step first; then transition into `create-draft-pr` with the final shipped diff, full task conversation, and any latest proof artifacts or uploaded artifact list output.</item>
      <item>When the task must ship through multiple sibling pull requests, rely on the delegated skill to create or refresh the whole set and then backfill cross-links so each PR description mentions the other PRs.</item>
      <item>After `create-draft-pr` returns pull request numbers or URLs, treat that result as canonical for the parent workflow's final reporting.</item>
      <item>Do not duplicate `gh pr list`, `gh pr create --draft`, `gh pr edit`, `gh pr ready --undo`, branch naming, or commit and push logic in this appendix.</item>
    </path_specific_policy>
  </appendix>

  <appendix name="push-branch" id="appendix-push-branch">
    <summary>Use when the current run must push work on remote branches without opening pull requests.</summary>
    <purpose>Define the push-only delivery profile, then transition into the canonical `push` skill for actual execution.</purpose>
    <delegation>
      <target_skill>push</target_skill>
      <ownership>The delegated skill owns workspace detection, repository analysis, branch and commit metadata, commit and push mechanics, and repository-by-repository reporting.</ownership>
    </delegation>
    <path_specific_policy>
      <item>Use this path only when the active execution profile must push work on remote branches without opening or refreshing pull requests.</item>
      <item>Complete the parent workflow's implementation, delegated visual-proof handoff, validation, and the required parent review step first; then transition into `push` for the actual branch push.</item>
      <item>Do not create a pull request in this path unless a later, separate workflow explicitly changes the delivery policy.</item>
      <item>Do not duplicate branch naming, commit creation, `git push`, or follow-up reporting mechanics in this appendix.</item>
    </path_specific_policy>
  </appendix>

  <appendix name="fix-github-pr-feedback" id="appendix-fix-github-pr-feedback">
    <summary>Use when GitHub pull-request review threads or top-level PR comments request concrete fixes that must be implemented, pushed, and reflected back into the PR discussion.</summary>
    <purpose>Define the PR-feedback execution profile, then transition into the canonical `fix-pr` skill for actual execution.</purpose>
    <delegation>
      <target_skill>fix-pr</target_skill>
      <ownership>The delegated skill owns live GitHub fetches, fixer-mode classification, canonical acknowledgment comments, repository checkout, requested code changes, branch pushes, any required delegated `capture-visual-proof` handoff before PR metadata refresh, PR updates, thread resolution, and final fixer comment updates.</ownership>
    </delegation>
    <delegated_fixer_contract>
      <item>Fetch the live PR state with `gh pr view [PR_NUMBER] --repo [owner]/[repo] --json title,body,url,author,headRefName,headRefOid,mergeable,mergeStateStatus,closingIssuesReferences,files`, `gh pr diff [PR_NUMBER] --repo [owner]/[repo]`, `gh api repos/[owner]/[repo]/pulls/[PR_NUMBER]/comments --paginate`, and `gh api repos/[owner]/[repo]/issues/[PR_NUMBER]/comments --paginate` before classifying the trigger.</item>
      <item>`fix-pr` owns the mergeability preflight for this path. When the target PR is conflicted, it should delegate to `resolve-github-pr-merge-conflicts`, re-fetch live PR state, and only then continue the main fixer flow on the refreshed PR branch.</item>
      <item>For broad requests, reuse the latest Roomote review summary whose first line starts with `<!-- roomote-review-summary` as the canonical issue inventory when available, but treat only unchecked checklist items (`- [ ]`) as unresolved fix targets; ignore checked items and struck-through dismissed bullets, and revalidate each candidate against the live review-thread context and current code before acting.</item>
      <item>When a candidate finding is dismissed as invalid, stale, or out of scope, patch the canonical summary entry into a struck-through bullet with a brief factual reason, reply on the corresponding GitHub review thread or comment, do not describe it as fixed, and leave the thread unresolved by default.</item>
      <item>Let `fix-pr` own any required delegated `capture-visual-proof` handoff after repository-file-changing fixes and before PR metadata refresh so this parent path never improvises browser capture for PR feedback runs.</item>
      <item>Let `fix-pr` own the post-push PR metadata refresh using its shared `pr-metadata-update-recipe` block and the `fix-pr` skill's `pr-writing-guide` section.</item>
      <item>Patch the canonical fixer comment through the same endpoint family it was created with, keeping the hidden marker first, keeping `task_link_see` inline on the final summary when it is available, and including the real commit link in the final comment.</item>
    </delegated_fixer_contract>
    <path_specific_policy>
      <item>Enter this path when the request is to address GitHub PR review threads, `fixId` requests, top-level PR comments, or broad "fix all unresolved issues" feedback on an existing pull request.</item>
      <item>Pass through any supplied PR, review-thread, `fixId`, `review_comment_id`, `review_comment_url`, `task_link_follow`, `task_link_see`, or `revert_commit_base_url` context so `fix-pr` can recover the live target cleanly.</item>
      <item>Enter `fix-pr` even when the PR may be conflicted. Let `fix-pr` decide whether it must hand off to `resolve-github-pr-merge-conflicts` first, then resume the same PR-fixer run instead of bypassing the fixer entrypoint.</item>
      <item>Let `fix-pr` own the existing PR branch, mergeability preflight, and thread-management flow end to end; do not restate `gh pr view`, `gh pr diff`, `gh api`, `gh pr edit`, or canonical fixer comment mechanics in this appendix.</item>
      <item>Use the delegated result as the canonical PR-fixer outcome for any later reporting in this parent workflow.</item>
    </path_specific_policy>
  </appendix>

  <appendix name="resolve-github-pr-merge-conflicts" id="appendix-resolve-github-pr-merge-conflicts">
    <summary>Use when the task is resolving GitHub pull-request merge conflicts by merging the base branch into the PR branch and resolving conflicts intentionally.</summary>
    <purpose>Define the PR merge-conflict execution profile, then transition into the canonical `resolve-github-pr-merge-conflicts` skill for actual execution.</purpose>
    <delegation>
      <target_skill>resolve-github-pr-merge-conflicts</target_skill>
      <ownership>The delegated skill owns PR context fetches, checkout, merge execution, conflict analysis, file resolution, validation, push, and resolution reporting.</ownership>
    </delegation>
    <path_specific_policy>
      <item>Enter this path when the request is to merge the base branch into an existing PR branch and resolve conflicts on that PR intentionally.</item>
      <item>Pass through any supplied PR number or repository context so `resolve-github-pr-merge-conflicts` can recover the live target cleanly.</item>
      <item>Let `resolve-github-pr-merge-conflicts` own the merge and conflict-resolution flow end to end; do not restate merge commands, conflict heuristics, or push reporting mechanics in this appendix.</item>
      <item>Use the delegated result as the canonical merge-conflict outcome for any later reporting in this parent workflow.</item>
    </path_specific_policy>
  </appendix>
</appendices>
