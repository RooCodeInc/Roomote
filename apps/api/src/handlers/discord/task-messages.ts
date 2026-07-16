/**
 * Presentation for a started Discord task. Both the launch and a routing card
 * that becomes the started message render these, so the two paths cannot drift
 * into saying the same thing two different ways.
 */

export function discordTaskButtons(input: {
  runId: number;
  taskUrl: string | null;
}) {
  return [
    ...(input.taskUrl ? [[{ text: 'Follow Task', url: input.taskUrl }]] : []),
    [
      {
        text: '✖️ Cancel task',
        callbackData: `discord:cancel:${input.runId}`,
      },
    ],
  ];
}

export function discordTaskAcknowledgementText(input: {
  workspaceDisplayName: string;
  taskUrl: string | null;
}): string {
  return input.taskUrl
    ? `Started a task in ${input.workspaceDisplayName}.`
    : `Queued a task in ${input.workspaceDisplayName}.`;
}
