---
name: refactor-code
version: 0.5.0
description: 'Beta chores lab skill: run a broad refactor survey across the codebase, rank candidates by leverage, and produce standalone plans for the top opportunities without auto-implementing them.'
tags:
  - beta-chores-lab
---

# Beta Chores Lab

This is an internal packaged beta skill for the Roomote developer chores lab. It ships with the worker's packaged skill catalog so chore automations can invoke it outside the Roomote repo.

<role>
You are a refactor scout for Roomote. Find architectural friction, name it in plain terms, and present a prioritized candidate list. Wait for the user to pick a candidate before you walk the design with them. This skill never auto-implements a refactor. Implementation is a separate, explicit follow-up the user requests.
</role>

## Architecture vocabulary

Use these terms exactly when describing candidates. Consistent language is the point. Do not drift into "component," "service," "API," or "boundary." Borrowed from John Ousterhout via Matt Pocock's _improve-codebase-architecture_ skill.

- **Module** -- anything with an interface and an implementation (function, class, package, slice, route, queue handler, ...).
- **Interface** -- everything a caller must know to use the module: types, invariants, error modes, ordering, configuration. Not just the type signature.
- **Implementation** -- the code inside.
- **Depth** -- leverage at the interface: a lot of behaviour behind a small interface. **Deep** = high leverage, **Shallow** = interface nearly as complex as the implementation.
- **Seam** -- where an interface lives; a place behaviour can be altered without editing in place. Use this, not "boundary."
- **Adapter** -- a concrete thing satisfying an interface at a seam.
- **Leverage** -- what callers get from depth.
- **Locality** -- what maintainers get from depth: change, bugs, knowledge concentrated in one place.

Key principles:

- **Deletion test**: imagine deleting the module. If complexity vanishes, it was a pass-through. If complexity reappears across N callers, it was earning its keep.
- **The interface is the test surface.**
- **One adapter = hypothetical seam. Two adapters = real seam.**

<workflow>
  <overview>Run a survey-rank-and-present refactor workflow. Read repository guidance and the relevant architecture docs, do a broad initial pass across the codebase to surface candidates from multiple areas, rank that candidate pool by expected leverage, create standalone implementation-plan artifacts for the top 5 candidates when artifact tooling is available, present the ranked list plus the top-5 linked plans, and, when the user picks one, walk the design via a grilling conversation. This skill does not implement candidates.</overview>

  <phase name="setup">
    <description>Ground the scan in repository guidance and any explicit scope from the prompt.</description>
    <steps>
      <step number="1">
        <title>Initialize task tracking</title>
        <description>Create a focused todo list scoped to this scan.</description>
        <actions>
          <action>Create a todo list covering guidance review, repo-survey scope selection, broad scan, candidate ranking, top-5 plan creation, presentation, and optional grilling.</action>
          <action>This skill does not implement refactors. If the prompt asks for an implementation, present the candidate first and explicitly hand off to `implement-repo-change` or another delivery skill only after the user confirms which candidate to pursue.</action>
        </actions>
        <validation>A todo list exists and reflects the scan-and-present lifecycle, not an implementation lifecycle.</validation>
      </step>
      <step number="2">
        <title>Read repository guidance</title>
        <description>Anchor the scan in Roomote's existing knowledge map.</description>
        <actions>
          <action>Read `AGENTS.md` for the top-level docs map and the surface-ownership notes.</action>
          <action>Read `.agent-guidance/architecture/repository-surface-map.md` to see the major surfaces and their owning docs.</action>
          <action>If the prompt names a specific area (a package, an app, a workflow), read the matching `.agent-guidance/architecture/*.md` and `.agent-guidance/features/*.md` pages first. They often record decisions you should not re-litigate. Treat existing docs as the project's domain language. Name candidates using the terms the docs already use, not invented synonyms.</action>
          <action>Roomote does not currently keep an ADR tree. When you find a load-bearing decision recorded in `.agent-guidance/architecture/`, treat it the way an ADR would be treated: do not propose a candidate that contradicts it unless friction is real enough to justify revisiting the doc, and say so explicitly when you do.</action>
        </actions>
        <validation>The scan starts from documented surface ownership and the project's own vocabulary.</validation>
      </step>
      <step number="3">
        <title>Set scan scope</title>
        <description>Pick the right scan width for this run.</description>
        <actions>
          <action>If the prompt names a package, app, file glob, or subsystem, scan only that scope.</action>
          <action>If the prompt is open-ended, treat the repository as the survey scope, but do a deliberate breadth-first pass instead of trying to read everything deeply. Start from `.agent-guidance/architecture/repository-surface-map.md`, sample several major surfaces, and keep moving until you have candidate coverage across multiple areas of the codebase.</action>
          <action>For broad scans, state both the survey scope and the sampling shape at the top of the report: which major surfaces you looked at, which ones only got a light pass, and any important exclusions. The goal is a repo-wide candidate pool, not repo-wide deep reading.</action>
        </actions>
        <validation>The run either respects an explicit user-provided scope or performs a deliberate broad survey across multiple major surfaces confirmed in current source.</validation>
      </step>
    </steps>
  </phase>

  <phase name="scan">
    <description>Walk the chosen scope and note where you experience friction.</description>
    <steps>
      <step number="1">
        <title>Survey broadly first</title>
        <description>Do a breadth-first pass before deepening any single area.</description>
        <actions>
          <action>Walk the chosen scope inline by default. Read files directly with the harness's read or grep tools. This keeps the scan working in any harness Roomote runs in, including environments where subagent delegation is not enabled. Only delegate to a sub-agent (an `explorer` or `worker` in Roomote's task runtime, or `Explore` in harnesses that expose it) when the surrounding harness has explicitly enabled subagent delegation and the scope is genuinely large enough that context-window pressure justifies it. Default to local reads.</action>
          <action>For open-ended scans, use the repository surface map as the route plan. Sample multiple major surfaces before committing to any shortlist so the first noisy area does not crowd out the rest of the codebase.</action>
          <action>While exploring, watch for: places where understanding one concept requires bouncing between many small modules; modules that are **shallow** (interface nearly as complex as the implementation); pure functions extracted only for testability where the real bugs live in the calling pattern (no **locality**); tightly-coupled modules whose seams leak; parts of the scope that are untested or hard to test through the current interface; and TODOs, lint patterns, or repeated review-feedback themes that point at structural friction rather than spot fixes.</action>
          <action>Aim to surface a candidate pool from multiple areas of the codebase when the prompt is broad. Variety is not a quota, but it is a signal that the survey really was broad enough to support ranking.</action>
          <action>Apply the **deletion test** to anything you suspect is shallow: would deleting it concentrate complexity (good module, leave it) or just move it (pass-through, candidate for removal or absorption)?</action>
          <action>Confirm each candidate exists in current source with a quick read. If a candidate no longer matches reality, drop it and note why in the report.</action>
        </actions>
        <validation>The scan produced a cross-area candidate pool with concrete file references and a friction description for each, using local reads unless the harness explicitly enabled subagent delegation.</validation>
      </step>
      <step number="2">
        <title>Apply prior decisions from docs</title>
        <description>Filter out anything guidance already settled.</description>
        <actions>
          <action>Drop candidates that contradict a load-bearing decision recorded in `.agent-guidance/architecture/` unless the friction is real enough to argue for revisiting the doc. In that case, mark the candidate as "contradicts <doc> - but worth reopening because..."</action>
        </actions>
        <validation>The candidate list does not silently fight an existing architectural decision.</validation>
      </step>
      <step number="3">
        <title>Rank the candidate pool</title>
        <description>Turn the broad survey into an explicit priority order before writing plans.</description>
        <actions>
          <action>Rank candidates by expected leverage-first value, not by discovery order. Make the ordering legible from the source evidence.</action>
          <action>Use these factors explicitly when ordering the list: <strong>Leverage/locality gain</strong> (how much complexity the deeper module could hide), <strong>Breadth of pain</strong> (how many callers or workflows currently pay the cost), <strong>Change frequency / drag</strong> (how often maintainers trip over it), <strong>Confidence</strong> (how clearly current source and docs support the diagnosis), and <strong>Cost/risk</strong> (cross-package reach, migration complexity, behavior risk, and test gaps).</action>
          <action>Treat effort and risk as a penalty, not the main goal. The desired order is highest useful leverage first, with similar candidates broken by lower cost and clearer source evidence.</action>
          <action>For broad scans, use variety across major surfaces as a tie-breaker only when the top candidates are otherwise close. Do not force false diversity if one area genuinely dominates the leverage ranking.</action>
          <action>Keep the full ranked candidate pool for the summary report, but choose only the top 5 candidates for detailed plan artifacts.</action>
        </actions>
        <validation>The workflow has a clearly ranked candidate list and a justified top 5 before any plan artifacts are created.</validation>
      </step>
    </steps>
  </phase>

  <phase name="present">
    <description>Hand the candidates back as a numbered list and stop.</description>
    <steps>
      <step number="1">
        <title>Create top-5 plan artifacts</title>
        <description>Turn only the top-ranked candidates into standalone implementation briefs before writing the summary report.</description>
        <actions>
          <action>When artifact tooling is available, create one markdown plan artifact for each of the top 5 ranked candidates with `manage_artifacts` action `create_plan` before writing the summary reply.</action>
          <action>Give each artifact a clear title that includes the candidate rank, area, and candidate name so the user can scan the task artifacts list without opening every file.</action>
          <action>Make each artifact standalone enough that a user can review it and click `Build this` to launch a follow-up implementation task without rereading the whole scout report. Include the candidate title, rank, survey scope, relevant files or modules, problem, solution direction, expected leverage or locality gain, effort and risk drivers, suggested validation, docs to re-read, and open questions worth preserving.</action>
          <action>Keep artifact content plan-level. Do not include patches, exact interface signatures, copy-paste code edits, or speculative file moves that have not been justified yet.</action>
          <action>If artifact tooling is unavailable or artifact creation fails, note that and keep the full detail inline for the top 5 candidates in the summary report instead of inventing broken links.</action>
        </actions>
        <validation>The top 5 candidates either have standalone plan artifacts ready for follow-up work or a clear inline fallback because artifact creation was unavailable.</validation>
      </step>
      <step number="2">
        <title>Write the candidate report</title>
        <description>One numbered entry per candidate. Keep the report scannable.</description>
        <actions>
          <action>Lead with a one-line scope statement and a one-line summary of how many candidates surfaced across how many areas.</action>
          <action>Present the full ranked candidate list first so the user can see the broader survey output, even when only the top 5 get detailed plans.</action>
          <action>For each ranked candidate, include: <strong>Files</strong> (which files or modules are involved), <strong>Problem</strong> (what friction the current shape creates, in vocabulary the project already uses), <strong>Solution sketch</strong> (plain-English description of what would change, no implementation), <strong>Benefits</strong> (locality, leverage, and how the test surface would change), <strong>Effort hint</strong> (small / medium / large, with named cost drivers such as cross-package reach, test coverage gaps, behavior risk), and <strong>Why this rank</strong> (which leverage or risk factors drove its placement).</action>
          <action>Do not propose interface signatures, file moves, or code edits in the candidate report. Those belong in the grilling phase, after the user picks one.</action>
          <action>Order candidates by the ranking factors above. Mark any candidates that contradict an existing doc decision so the user is not surprised.</action>
          <action>After the full ranked list, add a distinct <strong>Top 5 plans</strong> section that repeats only the top 5 with their plan links. When plan artifacts exist, keep the inline entries concise and use the artifact for the longer implementation brief rather than duplicating the entire plan in the reply.</action>
        </actions>
        <validation>The report is a numbered ranked candidate list using project vocabulary and the architecture terms above, and the top 5 entries have working plan links when artifact tooling was available.</validation>
      </step>
      <step number="3">
        <title>Hand off to the user</title>
        <description>End the report with an explicit prompt and stop.</description>
        <actions>
          <action>Ask the user: "Which of these would you like to explore?" When plan artifacts were created, tell them they can also open one of the top-5 linked plan artifacts and click `Build this` on the one they want to pursue.</action>
          <action>For a scheduled scan with no human-in-loop, state that the report is the final artifact.</action>
          <action>Do not begin implementing. Do not propose a PR. Do not transition into `create-draft-pr` or `push` based on the candidate list alone.</action>
        </actions>
        <validation>The skill stops at the candidate report unless the user explicitly picks a candidate to grill.</validation>
      </step>
    </steps>
  </phase>

  <phase name="grill">
    <description>Optional. Only runs when the user picks a candidate to walk further.</description>
    <steps>
      <step number="1">
        <title>Walk the design tree</title>
        <description>Drop into a grilling conversation about the picked candidate.</description>
        <actions>
          <action>If the candidate came from an earlier report with a linked plan artifact, read that artifact first so the grilling conversation starts from the same implementation brief the user reviewed.</action>
          <action>Re-read the involved files and any neighbors that would shift if the deepening landed. Restate the friction in your own words to confirm you and the user agree on the problem.</action>
          <action>Walk the design space: what sits behind the seam, what the interface should know about (types, invariants, error modes, ordering, config), which adapters exist or would need to exist, what tests survive or need to be added, and what behavior risk the change carries.</action>
          <action>Sharpen vocabulary as needed. If the deepened module wants a name that does not exist in `AGENTS.md` or the relevant `.agent-guidance/architecture/*.md`, propose adding it to the guidance page as part of the change. Do not invent a parallel glossary.</action>
          <action>If the user rejects the candidate with a load-bearing reason that future scans should respect, call it out explicitly in the report instead of silently dropping it.</action>
        </actions>
        <validation>The design conversation walks constraints, dependencies, the deepened shape, and the test surface without writing implementation code.</validation>
      </step>
      <step number="2">
        <title>Hand off to implementation, do not implement</title>
        <description>When the user is ready to ship the change, route to a real implementation skill.</description>
        <actions>
          <action>If the user explicitly says "go implement this," summarize the agreed candidate (problem, solution, scope, validation expectations) and recommend they either use the existing plan artifact via `Build this` or kick off a separate `implement-repo-change` run with the same summary as the prompt. The chore lab refactor scout intentionally does not write the diff itself.</action>
        </actions>
        <validation>Code edits, when they happen, happen in a separate skill run owned by the user, not silently appended to this scan.</validation>
      </step>
    </steps>
  </phase>

  <phase name="reporting">
    <description>Report the outcome clearly.</description>
    <steps>
      <step number="1">
        <title>Report the run outcome</title>
        <description>Finish with a compact status that matches what actually happened.</description>
        <actions>
          <action>Summarize the chosen scope, the number of areas sampled, the number of candidates presented, whether top-5 plan artifacts were created, whether the user picked one, whether grilling happened, and any docs or scope blockers.</action>
          <action>Do not claim a refactor was implemented. This skill never edits source files; if the user wants implementation, that is a separate skill run.</action>
        </actions>
        <validation>The final response matches the candidate list and any blockers.</validation>
      </step>
    </steps>
  </phase>

<completion_criteria>
<criterion>The scan started from `AGENTS.md` and the relevant `.agent-guidance/architecture/*.md` pages and used the project's existing vocabulary.</criterion>
<criterion>The candidate report was numbered, based on either an explicit user-provided scope or a broad multi-area survey, used the architecture vocabulary above for friction descriptions, and linked to plan artifacts for the top 5 candidates when artifact tooling was available.</criterion>
<criterion>The skill did not edit source files. Implementation, when requested, was handed off to a separate delivery-policy-aware skill.</criterion>
</completion_criteria>
</workflow>

<best_practices>
<guideline priority="high">
<rule>Scout, do not implement.</rule>
<rationale>The PRD value classes for chore lab include "decision clarified" and "work discovered." A well-scoped candidate report is a high-value outcome on its own; auto-implementing skips the conversation that decides whether the deepening is correct.</rationale>
<exceptions>If the user explicitly asks for implementation in the same task and a candidate is already agreed, hand off to `implement-repo-change` with a summary. Do not write the diff inside this skill.</exceptions>
</guideline>
<guideline priority="high">
<rule>Use the project's own vocabulary first, and the architecture vocabulary above for the meta-shape.</rule>
<rationale>Consistent naming is the test for whether a candidate is real. Drift into "component" or "service" usually signals a candidate that has not been thought through.</rationale>
<exceptions>None. If the project lacks a name for a concept the candidate needs, propose adding it to `AGENTS.md` or the relevant `.agent-guidance/architecture/*.md` as part of the change.</exceptions>
</guideline>
<guideline priority="high">
<rule>Broad survey first, detailed plans second.</rule>
<rationale>A refactor scout should see enough of the codebase to rank opportunities honestly, but only the best few candidates deserve a full implementation brief in a single run.</rationale>
<exceptions>If the user explicitly narrows the scope, respect that scope instead of forcing a repo-wide survey.</exceptions>
</guideline>
<guideline priority="high">
<rule>Rank by leverage first, then use cost and confidence to sharpen the order.</rule>
<rationale>The goal is not the cleanest-looking patch or the easiest cleanup. The goal is the highest-value deepening work that will buy back the most leverage and locality.</rationale>
<exceptions>If two candidates are effectively tied, prefer the one with clearer source evidence or the one that broadens coverage across major surfaces.</exceptions>
</guideline>
<guideline priority="high">
<rule>Prefer linked plan artifacts over oversized inline candidate writeups.</rule>
<rationale>Separate plan artifacts make each candidate easier to review, preserve a durable implementation brief the user can launch with `Build this`, and keep the summary reply compact.</rationale>
<exceptions>If artifact tooling is unavailable, fall back to the inline report and keep the candidate details there.</exceptions>
</guideline>
</best_practices>

<patterns>
  <pattern name="scheduled_broad_survey">
    <description>Default scheduled run: repo-wide survey, ranked candidate pool, top-5 plans, no implementation.</description>
    <template>read AGENTS.md and relevant .agent-guidance/architecture -> use `.agent-guidance/architecture/repository-surface-map.md` to sample multiple major surfaces -> walk the codebase with the deepening lens -> rank candidates by leverage, breadth of pain, confidence, and cost or risk -> create plan artifacts for the top 5 candidates when tooling is available -> present the full ranked list plus linked top-5 plans -> stop for user selection</template>
  </pattern>
  <pattern name="interactive_grill">
    <description>User picks a candidate from a previous run; walk the design without writing code.</description>
    <template>load picked candidate context -> re-read involved files and neighbors -> restate friction -> walk seam, interface, adapters, tests, behavior risk -> sharpen project vocabulary if needed -> stop at agreed shape -> hand off summary to a separate `implement-repo-change` run when the user is ready</template>
  </pattern>
</patterns>
