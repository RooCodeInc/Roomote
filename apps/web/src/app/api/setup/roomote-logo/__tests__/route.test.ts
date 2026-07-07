import { GET } from '../route';

describe('GET /api/setup/roomote-logo', () => {
  it('serves the Roomote logo as a download', async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('content-disposition')).toBe(
      'attachment; filename="roomote-logo.png"',
    );
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });
});
