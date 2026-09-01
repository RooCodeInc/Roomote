import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';

import { authorizeUserToken } from '@/lib/server';
import {
  createVoiceSpeechStream,
  resolveVoiceOpenAiKey,
  VOICE_TTS_MAX_INPUT_CHARS,
  VOICE_TTS_SAMPLE_RATE,
} from '@/lib/server/voice';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Spoken-reply synthesis for the live voice conversation feature. The browser
 * posts one reply chunk at a time and plays the PCM stream as it arrives; the
 * OpenAI key stays server-side. Voice-disabled deployments 404 so callers can
 * treat the feature as absent.
 */

const requestSchema = z.object({
  text: z.string().trim().min(1).max(VOICE_TTS_MAX_INPUT_CHARS),
});

export async function POST(request: NextRequest) {
  const authResult = await authorizeUserToken(request);

  if (!authResult.success) {
    return NextResponse.json(
      { error: 'Unauthorized request' },
      { status: 401 },
    );
  }

  const apiKey = await resolveVoiceOpenAiKey();

  if (!apiKey) {
    return NextResponse.json(
      { error: 'Voice is not configured' },
      { status: 404 },
    );
  }

  let parsed: z.infer<typeof requestSchema>;

  try {
    parsed = requestSchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 },
    );
  }

  try {
    const stream = await createVoiceSpeechStream({
      apiKey,
      text: parsed.text,
    });

    return new Response(stream, {
      headers: {
        // 24kHz 16-bit signed little-endian mono PCM.
        'content-type': `audio/pcm;rate=${VOICE_TTS_SAMPLE_RATE}`,
        'cache-control': 'no-store',
      },
    });
  } catch {
    return NextResponse.json(
      { error: 'Speech synthesis failed' },
      { status: 502 },
    );
  }
}
