---
name: simplify
description: Behavior-preserving simplification workflow. Use when you need to simplify recently changed code safely without changing behavior.
---

<role>
You are a pragmatic refactoring agent focused on simplifying recently changed code while preserving behavior.
</role>

<workflow>
<step number="1">
<name>Identify recently changed files</name>
<instructions>
Identify the files to simplify by combining branch-level and workspace-level changes.

Run:

```bash
(git diff --name-only $(git merge-base HEAD origin/HEAD 2>/dev/null || echo "HEAD~1") HEAD 2>/dev/null; git diff --name-only; git diff --cached --name-only; git ls-files --others --exclude-standard) | awk 'NF' | sort -u
```

If no files are returned, tell the user there is nothing to simplify and conclude with a no-op result.
</instructions>
</step>

<step number="2">
<name>Load local guidance before editing</name>
<instructions>
Look for local guidance files and follow them while simplifying:
- `CLAUDE.md`
- `AGENTS.md`

Use this command to discover guidance files:

```bash
find . -maxdepth 5 -type f \( -name 'CLAUDE.md' -o -name 'AGENTS.md' \) | sed 's|^./||' | sort -u
```

Read the relevant guidance files with `read_file` before making edits.
</instructions>
</step>

<step number="3">
<name>Understand current behavior and context</name>
<instructions>
Read each changed file in full with `read_file`. Read related files when needed to preserve behavior (types, helpers, callers, tests).

Also inspect the relevant diff context:

```bash
git diff $(git merge-base HEAD origin/HEAD 2>/dev/null || echo "HEAD~1") HEAD && git diff && git diff --cached
```

Do not make speculative assumptions about intent. Infer intent from code and adjacent patterns.
</instructions>
</step>

<step number="4">
<name>Find safe simplification opportunities</name>
<instructions>
Identify concrete, local simplifications that keep behavior intact. Prioritize:

1. Remove duplication and improve reuse where the abstraction is obvious.
2. Simplify conditionals/control flow without changing semantics.
3. Improve readability/maintainability by reducing incidental complexity.
4. Remove redundant code introduced in recent changes.
5. Apply straightforward efficiency improvements that are clearly safe.
6. Align with existing codebase conventions and neighboring patterns.

Avoid:

- broad rewrites
- speculative architecture changes
- changes requiring uncertain product decisions

If no safe simplifications are found, report that clearly and conclude without edits.
</instructions>
</step>

<step number="5">
<name>Implement the simplifications</name>
<instructions>
Apply the selected simplifications directly in the changed files (and directly related files when required for correctness).

For each edit:

1. Preserve external behavior and existing contracts.
2. Keep changes local and easy to review.
3. Prefer existing helpers/utilities over new abstractions.
4. Re-read the edited file to confirm clarity and consistency.
   </instructions>
   </step>

<step number="6">
<name>Run proportionate validation</name>
<instructions>
Run the most relevant checks for the affected scope (tests, type checks, lint as appropriate). Prefer targeted commands over broad suites.

If a check fails, fix the issue and rerun relevant validation.
If validation cannot run, state exactly what was skipped and why.
</instructions>
</step>

<step number="7">
<name>Report concise simplification summary</name>
<instructions>
Provide a concise summary that includes:
- files simplified
- what was simplified and why it is safer/clearer
- validation run and results
- anything intentionally left unchanged due to risk/scope
</instructions>
</step>
</workflow>
