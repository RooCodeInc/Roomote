import { execFile, spawnSync } from 'node:child_process';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { convertFastAgentWebmToMp4 } from './fast-agent-video-conversion';

const exec = promisify(execFile);
const hasFfmpeg =
  spawnSync('ffmpeg', ['-version']).status === 0 &&
  spawnSync('ffprobe', ['-version']).status === 0 &&
  spawnSync('prlimit', ['--version']).status === 0;

it.skipIf(!hasFfmpeg)(
  'converts complete VP8/Opus video and rejects a hard-capped copy where -fs would silently truncate',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'roomote-video-fixture-'));
    const temporaryCopies = () =>
      readdir(tmpdir()).then((names) =>
        names.filter((name) => name.startsWith('roomote-slack-video-')).sort(),
      );
    const before = await temporaryCopies();
    try {
      const source = join(directory, 'source.webm');
      const output = join(directory, 'output.mp4');
      await exec(
        'ffmpeg',
        [
          '-nostdin',
          '-loglevel',
          'error',
          '-f',
          'lavfi',
          '-i',
          'color=c=blue:s=64x48:r=10',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000',
          '-t',
          '10',
          '-c:v',
          'libvpx',
          '-c:a',
          'libopus',
          '-y',
          source,
        ],
        { timeout: 10_000 },
      );
      const original = await readFile(source);
      const converted = await convertFastAgentWebmToMp4(original);
      await writeFile(output, converted);
      const probe = await exec(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_name,pix_fmt',
          '-of',
          'json',
          output,
        ],
        { timeout: 10_000 },
      );
      expect(JSON.parse(probe.stdout)).toMatchObject({
        streams: [
          { codec_name: 'h264', pix_fmt: 'yuv420p' },
          { codec_name: 'aac' },
        ],
      });
      expect(await readFile(source)).toEqual(original);
      expect(converted.indexOf(Buffer.from('moov'))).toBeLessThan(
        converted.indexOf(Buffer.from('mdat')),
      );

      // Demonstrate the difference with real muxing: -fs returns exit 0 for a
      // shortened clip, whereas the hard limit must reject and clean its copy.
      const truncated = join(directory, 'truncated.mp4');
      await exec(
        'ffmpeg',
        [
          '-nostdin',
          '-loglevel',
          'error',
          '-i',
          source,
          '-c:v',
          'libx264',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          '-fs',
          '4097',
          '-y',
          truncated,
        ],
        { timeout: 10_000 },
      );
      const shortened = await exec(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,duration',
          '-of',
          'json',
          truncated,
        ],
        { timeout: 10_000 },
      );
      // The container duration can still be ten seconds when only one track
      // was cut short; inspect the individual audio/video timelines instead.
      const streams = JSON.parse(shortened.stdout).streams as Array<{
        codec_type: string;
        duration: string;
      }>;
      expect(
        streams.some((stream) => Number(stream.duration) < 9.9),
        JSON.stringify(streams),
      ).toBe(true);
      expect((await stat(truncated)).size).toBeGreaterThan(4096);
      await expect(convertFastAgentWebmToMp4(original, 4096)).rejects.toThrow();
      expect(await readFile(source)).toEqual(original);
      expect(await temporaryCopies()).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
