import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import { extractPromptTextAttachments } from '../file-attachments';
import {
  ROOMOTE_ATTACHMENT_TEXT_MAX_CHARS,
  ROOMOTE_FILE_ATTACHMENT_MAX_BYTES,
} from '../../file-attachments';

const harText = JSON.stringify(
  {
    log: {
      version: '1.2',
      creator: { name: 'Browser', version: '1.0' },
      entries: [
        {
          startedDateTime: '2026-10-01T12:00:00.000Z',
          time: 125,
          request: {
            method: 'GET',
            url: 'https://example.com/api/checkout',
            headers: [],
          },
          response: {
            status: 502,
            statusText: 'Bad Gateway',
            headers: [],
            content: {
              mimeType: 'application/json',
              text: '{"error":"upstream unavailable"}',
            },
          },
          timings: {
            blocked: 0,
            dns: 0,
            connect: 0,
            send: 1,
            wait: 123,
            receive: 1,
          },
        },
      ],
    },
  },
  null,
  2,
);

async function buildDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>${text}</w:t></w:r></w:p>
  </w:body>
</w:document>`,
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildPptx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    'ppt/slides/slide1.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:sp>
        <p:txBody>
          <a:p><a:r><a:t>${text}</a:t></a:r></a:p>
        </p:txBody>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`,
  );

  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('extractPromptTextAttachments', () => {
  it.each([
    'application/json',
    'application/octet-stream',
    'text/plain',
    '',
    undefined,
  ])('extracts HAR JSON verbatim with MIME %s', async (mimeType) => {
    const result = await extractPromptTextAttachments([
      {
        filename: 'checkout.HAR',
        mimeType,
        bytes: Buffer.from(harText),
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.attachmentTexts).toEqual([
      `${mimeType ? `File attachment: checkout.HAR (${mimeType})` : 'File attachment: checkout.HAR'}\n----- BEGIN ATTACHMENT -----\n${harText}\n----- END ATTACHMENT -----`,
    ]);
  });

  it('applies the existing file-size limit to HAR files', async () => {
    const result = await extractPromptTextAttachments([
      {
        filename: 'oversized.har',
        mimeType: 'application/octet-stream',
        bytes: Buffer.alloc(ROOMOTE_FILE_ATTACHMENT_MAX_BYTES + 1, 97),
      },
    ]);
    expect(result.attachmentTexts).toEqual([]);
    expect(result.warnings).toEqual([
      'oversized.har: File exceeds the 8 MB attachment limit.',
    ]);
  });

  it('bounds HAR content using the shared text budget', async () => {
    const largeHar = JSON.parse(harText);
    largeHar.log.entries[0].response.content.text = 'x'.repeat(
      ROOMOTE_ATTACHMENT_TEXT_MAX_CHARS,
    );
    const result = await extractPromptTextAttachments([
      {
        filename: 'large.har',
        mimeType: 'application/octet-stream',
        bytes: Buffer.from(JSON.stringify(largeHar)),
      },
      {
        filename: 'later.har',
        mimeType: 'application/json',
        bytes: Buffer.from(harText),
      },
    ]);
    const body = result.attachmentTexts[0]!.split(
      '----- BEGIN ATTACHMENT -----\n',
    )[1]!.split('\n----- END ATTACHMENT -----')[0]!;
    expect(body.length).toBeLessThanOrEqual(ROOMOTE_ATTACHMENT_TEXT_MAX_CHARS);
    expect(body).toContain('https://example.com/api/checkout');
    expect(body).toContain('[truncated]');
    expect(result.attachmentTexts[1]).toContain(
      '[omitted: attachment budget exhausted]',
    );
  });

  it('formats plain-text attachments for prompt context', async () => {
    const result = await extractPromptTextAttachments([
      {
        filename: 'debug.md',
        mimeType: 'text/markdown',
        bytes: Buffer.from('# Bug\nIt broke.', 'utf8'),
      },
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.attachmentTexts).toHaveLength(1);
    expect(result.attachmentTexts[0]).toContain(
      'File attachment: debug.md (text/markdown)',
    );
    expect(result.attachmentTexts[0]).toContain('# Bug\nIt broke.');
  });

  it('extracts R scripts and Jupyter notebooks as source text', async () => {
    const notebook = JSON.stringify({
      cells: [{ cell_type: 'code', source: ['library(DESeq2)'] }],
      nbformat: 4,
      nbformat_minor: 5,
    });
    const result = await extractPromptTextAttachments([
      {
        filename: 'analysis.R',
        mimeType: 'text/x-r-source',
        bytes: Buffer.from('library(DESeq2)', 'utf8'),
      },
      {
        filename: 'analysis.ipynb',
        mimeType: 'application/x-ipynb+json',
        bytes: Buffer.from(notebook, 'utf8'),
      },
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.attachmentTexts[0]).toContain(
      'File attachment: analysis.R (text/x-r-source)',
    );
    expect(result.attachmentTexts[0]).toContain('library(DESeq2)');
    expect(result.attachmentTexts[1]).toContain(
      'File attachment: analysis.ipynb (application/x-ipynb+json)',
    );
    expect(result.attachmentTexts[1]).toContain('library(DESeq2)');
  });

  it.each(['report.xlsx', 'report', 'report.bin'])(
    'extracts spreadsheet cells as text from %s',
    async (filename) => {
      const workbook = XLSX.utils.book_new();
      const worksheet = XLSX.utils.aoa_to_sheet([
        ['Name', 'Status'],
        ['Invoice import', 'Failed'],
      ]);
      XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
      const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

      const result = await extractPromptTextAttachments([
        {
          filename,
          mimeType:
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          bytes,
        },
      ]);

      expect(result.warnings).toEqual([]);
      expect(result.attachmentTexts[0]).toContain('Sheet: Report');
      expect(result.attachmentTexts[0]).toContain(
        'Name,Status\nInvoice import,Failed',
      );
    },
  );

  it.each([
    ['handoff.docx', 'slides.pptx'],
    ['handoff', 'slides'],
    ['handoff.bin', 'slides.bin'],
  ])('extracts document text from %s and %s', async (docxName, pptxName) => {
    const result = await extractPromptTextAttachments([
      {
        filename: docxName,
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: await buildDocx('Hello DOCX'),
      },
      {
        filename: pptxName,
        mimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        bytes: await buildPptx('Hello PPTX'),
      },
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.attachmentTexts[0]).toContain(
      '----- BEGIN ATTACHMENT -----\nHello DOCX\n----- END ATTACHMENT -----',
    );
    expect(result.attachmentTexts[1]).toContain(
      '----- BEGIN ATTACHMENT -----\nSlide 1\nHello PPTX\n----- END ATTACHMENT -----',
    );
  });

  it('extracts a MIME-identified legacy spreadsheet', async () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([['Legacy cells', 'Readable']]),
      'Report',
    );
    const result = await extractPromptTextAttachments([
      {
        filename: 'legacy-report',
        mimeType: ' APPLICATION/VND.MS-EXCEL ',
        bytes: XLSX.write(workbook, { type: 'buffer', bookType: 'biff8' }),
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.attachmentTexts[0]).toContain(
      'Sheet: Report\nLegacy cells,Readable',
    );
  });

  it('keeps recognized document extensions authoritative', async () => {
    const result = await extractPromptTextAttachments([
      {
        filename: 'handoff.docx',
        mimeType: 'application/vnd.ms-excel',
        bytes: await buildDocx('Recognized extension'),
      },
    ]);
    expect(result.warnings).toEqual([]);
    expect(result.attachmentTexts[0]).toContain(
      '----- BEGIN ATTACHMENT -----\nRecognized extension\n----- END ATTACHMENT -----',
    );
  });

  it('reports invalid MIME-identified documents and accepts a corrected file', async () => {
    const mimeType =
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    const invalid = await extractPromptTextAttachments([
      { filename: 'handoff', mimeType, bytes: Buffer.from('not a document') },
    ]);
    expect(invalid.attachmentTexts).toEqual([]);
    expect(invalid.warnings).toEqual([expect.stringContaining('handoff:')]);

    const corrected = await extractPromptTextAttachments([
      {
        filename: 'handoff',
        mimeType,
        bytes: await buildDocx('Corrected file'),
      },
    ]);
    expect(corrected.warnings).toEqual([]);
    expect(corrected.attachmentTexts[0]).toContain(
      '----- BEGIN ATTACHMENT -----\nCorrected file\n----- END ATTACHMENT -----',
    );
  });

  it('uses the full shared budget for a single attachment', async () => {
    const body = 'x'.repeat(20_000);

    const result = await extractPromptTextAttachments([
      {
        filename: 'large.csv',
        mimeType: 'text/csv',
        bytes: Buffer.from(body, 'utf8'),
      },
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.attachmentTexts).toHaveLength(1);
    expect(result.attachmentTexts[0]).toContain(body);
    expect(result.attachmentTexts[0]).not.toContain('[truncated]');
  });

  it('lets earlier files consume the shared budget and omits later files', async () => {
    const result = await extractPromptTextAttachments([
      {
        filename: 'first.csv',
        mimeType: 'text/csv',
        bytes: Buffer.from('a'.repeat(220_000), 'utf8'),
      },
      {
        filename: 'second.csv',
        mimeType: 'text/csv',
        bytes: Buffer.from('second attachment', 'utf8'),
      },
    ]);

    expect(result.attachmentTexts).toHaveLength(2);
    expect(result.attachmentTexts[0]).toContain('File attachment: first.csv');
    expect(result.attachmentTexts[0]).toContain('[truncated]');
    expect(result.attachmentTexts[0]).not.toContain(
      '[omitted: attachment budget exhausted]',
    );
    expect(result.attachmentTexts[1]).toBe(
      'File attachment: second.csv (text/csv)\n[omitted: attachment budget exhausted]',
    );
    expect(result.warnings).toEqual([
      'second.csv: omitted because the shared attachment text budget was exhausted.',
    ]);
  });
});
