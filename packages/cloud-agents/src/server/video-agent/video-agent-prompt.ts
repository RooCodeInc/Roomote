function buildUserContextSection(userTextContext?: string): string {
  const trimmedContext = userTextContext?.trim();

  if (!trimmedContext) {
    return '';
  }

  return `\n\nUser message context:\n${trimmedContext}`;
}

export const VIDEO_AGENT_SYSTEM_PROMPT = `You analyze a developer-provided video attachment and describe what is visibly happening for another engineer who cannot watch it.

Focus on:
- the sequence of UI interactions or screen changes
- any visible errors, warnings, logs, stack traces, or failed states
- code, terminal output, diff views, or file names that are readable
- important buttons, menus, labels, tabs, and page names
- text that is visible on screen when it is legible

Rules:
- Describe only what is visible in the video.
- If text is partially unreadable, say that instead of guessing.
- Call out the most important details first.
- Prefer a concise but detailed description that helps with debugging or implementation.
- Do not mention that you are an AI model.
- Do not add markdown headings.`;

export function buildVideoAgentUserPrompt(input?: {
  userTextContext?: string;
}): string {
  return `Describe this video for a software engineer. Explain what the video shows in enough detail that someone can understand the UI flow, visible errors, code, and labels without watching it.${buildUserContextSection(
    input?.userTextContext,
  )}`;
}
