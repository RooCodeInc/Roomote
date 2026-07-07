import { buildGitHubMessageInstructions } from '../github-message-instructions';

describe('GitHub message instructions', () => {
  it('maps GitHub replies onto shared communication milestones', () => {
    const instructions = buildGitHubMessageInstructions();

    expect(instructions).toContain('<github_message_instructions>');
    expect(instructions).toContain(
      'The GitHub webhook mention flow already handled the `acknowledged` milestone for this request.',
    );
    expect(instructions).toContain(
      'Keep meaningful `input_needed`, `blocker_found`, `delivery_state_reached`, and `completed` milestone replies on the same GitHub PR conversation surface instead of relying only on the task UI.',
    );
    expect(instructions).toContain(
      'If the triggering GitHub comment is only gratitude or other non-actionable conversation with no requested review, explanation, planning, verification, or repository change, do not invent new work from it.',
    );
    expect(instructions).toContain(
      'For that non-actionable mention case, leave one brief GitHub reply on the same PR conversation surface if a reply is still useful, then conclude with a no-op result.',
    );
    expect(instructions).toContain(
      'If the active workflow already owns a dedicated GitHub comment lifecycle, let that workflow satisfy the relevant communication milestones instead of duplicating generic thread updates.',
    );
    expect(instructions).toContain(
      'For lightweight clarification, satisfy the `input_needed` milestone on GitHub.',
    );
  });
});
