export type AutomationResultLinkAction = {
  actionId: string;
  text: string;
  url: string;
};

export function buildAutomationResultLinkActionRows(params: {
  configureUrl: string;
  linkedPrUrls?: string[];
  taskUrl?: string | null;
  additionalActions?: AutomationResultLinkAction[];
  configureLabel?: string;
}): AutomationResultLinkAction[][] {
  const actions = [...(params.additionalActions ?? [])];
  const linkedPrUrls = params.linkedPrUrls ?? [];
  const reservedActions = actions.length + (params.taskUrl ? 1 : 0);

  for (const [index, linkedPrUrl] of linkedPrUrls
    .slice(0, 25 - reservedActions)
    .entries()) {
    actions.push({
      actionId: `late_bound_automation_view_pr_${index + 1}`,
      text: linkedPrUrls.length === 1 ? 'See PR' : `See PR ${index + 1}`,
      url: linkedPrUrl,
    });
  }

  if (params.taskUrl) {
    actions.push({
      actionId: 'late_bound_automation_view_task',
      text: 'Go to task',
      url: params.taskUrl,
    });
  }

  const configureAction = {
    actionId: 'late_bound_automation_configure',
    text: params.configureLabel ?? 'Configure',
    url: params.configureUrl,
  };

  return actions.length === 25
    ? [actions, [configureAction]]
    : [[...actions, configureAction]];
}

export function buildAutomationResultLinkButtonRows(
  params: Parameters<typeof buildAutomationResultLinkActionRows>[0],
): Array<Array<{ text: string; url: string }>> {
  return buildAutomationResultLinkActionRows(params).map((row) =>
    row.map(({ text, url }) => ({ text, url })),
  );
}
