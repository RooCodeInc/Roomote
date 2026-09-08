import type { CreateCustomSkillInput } from '@roomote/types';

import { handleCreateCustomSkill } from '../custom-skills.js';
import type { RoomoteConfig } from '../types.js';

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://api.example.com',
};
const input: CreateCustomSkillInput = {
  name: 'review-checklist',
  description: 'Review a change.',
  content: 'Check the tests.',
  environmentIds: ['11111111-1111-4111-8111-111111111111'],
};
const confirmation = {
  success: true,
  persisted: true,
  skillId: 'skill-1',
  name: input.name,
  environmentIds: input.environmentIds,
  scope: 'environments',
};

describe('handleCreateCustomSkill', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValue(new Response(JSON.stringify(confirmation)));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('forwards validated fields with authentication and a timeout signal', async () => {
    await handleCreateCustomSkill(input, config);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://api.example.com/api/mcp/custom-skills',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...input, content: `${input.content}\n` }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('forwards configured bypass authentication without returning it', async () => {
    const result = await handleCreateCustomSkill(input, {
      ...config,
      authBypassHeaderName: 'x-test-bypass',
      authBypassHeaderValue: 'bypass-secret',
    });
    expect(fetchMock.mock.calls[0]?.[1].headers).toMatchObject({
      Authorization: 'Bearer test-token',
      'x-test-bypass': 'bypass-secret',
    });
    expect(JSON.stringify(result)).not.toContain('bypass-secret');
    expect(JSON.stringify(result)).not.toContain('test-token');
  });

  it('returns only the persistence confirmation fields', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ...confirmation,
          content: input.content,
          token: 'private',
        }),
      ),
    );
    const result = await handleCreateCustomSkill(input, config);
    expect(JSON.parse(result.content[0]!.text!)).toEqual(confirmation);
  });

  it.each([403, 409, 413, 500])(
    'surfaces API error and HTTP status %s',
    async (status) => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'Request rejected.', token: 'private' }),
          { status },
        ),
      );
      const result = await handleCreateCustomSkill(input, config);
      expect(JSON.parse(result.content[0]!.text!)).toEqual({
        success: false,
        error: 'Request rejected.',
        httpStatus: status,
      });
    },
  );

  it('does not expose a non-JSON upstream error body', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('private proxy diagnostics', { status: 502 }),
    );
    const result = await handleCreateCustomSkill(input, config);
    expect(JSON.parse(result.content[0]!.text!)).toEqual({
      success: false,
      error: 'Custom skill request failed (502)',
      httpStatus: 502,
    });
  });

  it.each([
    { name: '' },
    { description: '' },
    { content: '' },
    { environmentIds: [] },
    { environmentIds: ['*'] },
    { environmentIds: undefined },
    { content: 'x'.repeat(8 * 1024 * 1024) },
  ])('rejects invalid input before fetching (case %#)', async (overrides) => {
    await expect(
      handleCreateCustomSkill(
        { ...input, ...overrides } as CreateCustomSkillInput,
        config,
      ),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
