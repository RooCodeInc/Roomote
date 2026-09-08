import { handleCreateSkill } from '../create-skill.js';
import type { RoomoteConfig } from '../types.js';

const config: RoomoteConfig = {
  token: 'test-token',
  platformApiUrl: 'https://api.example.com',
  authBypassHeaderName: 'x-test-bypass',
  authBypassHeaderValue: 'test-bypass',
};
const input = {
  name: 'review-notes',
  description: 'Review notes',
  content: 'Read the notes.',
  environmentIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'],
};

describe('handleCreateSkill', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('posts explicit selection with auth and preserves the API result', async () => {
    const payload = {
      success: true,
      skillId: 'skill-id',
      updatedEnvironmentIds: input.environmentIds,
      name: input.name,
      invocation: '$review-notes',
      settingsUrl: 'https://example.com/settings/skills',
      note: 'Available in new tasks selecting an updated environment.',
    };
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify(payload), { status: 201 }),
    );
    const result = await handleCreateSkill(input, config);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
      'https://api.example.com/api/mcp/custom-skills',
      expect.objectContaining({
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'Content-Type': 'application/json',
          'x-test-bypass': 'test-bypass',
        },
        body: JSON.stringify(input),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(JSON.parse(result.content[0]!.text!)).toEqual(payload);
  });

  it.each([403, 409, 422])('returns API errors for HTTP %i', async (status) => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Creation denied' }), { status }),
    );
    const result = await handleCreateSkill(input, config);
    expect(JSON.parse(result.content[0]!.text!)).toEqual({
      success: false,
      error: 'Creation denied',
      httpStatus: status,
    });
  });

  it('preserves non-JSON API errors', async () => {
    fetchMock.mockResolvedValue(
      new Response('Service unavailable', { status: 503 }),
    );
    const result = await handleCreateSkill(input, config);
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({
      success: false,
      error: 'Service unavailable',
      httpStatus: 503,
    });
  });

  it('returns transport failures without claiming creation', async () => {
    fetchMock.mockRejectedValue(new Error('Connection closed'));
    const result = await handleCreateSkill(input, config);
    expect(JSON.parse(result.content[0]!.text!)).toEqual({
      success: false,
      error: 'Connection closed',
    });
  });

  it('does not treat malformed success responses as successful creation', async () => {
    fetchMock.mockResolvedValue(new Response('not json', { status: 200 }));
    const result = await handleCreateSkill(input, config);
    expect(JSON.parse(result.content[0]!.text!)).toMatchObject({
      success: false,
    });
  });
});
