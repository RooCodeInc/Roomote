import { crc32 } from 'node:zlib';

/**
 * Teams app packages are a zip of manifest.json plus a 192x192 color icon
 * and a 32x32 outline icon. The package is tiny, so entries are STORED
 * (no compression) and the zip writer below implements just the subset of
 * the format needed for that — avoiding a dependency for three small files.
 */

const COLOR_ICON_FILENAME = 'color.png';
const OUTLINE_ICON_FILENAME = 'outline.png';

type TeamsAppManifestParams = {
  botAppId: string;
  appUrl: string;
  botName?: string;
};

export function buildTeamsAppManifest(params: TeamsAppManifestParams): string {
  const appUrl = new URL(params.appUrl);
  const origin = appUrl.origin;
  const name = params.botName?.trim() || 'Roomote';

  return JSON.stringify(
    {
      $schema:
        'https://developer.microsoft.com/en-us/json-schemas/teams/v1.25/MicrosoftTeams.schema.json',
      manifestVersion: '1.25',
      version: '1.0.0',
      id: params.botAppId,
      developer: {
        name: 'Roomote',
        websiteUrl: origin,
        privacyUrl: origin,
        termsOfUseUrl: origin,
      },
      name: {
        short: name,
        full: `${name} agent for Teams`,
      },
      description: {
        short: `${name} agent for Teams`,
        full: `Message ${name} to launch and steer coding tasks in your connected repositories, right from Teams. When installed with consent, ${name} receives channel and chat messages so follow-up replies can continue the right task.`,
      },
      icons: {
        color: COLOR_ICON_FILENAME,
        outline: OUTLINE_ICON_FILENAME,
      },
      accentColor: '#d6ee26',
      webApplicationInfo: {
        id: params.botAppId,
        resource: origin,
      },
      authorization: {
        permissions: {
          resourceSpecific: [
            {
              name: 'Channel.Create.Group',
              type: 'Application',
            },
            {
              name: 'ChannelMember.Read.Group',
              type: 'Application',
            },
            {
              name: 'ChannelMessage.Read.Group',
              type: 'Application',
            },
            {
              name: 'ChannelMessage.Send.Group',
              type: 'Application',
            },
            {
              name: 'ChannelSettings.Read.Group',
              type: 'Application',
            },
            {
              name: 'ChatMessage.Read.Chat',
              type: 'Application',
            },
            {
              name: 'ChatMessage.Send.Chat',
              type: 'Application',
            },
            {
              name: 'Member.Read.Group',
              type: 'Application',
            },
          ],
        },
      },
      bots: [
        {
          botId: params.botAppId,
          scopes: ['personal', 'team', 'groupChat'],
          supportsFiles: true,
          isNotificationOnly: false,
        },
      ],
      permissions: ['identity', 'messageTeamMembers'],
      supportsChannelFeatures: 'tier1',
      validDomains: [appUrl.host],
    },
    null,
    2,
  );
}

type ZipEntry = {
  name: string;
  data: Buffer;
};

/** Minimal STORE-only zip writer (no compression, no zip64). */
export function buildStoredZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // flags: UTF-8 names
    localHeader.writeUInt16LE(0, 8); // method: STORE
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0x21, 12); // mod date (1980-01-01)
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(entry.data.length, 18); // compressed size
    localHeader.writeUInt32LE(entry.data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length

    localParts.push(localHeader, nameBytes, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0x0800, 8); // flags: UTF-8 names
    centralHeader.writeUInt16LE(0, 10); // method: STORE
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0x21, 14); // mod date
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(entry.data.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    // extra/comment/disk/attrs stay zero
    centralHeader.writeUInt32LE(offset, 42); // local header offset

    centralParts.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + entry.data.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // end of central directory
  endRecord.writeUInt16LE(entries.length, 8); // entries on this disk
  endRecord.writeUInt16LE(entries.length, 10); // total entries
  endRecord.writeUInt32LE(centralSize, 12);
  endRecord.writeUInt32LE(offset, 16); // central directory offset

  return Buffer.concat([...localParts, ...centralParts, endRecord]);
}

export function buildTeamsAppPackage(input: {
  manifestJson: string;
  colorIcon: Buffer;
  outlineIcon: Buffer;
}): Buffer {
  return buildStoredZip([
    { name: 'manifest.json', data: Buffer.from(input.manifestJson, 'utf8') },
    { name: COLOR_ICON_FILENAME, data: input.colorIcon },
    { name: OUTLINE_ICON_FILENAME, data: input.outlineIcon },
  ]);
}
