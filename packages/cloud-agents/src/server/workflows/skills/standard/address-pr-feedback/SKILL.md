---
name: address-pr-feedback
description: Focused GitHub PR-feedback workflow for addressing unresolved review threads on the current pull request.
---

<role>
You are executing the /address-pr-feedback slash command to address unresolved GitHub pull-request feedback on the current PR.
</role>

<shared_core_loading>
<rule>If the `fix-pr` skill is not already loaded into your context, load it before deeper execution.</rule>
<rule>Use `fix-pr` as the canonical owner of repository edits, validation, pushes, PR metadata refresh, thread replies, and thread resolution mechanics for this command.</rule>
<rule>This slash command is a focused entrypoint for unresolved PR review feedback, not a general invitation to reopen resolved threads or do unrelated cleanup.</rule>
</shared_core_loading>

<workflow>
  <overview>Treat this run as a broad PR-feedback fixer on the current pull request, but build the issue inventory only from unresolved review threads. Read each unresolved thread together with all of its replies, implement the fixes needed to address the still-open requests, then use the GitHub CLI to reply on each handled thread and resolve only the threads that are fully addressed.</overview>

  <phase name="analysis">
    <steps>
      <step number="1">
        <title>Resolve the target pull request and current branch context</title>
        <description>Identify the repository and pull request before touching code or thread state.</description>
        <actions>
          <action>Recover the current repository full name and `[PR_NUMBER]` from supplied task context or the current checkout's git remote and branch when the local branch already corresponds to the target PR.</action>
          <action>If the current pull request cannot be resolved safely, ask for the missing repository or PR identifier and stop instead of guessing.</action>
        </actions>
        <validation>You know which pull request this command is addressing.</validation>
      </step>

      <step number="2">
        <title>Build the issue inventory from unresolved review threads only</title>
        <description>Fetch the live review-thread state, keep only unresolved threads in scope, and preserve thread nuance by reading every reply before planning fixes.</description>
        <actions>
          <action>Fetch the live pull request state with `mcp__roomote__manage_source_control`: `action: "get_pull_request"` for details and head/base SHAs (compute the diff locally with git against those SHAs), and `action: "list_pull_request_comments"` for review threads with per-thread resolution state plus every comment and reply in each thread.</action>
          <action>Discard resolved review threads from the issue inventory unless the current request explicitly says to revisit them.</action>
          <action>For each unresolved thread, read the original review comment and all later replies before deciding what still needs to change.</action>
          <action>If later replies narrow, supersede, or partially retract the original request, treat the latest thread state as the source of truth.</action>
          <action>Carry the resulting unresolved-thread inventory into the `fix-pr` workflow as the only in-scope fix set for this run.</action>
        </actions>
        <validation>The planned fixes come only from unresolved review threads, and each thread has been interpreted with its reply context intact.</validation>
      </step>
    </steps>

  </phase>

  <phase name="implementation">
    <steps>
      <step number="3">
        <title>Implement the requested fixes through the canonical PR fixer flow</title>
        <description>Apply the code changes needed to satisfy the unresolved review feedback without expanding into unrelated cleanup.</description>
        <actions>
          <action>Use the `fix-pr` workflow to read the affected code, implement the fixes, validate them proportionally, and push the result on the existing PR branch.</action>
          <action>If the target PR is merge-conflicted, let `fix-pr` first delegate to `resolve-github-pr-merge-conflicts`, refresh live PR state, and only then continue the unresolved-thread fixes in the same fixer run.</action>
          <action>Keep the implementation tightly scoped to the unresolved threads you recovered in the prior step.</action>
          <action>Do not mark a thread handled unless the shipped code and validation evidence support that claim.</action>
        </actions>
        <validation>The requested PR feedback is implemented on the existing PR branch without unrelated churn.</validation>
      </step>

      <step number="4">
        <title>Reply and resolve threads based on the shipped result</title>
        <description>Close the loop on each unresolved thread through the source-control tool and keep thread state aligned with reality.</description>
        <actions>
          <action>Post a reply on every thread you handled with `mcp__roomote__manage_source_control` `action: "reply_to_pull_request_comment"`, summarizing the shipped change for that thread in terms of the final code result.</action>
          <action>Resolve only the review threads that are fully handled by the pushed fix, using `action: "resolve_pull_request_thread"` with `resolved: true`; when the provider does not expose thread resolution the tool reports `applied: false`, which is a non-blocking capability gap to state honestly.</action>
          <action>If a thread is only partially addressed, reply with the current status but leave the thread unresolved.</action>
          <action>If closeout fails after the code is pushed, report the exact closeout gap honestly instead of implying the thread state was updated.</action>
        </actions>
        <validation>The handled threads have matching replies, and only fully addressed threads were resolved.</validation>
      </step>
    </steps>

  </phase>
</workflow>

<completion_criteria>
<criterion>The command resolved a concrete pull request target before editing code.</criterion>
<criterion>The issue inventory was built from unresolved review threads only, with replies considered as part of each thread's current meaning.</criterion>
<criterion>The resulting fixes were implemented through the canonical PR-fixer flow on the existing pull request branch.</criterion>
<criterion>Handled threads received replies, and only the fully addressed ones were resolved.</criterion>
</completion_criteria>
