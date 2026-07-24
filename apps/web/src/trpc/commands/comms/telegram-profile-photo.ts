import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { Env } from '@/lib/server/env';

const ROOMOTE_TELEGRAM_PROFILE_PHOTO = 'roomote-logo.jpg';
const TELEGRAM_PROFILE_PHOTO_TIMEOUT_MS = 10_000;

type TelegramProfilePhotoResult = {
  updated: boolean;
  error: string | null;
};

/**
 * Set the newly created child bot's Roomote profile photo. Managed-bot
 * creation links cannot carry a photo, so this runs after the child token has
 * been retrieved. It is deliberately best-effort: a cosmetic failure must
 * never undo working credentials or webhook registration.
 */
export async function setTelegramBotProfilePhotoBestEffort(input: {
  botToken: string;
  fetchImpl?: typeof fetch;
  readFileImpl?: (filePath: string) => Promise<Uint8Array>;
}): Promise<TelegramProfilePhotoResult> {
  try {
    const readLogo =
      input.readFileImpl ??
      (async (filePath: string) => Uint8Array.from(await readFile(filePath)));
    const logo = await readLogo(
      path.join(process.cwd(), 'public', ROOMOTE_TELEGRAM_PROFILE_PHOTO),
    );
    const form = new FormData();
    const attachmentName = 'profile_photo';
    form.set(
      'photo',
      JSON.stringify({
        type: 'static',
        photo: `attach://${attachmentName}`,
      }),
    );
    form.set(
      attachmentName,
      new Blob([Uint8Array.from(logo)], { type: 'image/jpeg' }),
      ROOMOTE_TELEGRAM_PROFILE_PHOTO,
    );

    const apiBaseUrl = (
      Env.TELEGRAM_API_BASE_URL ?? 'https://api.telegram.org'
    ).replace(/\/+$/, '');
    const response = await (input.fetchImpl ?? fetch)(
      `${apiBaseUrl}/bot${input.botToken}/setMyProfilePhoto`,
      {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TELEGRAM_PROFILE_PHOTO_TIMEOUT_MS),
      },
    );
    const payload = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
    } | null;

    if (!response.ok || !payload?.ok) {
      return {
        updated: false,
        error:
          payload?.description ??
          `Telegram rejected the profile photo (${response.status}).`,
      };
    }

    return { updated: true, error: null };
  } catch {
    return {
      updated: false,
      error: 'The Roomote profile photo could not be uploaded.',
    };
  }
}
