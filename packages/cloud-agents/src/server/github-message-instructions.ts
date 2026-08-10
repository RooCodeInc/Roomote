export function buildGitHubMessageInstructions(): string {
  return `
<github_message_instructions>
  <context>This task came from a GitHub @mention on a pull request or issue conversation surface.</context>
  <rule>The GitHub webhook mention flow already handled the \`acknowledged\` milestone for this request.</rule>
  <rule>Keep meaningful \`input_needed\`, \`blocker_found\`, \`delivery_state_reached\`, and \`completed\` milestone replies on the same GitHub conversation surface instead of relying only on the task UI.</rule>
  <rule>If the mention came from a PR review thread, reply in that same review thread. If it came from a PR conversation, reply on the PR. If it came from a plain GitHub issue, reply on that same issue conversation.</rule>
  <rule>If the triggering GitHub comment is only gratitude or other non-actionable conversation with no requested review, explanation, planning, verification, or repository change, do not invent new work from it.</rule>
  <rule>For that non-actionable mention case, leave one brief GitHub reply on the same conversation surface if a reply is still useful, then conclude with a no-op result.</rule>
  <rule>Do not treat short verification asks such as "is this addressed?" or "did we fix everything from the last round?" as no-op; those are actionable follow-up.</rule>
  <rule>Keep GitHub replies brief, relevant to the request, and free of internal reasoning or raw logs.</rule>
  <rule>If the active workflow already owns a dedicated GitHub comment lifecycle, let that workflow satisfy the relevant communication milestones instead of duplicating generic thread updates.</rule>
  <rule>For lightweight clarification, satisfy the \`input_needed\` milestone on GitHub. Use \`request_user_input\` only when the task needs structured or private input outside the public thread.</rule>
</github_message_instructions>
`.trim();
}

export function buildGitHubMentionFollowUpHarnessInstructions(): string {
  return `
<github_pr_follow_up_policy>
  <rule>Apply this policy before the standard workflow's default initial routing step for mention-driven GitHub PR follow-up work.</rule>
  <rule>If the triggering GitHub mention is only gratitude or other non-actionable conversation with no requested review, explanation, planning, verification, or repository change, do not route into \`implement-changes\`, \`plan-repo-implementation\`, \`explore-and-act\`, or \`explain-repo-code\` just to satisfy the default router.</rule>
  <rule>For that non-actionable mention case, leave one brief GitHub reply on the same PR conversation surface if a reply is still useful, then conclude with a no-op result.</rule>
  <rule>Do not treat short verification asks such as "is this addressed?" or "did we fix everything from the last round?" as no-op; those are actionable follow-up and should continue through normal routing.</rule>
</github_pr_follow_up_policy>
`.trim();
}
