import {
  createProofRunnerAgentPrompt,
  createProofRunnerModelInstructions,
} from '../proof-runner-prompt';

describe('createProofRunnerAgentPrompt', () => {
  it('bakes a fixed browser target when one is provided', () => {
    const prompt = createProofRunnerAgentPrompt('http://localhost:3000/');

    expect(prompt).toContain('Browser target: http://localhost:3000/');
    expect(prompt).not.toContain('missing browser target');
  });

  it('requires the brief to name the target when none is baked', () => {
    const prompt = createProofRunnerAgentPrompt(null);

    expect(prompt).toContain(
      'Browser target: named per run in the delegation brief.',
    );
    expect(prompt).toContain(
      'report blocked with blocker type `missing browser target`',
    );
    expect(prompt).not.toContain('Browser target: http');
  });
});

describe('createProofRunnerModelInstructions', () => {
  it('names the configured target when one is baked', () => {
    const instructions = createProofRunnerModelInstructions(
      'http://localhost:3000/',
    );

    expect(instructions).toContain('(http://localhost:3000/)');
  });

  it('tells the parent to name the target per brief when none is baked', () => {
    const instructions = createProofRunnerModelInstructions(null);

    expect(instructions).toContain(
      'every proof brief must name the absolute browser target URL',
    );
    expect(instructions).not.toContain('(http://localhost:3000/)');
  });
});
