export function buildManagerAutomationRootSummaryPromptContract(params: {
  detailLabel: string;
  highlightLabel: string;
}) {
  return `Summary shape:
 - Lead with the result, not the work performed to produce it.
 - Do not mention the scan, review, pass, automation, schedule, task, or investigation process.
 - Highlight the top 1 or 2 ${params.highlightLabel}. Add a little color on urgency or why-it-matters when something clearly deserves faster attention.
 - End by pointing readers to the thread for the remaining ${params.detailLabel}.
 - Keep it concise and natural. It should feel like a teammate sharing results, not a process update.

Rules:
- Do not enumerate every item.
- Use only basic Slack markdown.
- Do not add a preamble or any instruction line.
- Do not invent urgency when the run does not support it.`;
}
