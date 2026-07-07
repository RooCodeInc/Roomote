import { buildPlatformAnswerPrompt } from '../prompts/platform-answer-prompt';

describe('buildPlatformAnswerPrompt', () => {
  it('keeps the routing guardrails and warmer answer guidance', () => {
    const prompt = buildPlatformAnswerPrompt();

    expect(prompt).toContain(
      'Use the provided get_about_me context as the source of truth for what Roomote can do, any user-confirmed connections it exposes, and how to get started.',
    );
    expect(prompt).toContain(
      '- Set canAnswer to true ONLY for short identity questions like "what can you do?", "what is Roomote?", "what are you?", or "how do I get started?"',
    );
    expect(prompt).toContain(
      '- Code questions, bug reports, URLs, or error messages',
    );
    expect(prompt).toContain(
      'When canAnswer is true, answer in first person as Roomote. Sound like a friendly engineering teammate, not a product brochure.',
    );
    expect(prompt).toContain(
      'Keep the answer to 3-5 short lines max. It must fit in one Slack message.',
    );
    expect(prompt).toContain(
      'Always respond in first person (I, me, my). Never refer to Roomote in third person.',
    );
    expect(prompt).toContain(
      'Mention integrations or tools by name only when the provided context explicitly confirms they are connected for the current user. Do not infer user connection state from generic capabilities text, deployment-level tool lists, or environment-declared tools.',
    );
    expect(prompt).toContain(
      'Do not list every feature or turn the answer into a dry checklist.',
    );
    expect(prompt).toContain(
      'Here is an example of the right tone and length. Do not copy it verbatim; adapt it to the actual context and integrations:',
    );
    expect(prompt).toContain(
      'If the provided context confirms connected tools for me, I can use them to get better context and take work off your plate.',
    );
    expect(prompt).toContain(
      'You can work with me from Slack, Linear, GitHub, or the web app.',
    );
  });
});
