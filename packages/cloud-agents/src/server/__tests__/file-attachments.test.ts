import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';

import { extractPromptTextAttachments } from '../file-attachments';

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

  it('extracts spreadsheet cells as text', async () => {
    const workbook = XLSX.utils.book_new();
    const worksheet = XLSX.utils.aoa_to_sheet([
      ['Name', 'Status'],
      ['Invoice import', 'Failed'],
    ]);
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Report');
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    const result = await extractPromptTextAttachments([
      {
        filename: 'report.xlsx',
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
  });

  it('extracts docx and pptx text', async () => {
    const result = await extractPromptTextAttachments([
      {
        filename: 'handoff.docx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        bytes: await buildDocx('Hello DOCX'),
      },
      {
        filename: 'slides.pptx',
        mimeType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        bytes: await buildPptx('Hello PPTX'),
      },
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.attachmentTexts[0]).toContain('Hello DOCX');
    expect(result.attachmentTexts[1]).toContain('Slide 1\nHello PPTX');
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
