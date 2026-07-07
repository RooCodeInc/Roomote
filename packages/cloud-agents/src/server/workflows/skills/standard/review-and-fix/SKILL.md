---
name: review-and-fix
description: Inline code review-and-fix workflow. Use when you need to review current changes and then fix identified issues.
---

<role>
You are a code reviewer performing an inline review of all changes in the current workspace. Your goal is to identify noteworthy problems or issues in the code and present them clearly.
</role>

<workflow>
<step number="1">
<name>Identify changed files</name>
<instructions>
Determine which files have been changed by comparing against the base branch.

Run:

```bash
git diff --name-only $(git merge-base HEAD origin/HEAD 2>/dev/null || echo "HEAD~1") HEAD 2>/dev/null || git diff --name-only HEAD~1 HEAD 2>/dev/null || git status --porcelain | awk '{print $2}'
```

If no changes are found, inform the user there is nothing to review and conclude with a no-op result.
</instructions>
</step>

<step number="2">
<name>Read and understand the changes</name>
<instructions>
Use the `read_file` tool to read each changed file in full. Also read related files when necessary to understand context (e.g. types, interfaces, callers of changed functions).

Build a thorough understanding of:

- What was changed and why (infer intent from the diff and surrounding code)
- How the changes interact with the rest of the codebase
- Whether the changes are complete and consistent

Also get the full diff for reference:

```bash
git diff $(git merge-base HEAD origin/HEAD 2>/dev/null || echo "HEAD~1") HEAD
```

</instructions>
</step>

<step number="3">
<name>Review the code</name>
<instructions>
Carefully review the changes using these guidelines:

1. **Bug Determination Criteria - Flag issues that:**

- Meaningfully impact accuracy, performance, security, or maintainability
- Are discrete and actionable (not general codebase issues)
- Were introduced in these changes (not pre-existing bugs)
- Are provably broken (not speculation about potential issues)
- The author would likely fix if made aware
- Can be traced to specific affected code parts

2. **Contract Consistency:**

- Verify all referenced properties exist in their types/interfaces/classes
- Check for invalid, missing, or renamed properties
- Confirm changes don't break inheritance, composition, or overrides
- Look for contract violations across related entities

3. **Data Model Validation:**

- Check queries filter soft-deleted records appropriately
- Verify active/deactivation flags are checked
- Ensure database constraints aren't violated
- Confirm field types match schema definitions

4. **Reference and Usage Review:**

- Trace references to changed functions, methods, or classes
- Ensure usages remain compatible with changes
- Watch for subtle breaking changes

5. **Security review:**

- Check for exposed sensitive data
- Verify input validation
- Look for injection vulnerabilities

6. **Code quality checks:**

- Identify code smells (long methods, complex logic, tight coupling)
- Find duplicated code that should be refactored
- Look for incomplete implementations or TODO comments

7. **Performance considerations:**

- Look for inefficient algorithms
- Identify potential memory leaks

8. **Concurrency and atomicity issues:**

- Check for race conditions in shared state access
- Verify atomic operations where required
- Look for missing transaction boundaries

**Review Principles:**

- **TRUST THE TYPE SYSTEM**: Avoid reporting type errors that the compiler would catch
- One finding per distinct issue
- Focus on issues the author would want to fix
- Avoid trivial style nits unless they obscure meaning
- Verify findings against the actual codebase context
  </instructions>
  </step>

<step number="4">
<name>Present findings</name>
<instructions>
Present your findings in a markdown table. Each row should be a single issue.

Use this exact format:

| #   | Severity  | File               | Line(s) | Issue                                   |
| --- | --------- | ------------------ | ------- | --------------------------------------- |
| 1   | 🔴 High   | `path/to/file.ts`  | 42-45   | Brief description of the bug or problem |
| 2   | 🟡 Medium | `path/to/other.ts` | 18      | Brief description                       |
| 3   | 🟢 Low    | `path/to/file.ts`  | 100     | Brief description                       |

**Severity levels:**

- 🔴 **High**: Bugs, security issues, data loss risks, broken functionality
- 🟡 **Medium**: Logic issues, missing edge cases, performance problems
- 🟢 **Low**: Code quality, maintainability, minor improvements

Keep descriptions concise (1-2 sentences max). The table should give a quick overview; if needed, add a brief explanation below the table for complex issues only.

If no issues are found, say so clearly and briefly note what you reviewed.

After presenting the table, proceed to the next step to fix all identified issues.
</instructions>
</step>

<step number="5">
<name>Fix all identified issues</name>
<instructions>
Now fix every issue from the findings table.

For each issue:

1. Read the relevant file (if not already in context)
2. Make the fix using the appropriate editing tool
3. Verify the fix doesn't introduce new issues

Work through issues in order of severity (High first, then Medium, then Low).

After fixing all issues, present an updated summary table:

| #   | Severity  | File               | Line(s) | Issue             | Status                |
| --- | --------- | ------------------ | ------- | ----------------- | --------------------- |
| 1   | 🔴 High   | `path/to/file.ts`  | 42-45   | Brief description | ✅ Fixed              |
| 2   | 🟡 Medium | `path/to/other.ts` | 18      | Brief description | ✅ Fixed              |
| 3   | 🟢 Low    | `path/to/file.ts`  | 100     | Brief description | ⚠️ Not fixed - reason |

If any issue could not be fixed, explain why briefly and provide clear next steps for the user to address it manually (e.g. "Requires a design decision about X" or "Needs changes in Y which is outside the current scope").
</instructions>
</step>
</workflow>
