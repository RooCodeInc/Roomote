const { saveTaskMemory } = vi.hoisted(() => ({
  saveTaskMemory: vi.fn(),
}));

vi.mock('../tasks-api-client', () => ({
  saveTaskMemory,
}));

import { handleSaveTaskMemory } from '../task-memory';

const originalEnv = { ...process.env };

describe('save task memory tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.ROOMOTE_TASK_RUN_ID = '42';
    process.env.ROOMOTE_CLOUD_TOKEN = 'run-token';
    process.env.ROOMOTE_PLATFORM_API_URL = 'https://platform.example.com';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns the submitted memory when saved', async () => {
    const memory = {
      outcome:
        'Made task memories visible with token sk-abcdefghijklmnopqrstuvwxyz redacted.',
      decisions: ['Return the submitted input without server metadata.'],
      rationale:
        'The tool call already contains Bearer example1234567890 this content.',
      reusableFacts: ['Tool results are rendered from their JSON text.'],
      unresolvedQuestions: [
        'Could ghp_abcdefghijklmnopqrstuvwxyz leak elsewhere?',
      ],
    };
    saveTaskMemory.mockResolvedValue({ saved: true });

    const result = await handleSaveTaskMemory(memory);

    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
      success: true,
      saved: true,
      note: 'Recorded for the shared Brain.',
      memory: {
        ...memory,
        outcome: 'Made task memories visible with token [REDACTED] redacted.',
        rationale: 'The tool call already contains [REDACTED] this content.',
        unresolvedQuestions: ['Could [REDACTED] leak elsewhere?'],
      },
    });

    expect(saveTaskMemory).toHaveBeenCalledWith(expect.any(Object), 42, memory);
  });

  it('returns the submitted memory when not saved', async () => {
    const memory = { outcome: 'No durable learning was found.' };
    saveTaskMemory.mockResolvedValue({
      saved: false,
      reason: 'Memory was too short.',
    });

    const result = await handleSaveTaskMemory(memory);

    expect(JSON.parse(result.content[0]?.text ?? '')).toEqual({
      success: true,
      saved: false,
      reason: 'Memory was too short.',
      memory,
    });
  });

  it('redacts private keys split across memory fields', async () => {
    const memory = {
      outcome: 'before\n-----BEGIN PRIVATE KEY-----\nsecret',
      rationale: 'more secret',
      decisions: ['-----END PRIVATE KEY-----\nafter'],
    };
    saveTaskMemory.mockResolvedValue({ saved: true });

    const result = await handleSaveTaskMemory(memory);

    expect(JSON.parse(result.content[0]?.text ?? '')).toMatchObject({
      memory: {
        outcome: 'before\n[REDACTED]',
        rationale: '[REDACTED]',
        decisions: ['[REDACTED]\nafter'],
      },
    });
    expect(saveTaskMemory).toHaveBeenCalledWith(expect.any(Object), 42, memory);
  });
});
