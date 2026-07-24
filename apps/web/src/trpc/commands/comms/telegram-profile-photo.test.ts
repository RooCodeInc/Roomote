import { beforeEach, describe, expect, it, vi } from 'vitest';

const { envMock } = vi.hoisted(() => ({
  envMock: {
    TELEGRAM_API_BASE_URL: 'https://telegram.example.com',
  },
}));

vi.mock('@/lib/server/env', () => ({ Env: envMock }));

import { setTelegramBotProfilePhotoBestEffort } from './telegram-profile-photo';

const BOT_TOKEN = '7000000003:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);

describe('setTelegramBotProfilePhotoBestEffort', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uploads the Roomote JPEG through setMyProfilePhoto', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json({ ok: true, result: true }),
    );
    const readFileMock = vi.fn(async (_filePath: string) => JPEG_BYTES);

    await expect(
      setTelegramBotProfilePhotoBestEffort({
        botToken: BOT_TOKEN,
        fetchImpl: fetchMock,
        readFileImpl: readFileMock,
      }),
    ).resolves.toEqual({ updated: true, error: null });

    expect(readFileMock).toHaveBeenCalledWith(
      expect.stringMatching(/public\/roomote-logo\.jpg$/),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `https://telegram.example.com/bot${BOT_TOKEN}/setMyProfilePhoto`,
      expect.objectContaining({ method: 'POST' }),
    );

    const request = fetchMock.mock.calls[0]?.[1];
    expect(request?.body).toBeInstanceOf(FormData);
    const form = request?.body as FormData;
    expect(form.get('photo')).toBe(
      JSON.stringify({
        type: 'static',
        photo: 'attach://profile_photo',
      }),
    );
    const photo = form.get('profile_photo');
    expect(photo).toBeInstanceOf(File);
    expect((photo as File).name).toBe('roomote-logo.jpg');
    expect((photo as File).type).toBe('image/jpeg');
  });

  it('returns Telegram rejection details without throwing', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        Response.json(
          { ok: false, description: 'Photo dimensions are invalid' },
          { status: 400 },
        ),
    );

    await expect(
      setTelegramBotProfilePhotoBestEffort({
        botToken: BOT_TOKEN,
        fetchImpl: fetchMock,
        readFileImpl: vi.fn(async (_filePath: string) => JPEG_BYTES),
      }),
    ).resolves.toEqual({
      updated: false,
      error: 'Photo dimensions are invalid',
    });
  });

  it('turns local or network failures into a generic warning', async () => {
    await expect(
      setTelegramBotProfilePhotoBestEffort({
        botToken: BOT_TOKEN,
        readFileImpl: vi.fn(async (_filePath: string) => {
          throw new Error('missing logo');
        }),
      }),
    ).resolves.toEqual({
      updated: false,
      error: 'The Roomote profile photo could not be uploaded.',
    });
  });
});
