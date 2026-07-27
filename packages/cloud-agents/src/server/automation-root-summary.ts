export function buildManagerAutomationRootSummaryPromptContract(params: {
  detailLabel: string;
  highlightLabel: string;
  openerSignal: string;
  openerExamples?: string[];
}) {
  const openerExamplesLine =
    params.openerExamples && params.openerExamples.length > 0
      ? `- Good opener territory for this run includes phrases like ${params.openerExamples.map((example) => `"${example}"`).join(', ')}. Use them as style anchors, not as fixed templates.\n`
      : '';

  return `Summary shape:
- Write 3 or 4 short paragraphs total, not a bullet list.
- Open with a fresh first sentence that is specific to this run.
- Make the opening sentence clearly reveal that this was ${params.openerSignal}.
- Do that in the opening sentence itself, not later in the message.
- The opening should sound like a coworker giving a quick investigation update, not like an automation label or a status report.
- Hint at what the automation just did by describing the pass itself rather than naming the automation formally. First-person phrasing is fine when it helps the message feel natural.
- Keep the pass reference conversational instead of writing the automation name like a label.
${openerExamplesLine}- Vary the cadence and phrasing across runs. Do not default to the same opener shape every time.
- Avoid stock openers like "I reviewed", "I found", or "This run found", and do not lead with "The [automation name] automation..." unless clarity truly requires it.
- Briefly explain what this automation did or what stood out in this pass.
- Highlight the top 1 or 2 ${params.highlightLabel}. Add a little color on urgency or why-it-matters when something clearly deserves faster attention.
- End by pointing readers to the thread for the remaining ${params.detailLabel}.
- Keep it concise and natural. It should feel like a teammate summarizing the run, not a templated system message.

Rules:
- Do not enumerate every item.
- Use only basic Slack markdown.
- Do not add a preamble or any instruction line.
- Do not invent urgency when the run does not support it.`;
}
