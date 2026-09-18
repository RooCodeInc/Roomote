const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  mkdtemp: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  stat: vi.fn(),
  rm: vi.fn(),
}));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: mocks.mkdtemp,
  readFile: mocks.read,
  writeFile: mocks.write,
  stat: mocks.stat,
  rm: mocks.rm,
}));

import {
  convertFastAgentWebmToMp4,
  MAX_FAST_VIDEO_BYTES,
} from './fast-agent-video-conversion';

beforeEach(() => {
  vi.resetAllMocks();
  mocks.mkdtemp.mockResolvedValue('/tmp/video-test');
  mocks.write.mockResolvedValue(undefined);
  mocks.stat.mockResolvedValue({ size: 10 });
  mocks.read.mockResolvedValue(Buffer.from('mp4'));
  mocks.rm.mockResolvedValue(undefined);
  mocks.exec.mockImplementation((_bin, _args, _options, callback) =>
    callback(null, '', ''),
  );
});

it('runs a bounded H.264/AAC MP4 conversion and cleans temporary copies', async () => {
  expect(await convertFastAgentWebmToMp4(Buffer.from('webm'))).toEqual(
    Buffer.from('mp4'),
  );
  expect(mocks.exec).toHaveBeenCalledWith(
    'prlimit',
    expect.arrayContaining([
      `--fsize=${MAX_FAST_VIDEO_BYTES}:${MAX_FAST_VIDEO_BYTES}`,
      '--core=0:0',
      '--',
      'ffmpeg',
      '-nostdin',
      '-xerror',
      '-protocol_whitelist',
      'file',
      '-f',
      'matroska',
      '-c:v',
      'libx264',
      '-c:a',
      'aac',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '/tmp/video-test/input.webm',
      '/tmp/video-test/output.mp4',
    ]),
    { timeout: 60_000, killSignal: 'SIGKILL', maxBuffer: 65536 },
    expect.any(Function),
  );
  expect(mocks.exec.mock.calls[0]?.[1]).not.toContain('-fs');
  expect(mocks.rm).toHaveBeenCalledExactlyOnceWith('/tmp/video-test', {
    recursive: true,
    force: true,
  });
});

it.each(['missing ffmpeg', 'timeout', 'invalid WebM'])(
  'cleans up on %s',
  async (message) => {
    mocks.exec.mockImplementationOnce((_bin, _args, _options, callback) =>
      callback(new Error(message), '', ''),
    );
    await expect(
      convertFastAgentWebmToMp4(Buffer.from('webm')),
    ).rejects.toThrow(message);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalled();
  },
);

it('rejects a size-limit termination even if muxing leaves an undersized file', async () => {
  mocks.stat.mockResolvedValueOnce({ size: MAX_FAST_VIDEO_BYTES - 1024 });
  mocks.exec.mockImplementationOnce((_bin, _args, _options, callback) =>
    callback(
      Object.assign(new Error('File size limit exceeded'), {
        signal: 'SIGXFSZ',
      }),
      '',
      '',
    ),
  );
  await expect(convertFastAgentWebmToMp4(Buffer.from('webm'))).rejects.toThrow(
    'File size limit exceeded',
  );
  expect(mocks.stat).not.toHaveBeenCalled();
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.rm).toHaveBeenCalled();
});

it.each([0, -1, 1.5, Number.NaN, MAX_FAST_VIDEO_BYTES + 1])(
  'rejects unsafe output limit %s before temp files',
  async (limit) => {
    await expect(
      convertFastAgentWebmToMp4(Buffer.from('webm'), limit),
    ).rejects.toThrow('Invalid video output size limit');
    expect(mocks.mkdtemp).not.toHaveBeenCalled();
  },
);

it('cleans up on temporary write failure', async () => {
  mocks.write.mockRejectedValueOnce(new Error('disk full'));
  await expect(convertFastAgentWebmToMp4(Buffer.from('webm'))).rejects.toThrow(
    'disk full',
  );
  expect(mocks.exec).not.toHaveBeenCalled();
  expect(mocks.rm).toHaveBeenCalled();
});

it.each([0, MAX_FAST_VIDEO_BYTES + 1])(
  'rejects invalid input size %s before temp files',
  async (size) => {
    await expect(convertFastAgentWebmToMp4(Buffer.alloc(size))).rejects.toThrow(
      'size limit',
    );
    expect(mocks.mkdtemp).not.toHaveBeenCalled();
  },
);

it.each([0, MAX_FAST_VIDEO_BYTES + 1])(
  'rejects invalid output size %s without reading it',
  async (size) => {
    mocks.stat.mockResolvedValueOnce({ size });
    await expect(
      convertFastAgentWebmToMp4(Buffer.from('webm')),
    ).rejects.toThrow('size limit');
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.rm).toHaveBeenCalled();
  },
);
