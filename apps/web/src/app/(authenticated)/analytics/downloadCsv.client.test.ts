import { downloadAnalyticsRowsCsv } from './downloadCsv';

function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('downloadAnalyticsRowsCsv', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;

  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(() => 'blob:analytics-test'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      configurable: true,
      writable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      writable: true,
      value: originalCreateObjectURL,
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      writable: true,
      value: originalRevokeObjectURL,
    });
    Object.defineProperty(HTMLAnchorElement.prototype, 'click', {
      configurable: true,
      writable: true,
      value: originalClick,
    });
  });

  it('neutralizes formula-leading values before CSV escaping', async () => {
    downloadAnalyticsRowsCsv({
      filenamePrefix: 'analytics',
      data: {
        columns: [
          { key: 'title', label: 'Task Title' },
          { key: 'safe', label: 'Safe' },
        ],
        rows: [
          {
            id: 'row-1',
            values: {
              title: '=SUM(A1:A2)',
              safe: 'normal text',
            },
          },
          {
            id: 'row-2',
            values: {
              title: '  -2+3',
              safe: '@username',
            },
          },
        ],
      },
    });

    const createObjectURL = vi.mocked(URL.createObjectURL);
    expect(createObjectURL).toHaveBeenCalledTimes(1);

    const blob = createObjectURL.mock.calls[0]?.[0];
    expect(blob).toBeInstanceOf(Blob);

    const csv = await readBlobText(blob as Blob);
    const rows = csv.split('\n');

    expect(rows[0]).toBe('Task Title,Safe');
    expect(rows[1]).toBe("'=SUM(A1:A2),normal text");
    expect(rows[2]).toBe("'  -2+3,'@username");
  });

  it('does not modify regular values', async () => {
    downloadAnalyticsRowsCsv({
      filenamePrefix: 'analytics',
      data: {
        columns: [{ key: 'title', label: 'Task Title' }],
        rows: [
          {
            id: 'row-1',
            values: { title: 'Fix analytics hover state' },
          },
        ],
      },
    });

    const createObjectURL = vi.mocked(URL.createObjectURL);
    const blob = createObjectURL.mock.calls[0]?.[0];
    const csv = await readBlobText(blob as Blob);

    expect(csv).toContain('Fix analytics hover state');
    expect(csv).not.toContain("'Fix analytics hover state");
  });
});
