import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

export const MAX_FAST_VIDEO_BYTES = 50 * 1024 * 1024;
const execFileAsync = promisify(execFile);

/** Convert a delivery copy only; the stored artifact is never changed. */
export async function convertFastAgentWebmToMp4(
  bytes: Buffer,
  maxOutputBytes = MAX_FAST_VIDEO_BYTES,
): Promise<Buffer> {
  if (bytes.length === 0 || bytes.length > MAX_FAST_VIDEO_BYTES) {
    throw new Error('Video exceeds the native delivery size limit.');
  }
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > MAX_FAST_VIDEO_BYTES
  ) {
    throw new Error('Invalid video output size limit.');
  }
  const directory = await mkdtemp(join(tmpdir(), 'roomote-slack-video-'));
  try {
    const input = join(directory, 'input.webm');
    const output = join(directory, 'output.mp4');
    await writeFile(input, bytes);
    // Unlike ffmpeg -fs (a successful early EOF), RLIMIT_FSIZE fails the process
    // on overflow. Never infer completeness from a capped file's final size.
    await execFileAsync(
      'prlimit',
      [
        `--fsize=${maxOutputBytes}:${maxOutputBytes}`,
        '--core=0:0',
        '--',
        'ffmpeg',
        '-nostdin',
        '-xerror',
        '-hide_banner',
        '-loglevel',
        'error',
        '-max_alloc',
        '67108864',
        '-protocol_whitelist',
        'file',
        '-f',
        'matroska',
        '-threads',
        '2',
        '-i',
        input,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0?',
        '-map_metadata',
        '-1',
        '-filter_threads',
        '1',
        '-vf',
        'scale=w=min(1920\\,iw):h=min(1080\\,ih):force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2',
        '-c:v',
        'libx264',
        '-threads',
        '2',
        '-preset',
        'veryfast',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k',
        '-movflags',
        '+faststart',
        '-y',
        output,
      ],
      { timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
    );
    const { size } = await stat(output);
    if (size === 0 || size > maxOutputBytes) {
      throw new Error(
        'Converted video exceeds the native delivery size limit.',
      );
    }
    return await readFile(output);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
