import { describe, expect, it } from 'vitest';

import { desktopDeviceRequestSchema } from './desktop-devices';

describe('desktopDeviceRequestSchema', () => {
  it('requires exactly one bounded capture target', () => {
    expect(
      desktopDeviceRequestSchema.safeParse({ action: 'capture', displayId: 1 })
        .success,
    ).toBe(true);
    expect(
      desktopDeviceRequestSchema.safeParse({ action: 'capture', windowId: 2 })
        .success,
    ).toBe(true);
    expect(
      desktopDeviceRequestSchema.safeParse({ action: 'capture' }).success,
    ).toBe(false);
    expect(
      desktopDeviceRequestSchema.safeParse({
        action: 'capture',
        displayId: 1,
        windowId: 2,
      }).success,
    ).toBe(false);
  });

  it('does not expose remote arm or unapproved input', () => {
    expect(
      desktopDeviceRequestSchema.safeParse({ action: 'arm' }).success,
    ).toBe(false);
    expect(
      desktopDeviceRequestSchema.safeParse({
        action: 'type',
        pid: 42,
        path: 'root.0',
        text: 'test',
        allowInput: false,
      }).success,
    ).toBe(false);
  });
});
