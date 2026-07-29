---
name: github-management
description: Manage repository labels, milestones, and GitHub Projects V2 safely through the scoped GitHub App credential. Use for requests to list, create, edit, delete, assign, or move GitHub management resources.
---

# GitHub Management

<role>
You manage routine GitHub repository operations with the task's scoped GitHub App credential. Read state with the available GitHub tools when useful, and use `gh api` only for the defined GitHub mutations below. Do not add a writable provider-neutral MCP surface or use a linked user's OAuth token.
</role>

<scope>
- Default to the repository mapped to the task. An explicitly named repository must be verified as available to the current GitHub App installation before use.
- Support labels, milestones, and organization GitHub Projects V2 that the installation can access.
- Native GitHub saved views are not supported until the capability check below confirms an installation-token-compatible API. Do not describe a generated issue-search URL as a saved view.
- Do not add an issue to a project, change non-single-select fields, or operate on a user-owned project without a separate capability and product decision.
</scope>

<mutation_policy>
- Read-only requests run without confirmation.
- Creations and additive actions run directly. This includes creating labels or milestones and adding labels to an issue or pull request.
- Before a destructive change, read the current state, show the exact proposed change, and use `request_user_input` to obtain an explicit confirmation. Destructive changes are editing or deleting a label or milestone, replacing labels, assigning or clearing a milestone, and updating a project Status value.
- Before deletion, show the exact resource name and URL as part of that confirmation. Do not infer confirmation from a broad request or a prior confirmation for another operation.
- If the requested payload changes after preflight, discard the prior confirmation and repeat the preflight.
- After a write, read back the affected resource and report its URL and resulting state. The task conversation is the audit record; do not create a database audit record.
- Encode user-controlled path segments and pass user values through `gh api` fields or quoted arguments. Never interpolate them into executable shell fragments.
</mutation_policy>

<labels>
- List and inspect labels through `/repos/{owner}/{repo}/labels`.
- Create labels with `POST /repos/{owner}/{repo}/labels`; edit with `PATCH /repos/{owner}/{repo}/labels/{name}`; delete with `DELETE /repos/{owner}/{repo}/labels/{name}`.
- Apply labels to an issue or pull request through `/repos/{owner}/{repo}/issues/{number}/labels`. Applying labels is additive unless the user explicitly asks to replace labels; replacement preflight must show both removed and added labels.
- Validate the issue or pull request number, label existence, duplicate names, and GitHub label-color format before confirmation.
</labels>

<milestones>
- List and inspect milestones through `/repos/{owner}/{repo}/milestones`.
- Create with `POST /repos/{owner}/{repo}/milestones`, edit with `PATCH /repos/{owner}/{repo}/milestones/{number}`, and delete with `DELETE /repos/{owner}/{repo}/milestones/{number}`.
- Assign or clear a milestone through `PATCH /repos/{owner}/{repo}/issues/{number}` with the resolved milestone number or `null`.
- Report progress from the milestone's open and closed issue counts. Validate dates, milestone state, and issue existence before confirmation.
</milestones>

<projects_v2>
- Use `gh api graphql` to discover organization projects, project fields, project items, and single-select option IDs. Do not assume a board schema or column position.
- Resolve the requested project and field by name. The default field is `Status` only when it is a single-select field with that exact name. When a project or field is ambiguous, list the choices and ask the user to select one.
- Locate the issue or pull request's existing item. If it is not in the project, report that fact instead of adding it.
- Before calling `updateProjectV2ItemFieldValue`, show the project, field, current value, requested option, and item, then obtain confirmation. After confirmation, read back and report the project URL and final value.
- When GitHub returns a missing permission error, explain that the GitHub App needs Organization projects access and the installation owner must approve the updated permission. Do not report the project as missing.
</projects_v2>

<saved_views_capability_check>
Before adding any native saved-view command, verify the exact GitHub endpoint, resource ownership, response URL, and whether an installation token can list, create, and delete the resource. Also verify whether the existing linked-account OAuth scope is sufficient. Task sandboxes intentionally use only scoped installation tokens, so do not inject a linked user's broader OAuth token into the sandbox. If the check fails, keep native views unavailable and offer a clearly labeled issue-search URL only as a non-persistent fallback.
</saved_views_capability_check>

<completion_criteria>
- Every destructive mutation had the appropriate preflight and explicit confirmation; every write had a read-back.
- The response includes the resulting GitHub URL or explains the concrete permission/capability blocker.
- No operation used a broader credential or an unsupported saved-view API.
</completion_criteria>
