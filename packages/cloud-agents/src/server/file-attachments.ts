import { Buffer } from 'node:buffer';

import JSZip from 'jszip';
import mammoth from 'mammoth';
import * as XLSX from 'xlsx';

import { isRoomoteTextExtractableAttachment } from '../file-attachments';

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENT_TEXT_CHARS_TOTAL = 200_000;
const TRUNCATED_MARKER = '[truncated]';
const OMITTED_ATTACHMENT_MARKER = '[omitted: attachment budget exhausted]';

export interface PromptTextAttachmentInput {
  filename: string;
  mimeType?: string;
  bytes: ArrayBuffer | Buffer | Uint8Array;
}

export interface ExtractPromptTextAttachmentsResult {
  attachmentTexts: string[];
  warnings: string[];
}

function toBuffer(bytes: PromptTextAttachmentInput['bytes']): Buffer {
  if (Buffer.isBuffer(bytes)) {
    return bytes;
  }

  if (bytes instanceof Uint8Array) {
    return Buffer.from(bytes);
  }

  return Buffer.from(bytes);
}

function getNormalizedExtension(filename: string): string | null {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === filename.length - 1) {
    return null;
  }

  return filename.slice(lastDotIndex + 1).toLowerCase();
}

function normalizeMimeType(mimeType: string | undefined): string | null {
  const trimmed = mimeType?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

function decodeUtf8(buffer: Buffer): string {
  return new TextDecoder().decode(buffer);
}

function cleanExtractedText(value: string): string {
  return value
    .replace(/\r\n/g, '\n')
    .split('\0')
    .join('')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  if (maxChars <= TRUNCATED_MARKER.length) {
    return TRUNCATED_MARKER.slice(0, maxChars);
  }

  const availableChars = maxChars - (TRUNCATED_MARKER.length + 1);
  return `${value.slice(0, Math.max(0, availableChars)).trimEnd()}\n${TRUNCATED_MARKER}`;
}

function decodeXmlEntities(value: string): string {
  return value.replace(
    /&(?:amp|lt|gt|quot|apos|#39|#10|#13|#9);/g,
    (entity) => {
      switch (entity) {
        case '&amp;':
          return '&';
        case '&lt;':
          return '<';
        case '&gt;':
          return '>';
        case '&quot;':
          return '"';
        case '&apos;':
        case '&#39;':
          return "'";
        case '&#10;':
          return '\n';
        case '&#13;':
          return '\r';
        case '&#9;':
          return '\t';
        default:
          return entity;
      }
    },
  );
}

function formatAttachmentText(options: {
  filename: string;
  mimeType?: string;
  text: string;
}): string {
  const header = options.mimeType
    ? `File attachment: ${options.filename} (${options.mimeType})`
    : `File attachment: ${options.filename}`;

  return [
    header,
    '----- BEGIN ATTACHMENT -----',
    options.text,
    '----- END ATTACHMENT -----',
  ].join('\n');
}

function formatOmittedAttachmentText(options: {
  filename: string;
  mimeType?: string;
}): string {
  const header = options.mimeType
    ? `File attachment: ${options.filename} (${options.mimeType})`
    : `File attachment: ${options.filename}`;

  return [header, OMITTED_ATTACHMENT_MARKER].join('\n');
}

async function extractSpreadsheetText(buffer: Buffer): Promise<string> {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const parts: string[] = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }

    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false }).trim();
    if (!csv) {
      continue;
    }

    parts.push(`Sheet: ${sheetName}\n${csv}`);
  }

  return parts.join('\n\n');
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

async function extractPptxText(buffer: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer);
  const slideFiles = Object.keys(zip.files)
    .filter((path) => /^ppt\/slides\/slide\d+\.xml$/u.test(path))
    .sort((first, second) => {
      const firstNumber = Number(first.match(/slide(\d+)\.xml$/u)?.[1] ?? '0');
      const secondNumber = Number(
        second.match(/slide(\d+)\.xml$/u)?.[1] ?? '0',
      );

      return firstNumber - secondNumber;
    });

  const slides: string[] = [];

  for (const slideFile of slideFiles) {
    const xml = await zip.file(slideFile)?.async('text');
    if (!xml) {
      continue;
    }

    const texts = Array.from(xml.matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/gu))
      .map((match) => decodeXmlEntities(match[1] ?? '').trim())
      .filter((value) => value.length > 0);

    if (texts.length === 0) {
      continue;
    }

    const slideNumber = slideFile.match(/slide(\d+)\.xml$/u)?.[1] ?? '?';
    slides.push(`Slide ${slideNumber}\n${texts.join('\n')}`);
  }

  return slides.join('\n\n');
}

let pdfjsModulePromise:
  | Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>
  | undefined;

async function getPdfJs() {
  pdfjsModulePromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsModulePromise;
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const pdfjs = await getPdfJs();
  const document = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
  }).promise;

  const pages: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) =>
        typeof item === 'object' && item !== null && 'str' in item
          ? String(item.str)
          : '',
      )
      .join(' ')
      .replace(/\s{2,}/g, ' ')
      .trim();

    if (!pageText) {
      continue;
    }

    pages.push(`Page ${pageNumber}\n${pageText}`);
  }

  return pages.join('\n\n');
}

async function extractAttachmentText(
  input: PromptTextAttachmentInput,
): Promise<string | null> {
  if (
    !isRoomoteTextExtractableAttachment({
      filename: input.filename,
      mimeType: input.mimeType,
    })
  ) {
    return null;
  }

  const buffer = toBuffer(input.bytes);
  const extension = getNormalizedExtension(input.filename);
  const mimeType = normalizeMimeType(input.mimeType);

  if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new Error(
      `File exceeds the ${Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB attachment limit.`,
    );
  }

  if (extension === 'xlsx' || extension === 'xls') {
    return extractSpreadsheetText(buffer);
  }

  if (extension === 'docx') {
    return extractDocxText(buffer);
  }

  if (extension === 'pptx') {
    return extractPptxText(buffer);
  }

  if (extension === 'pdf' || mimeType === 'application/pdf') {
    return extractPdfText(buffer);
  }

  return decodeUtf8(buffer);
}

export async function extractPromptTextAttachments(
  inputs: PromptTextAttachmentInput[],
): Promise<ExtractPromptTextAttachmentsResult> {
  const attachmentTexts: string[] = [];
  const warnings: string[] = [];
  let remainingChars = MAX_ATTACHMENT_TEXT_CHARS_TOTAL;

  const extractionResults = await Promise.all(
    inputs.map(async (input) => {
      try {
        const extractedText = await extractAttachmentText(input);
        return { input, extractedText };
      } catch (error) {
        return {
          input,
          error:
            error instanceof Error ? error.message : 'Failed to extract text.',
        };
      }
    }),
  );

  for (const result of extractionResults) {
    if ('error' in result) {
      warnings.push(`${result.input.filename}: ${result.error}`);
      continue;
    }

    if (!result.extractedText) {
      continue;
    }

    const cleanedText = cleanExtractedText(result.extractedText);
    if (!cleanedText) {
      continue;
    }

    if (remainingChars <= 0) {
      attachmentTexts.push(
        formatOmittedAttachmentText({
          filename: result.input.filename,
          mimeType: result.input.mimeType,
        }),
      );
      warnings.push(
        `${result.input.filename}: omitted because the shared attachment text budget was exhausted.`,
      );
      continue;
    }

    const truncatedText = truncateText(cleanedText, remainingChars);
    const formattedText = formatAttachmentText({
      filename: result.input.filename,
      mimeType: result.input.mimeType,
      text: truncatedText,
    });

    attachmentTexts.push(formattedText);
    remainingChars = Math.max(0, remainingChars - truncatedText.length);
  }

  return { attachmentTexts, warnings };
}

export { appendAttachmentTextsToPromptText } from '../file-attachments';
