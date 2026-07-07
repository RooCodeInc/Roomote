function formatVideoDescriptionEntry(
  description: string,
  index: number,
): string {
  const lines = description.trim().split(/\r?\n/);
  const [firstLine = '', ...restLines] = lines;

  return [
    `- Video ${index + 1}: ${firstLine}`,
    ...restLines.map((line) => `  ${line}`),
  ].join('\n');
}

export function appendSlackVideoDescriptionsToText(input: {
  text: string;
  videoDescriptions?: string[];
}): string {
  const trimmedText = input.text.trim();

  if (!input.videoDescriptions?.length) {
    return trimmedText;
  }

  const descriptionBlock = [
    'Video attachment descriptions:',
    ...input.videoDescriptions.map((description, index) =>
      formatVideoDescriptionEntry(description, index),
    ),
  ].join('\n');

  return trimmedText
    ? `${trimmedText}\n\n${descriptionBlock}`
    : descriptionBlock;
}
