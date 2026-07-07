import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { ImageResponse } from 'next/og';

export const runtime = 'nodejs';
export const revalidate = 86400;

const IMAGE_WIDTH = 1200;
const IMAGE_HEIGHT = 630;
const MAX_LINES = 3;
const DEFAULT_TITLE = 'Roomote';
const CARD_TOP_PADDING = 66;
const CARD_SIDE_PADDING = 74;
const CARD_BOTTOM_PADDING = 74;
const LOGO_WIDTH = 588;
const LOGO_HEIGHT = 153;
const TITLE_FONT_SIZE = 96;
const TITLE_LINE_HEIGHT = 1.02;
const TITLE_GAP = 10;
const TITLE_FONT_WEIGHT = 700;
const LIME_BACKGROUND = '#D6EE26';
const TEXT_COLOR = '#050505';

const logoDataUriPromise = readFile(
  path.join(process.cwd(), 'public', 'logos', 'roomote-brush.png'),
).then((buffer) => `data:image/png;base64,${buffer.toString('base64')}`);
const dmSansBoldPromise = readFile(
  path.join(process.cwd(), 'public', 'fonts', 'dm-sans-700.ttf'),
);

const palettes = {
  marketing: {
    background: LIME_BACKGROUND,
    text: TEXT_COLOR,
  },
  docs: {
    background: LIME_BACKGROUND,
    text: TEXT_COLOR,
  },
} as const;

type Variant = keyof typeof palettes;

const normalizeTitle = (value: string | null): string => {
  const normalized = value?.replace(/\s+/g, ' ').trim() ?? '';
  if (!normalized) {
    return DEFAULT_TITLE;
  }

  return normalized.slice(0, 140);
};

const splitWordsAcrossLines = (
  text: string,
  maxLines: number,
  idealCharsPerLine = 24,
): string[] => {
  const words = text.split(' ');
  const targetLineCount = Math.min(
    maxLines,
    Math.max(1, Math.ceil(text.length / idealCharsPerLine)),
  );
  const targetLength = Math.ceil(text.length / targetLineCount);
  const lines: string[] = [];
  let currentLine = '';
  let remainingWords = words.length;

  for (const word of words) {
    remainingWords -= 1;
    const nextLine = currentLine ? `${currentLine} ${word}` : word;
    const remainingLineSlots = maxLines - lines.length - 1;

    if (
      currentLine &&
      nextLine.length > targetLength &&
      remainingLineSlots > 0 &&
      remainingWords >= remainingLineSlots
    ) {
      lines.push(currentLine);
      currentLine = word;
      continue;
    }

    currentLine = nextLine;
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  if (lines.length <= maxLines) {
    return lines;
  }

  return [...lines.slice(0, maxLines - 1), lines.slice(maxLines - 1).join(' ')];
};

const splitTitleIntoLines = (title: string): string[] => {
  if (title.startsWith('Docs: ')) {
    return ['Docs:', ...splitWordsAcrossLines(title.slice('Docs: '.length), 2)];
  }

  if (title.startsWith('Case Study: ')) {
    return [
      'Case Study',
      ...splitWordsAcrossLines(title.slice('Case Study: '.length), 2),
    ];
  }

  return splitWordsAcrossLines(title, MAX_LINES);
};

const getVariant = (value: string | null): Variant =>
  value === 'docs' ? 'docs' : 'marketing';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const title = normalizeTitle(searchParams.get('title'));
  const variant = getVariant(searchParams.get('variant'));
  const palette = palettes[variant];
  const titleLines = splitTitleIntoLines(title);
  const titleContainerHeight =
    TITLE_FONT_SIZE * TITLE_LINE_HEIGHT * MAX_LINES +
    TITLE_GAP * (MAX_LINES - 1);
  const [logoDataUri, dmSansBold] = await Promise.all([
    logoDataUriPromise,
    dmSansBoldPromise,
  ]);

  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        width: '100%',
        height: '100%',
        backgroundColor: palette.background,
        padding: 20,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          height: '100%',
          color: palette.text,
          padding: `${CARD_TOP_PADDING}px ${CARD_SIDE_PADDING}px ${CARD_BOTTOM_PADDING}px`,
          boxSizing: 'border-box',
        }}
      >
        {/* next/image does not apply inside ImageResponse markup. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={logoDataUri}
          width={LOGO_WIDTH}
          height={LOGO_HEIGHT}
          style={{
            display: 'flex',
            objectFit: 'contain',
            objectPosition: 'left center',
            marginLeft: -14,
          }}
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'flex-end',
            gap: TITLE_GAP,
            marginTop: 'auto',
            width: '100%',
            height: titleContainerHeight,
          }}
        >
          {titleLines.map((line, index) => (
            <div
              key={`${line}-${index}`}
              style={{
                display: 'flex',
                fontSize: TITLE_FONT_SIZE,
                fontWeight: TITLE_FONT_WEIGHT,
                lineHeight: TITLE_LINE_HEIGHT,
                letterSpacing: '-0.045em',
                fontFamily: '"DM Sans", sans-serif',
              }}
            >
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>,
    {
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      fonts: [
        {
          name: 'DM Sans',
          data: dmSansBold,
          style: 'normal',
          weight: 700,
        },
      ],
    },
  );
}
