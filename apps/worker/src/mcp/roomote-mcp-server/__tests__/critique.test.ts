import { readFile, writeFile } from 'node:fs/promises';

import { JSDOM } from 'jsdom';

import {
  buildCritiqueMultipart,
  captureCritiqueDomInPage,
  captureCritiquePage,
  handleCritiqueVisualReview,
} from '../critique';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(24);
  PNG_SIGNATURE.copy(bytes);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function browserEnvelope(result: unknown): string {
  return JSON.stringify({
    success: true,
    data: { result: JSON.stringify(result) },
    error: null,
  });
}

describe('Critique DOM capture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('builds a connected element-only tree with direct text, viewport coordinates, safe attributes, and allowlisted styles', async () => {
    const dom = new JSDOM(
      '<!doctype html><html><head><title>Example</title><script>window.secretToken="hidden"</script></head><body><main aria-label="Main" data-secret="nope" href="/private"><div>Direct <span>Descendant</span></div><input value="secret" title="token=abc"><textarea>private form value</textarea></main></body></html>',
      {
        url: 'https://example.test/page?token=secret#hash',
        pretendToBeVisual: true,
      },
    );
    Object.defineProperties(dom.window, {
      innerWidth: { value: 800 },
      innerHeight: { value: 600 },
      devicePixelRatio: { value: 2 },
      scrollX: { value: 12 },
      scrollY: { value: 34 },
    });
    Object.defineProperty(
      dom.window.Element.prototype,
      'getBoundingClientRect',
      {
        value() {
          return {
            x: 5,
            y: 7,
            width: 100,
            height: 40,
            top: 7,
            left: 5,
            right: 105,
            bottom: 47,
          };
        },
      },
    );
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('location', dom.window.location);
    vi.stubGlobal('Node', dom.window.Node);
    vi.stubGlobal(
      'getComputedStyle',
      dom.window.getComputedStyle.bind(dom.window),
    );
    vi.stubGlobal(
      'requestAnimationFrame',
      dom.window.requestAnimationFrame.bind(dom.window),
    );

    const first = await captureCritiqueDomInPage('c-test');
    dom.window.document
      .getElementById('roomote-critique-freeze-c-test')
      ?.remove();
    const second = await captureCritiqueDomInPage('c-test-2');
    type CapturedNode = {
      id: string;
      parentId?: string;
      tagName: string;
      text?: string;
      attributes?: Record<string, string>;
      styles: Record<string, string>;
      state: { visible: boolean };
      bounds: { x: number; y: number; width: number; height: number };
    };
    const nodes = first.dom.nodes as CapturedNode[];
    const secondNodes = second.dom.nodes as CapturedNode[];
    const ids = new Set(nodes.map((node) => node.id));
    const main = nodes.find((node) => node.tagName === 'main')!;
    const div = nodes.find((node) => node.tagName === 'div')!;
    const input = nodes.find((node) => node.tagName === 'input')!;
    const textarea = nodes.find((node) => node.tagName === 'textarea')!;

    expect(first.dom.rootNodeId).toBe('n1');
    expect(nodes.map((node) => node.id)).toEqual(
      secondNodes.map((node) => node.id),
    );
    expect(
      nodes
        .slice(1)
        .every((node) => Boolean(node.parentId && ids.has(node.parentId))),
    ).toBe(true);
    expect(nodes[0]?.bounds).toMatchObject({ x: -12, y: -34 });
    expect(div.text).toBe('Direct');
    expect(main.text).toBeUndefined();
    expect(main.attributes).toEqual({ 'aria-label': 'Main' });
    expect(input.attributes).toBeUndefined();
    expect(textarea.text).toBeUndefined();
    expect(nodes.some((node) => node.tagName === 'script')).toBe(false);
    expect(JSON.stringify(nodes)).not.toContain('hidden');
    expect(JSON.stringify(nodes)).not.toContain('private form value');
    expect(main.styles).toHaveProperty('display');
    expect(main.styles).not.toHaveProperty('transform');
    expect(main.state.visible).toBe(true);
    expect(first.page).toEqual({
      url: 'https://example.test/page',
      title: 'Example',
    });
  });
});

describe('Critique capture and multipart', () => {
  const capture = {
    viewport: {
      width: 800,
      height: 600,
      deviceScaleFactor: 2,
      scrollX: 0,
      scrollY: 20,
    },
    document: { width: 800, height: 1200 },
    page: { url: 'https://example.test/page', title: 'Example' },
    nodeCount: 2,
    dom: {
      rootNodeId: 'n1',
      nodes: [
        { id: 'n1', tagName: 'html' },
        { id: 'n2', parentId: 'n1', tagName: 'body' },
      ],
    },
  };

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  function createBrowserRunner() {
    return vi.fn(async (args: string[]) => {
      if (args[0] === 'screenshot') {
        await writeFile(args[2]!, pngHeader(1600, 1200));
        return JSON.stringify({ success: true, data: {}, error: null });
      }
      if (args.includes('--stdin')) return browserEnvelope(capture);
      return browserEnvelope(true);
    });
  }

  it('captures a viewport PNG and rejects dimensions that do not match viewport scale', async () => {
    const good = await captureCritiquePage(undefined, createBrowserRunner());
    expect(good.viewport).toEqual(capture.viewport);
    await expect(readFile(good.domPath, 'utf8')).resolves.toContain(
      '"rootNodeId":"n1"',
    );

    const badRunner = vi.fn(async (args: string[]) => {
      if (args[0] === 'screenshot') {
        await writeFile(args[2]!, pngHeader(800, 600));
        return JSON.stringify({ success: true, data: {}, error: null });
      }
      if (args.includes('--stdin')) return browserEnvelope(capture);
      return browserEnvelope(true);
    });
    await expect(captureCritiquePage(undefined, badRunner)).rejects.toThrow(
      'do not match viewport',
    );
  });

  it('rejects over-limit DOM trees before they can be submitted', async () => {
    const oversizedRunner = vi.fn(async (args: string[]) => {
      if (args[0] === 'screenshot') {
        await writeFile(args[2]!, pngHeader(1600, 1200));
        return JSON.stringify({ success: true, data: {}, error: null });
      }
      if (args.includes('--stdin')) {
        return browserEnvelope({ ...capture, nodeCount: 20_001 });
      }
      return browserEnvelope(true);
    });

    await expect(
      captureCritiquePage(undefined, oversizedRunner),
    ).rejects.toThrow('maximum is 20000');
  });

  it('constructs exact, unique multipart asset fields with input reserved', async () => {
    const multipart = buildCritiqueMultipart({ mode: 'page', captures: [] }, [
      {
        id: 's-1',
        fileName: 's-1.png',
        contentType: 'image/png',
        bytes: pngHeader(1, 1),
      },
      {
        id: 'd-1',
        fileName: 'd-1.json',
        contentType: 'application/json',
        bytes: Buffer.from('{}'),
      },
    ]);
    const form = await new Request('http://local.test', {
      method: 'POST',
      headers: { 'content-type': multipart.contentType },
      body: new Blob([Uint8Array.from(multipart.body)]),
    }).formData();
    expect([...form.keys()]).toEqual(['input', 's-1', 'd-1']);
    expect(JSON.parse(String(form.get('input')))).toEqual({
      mode: 'page',
      captures: [],
    });
    expect(() =>
      buildCritiqueMultipart({ mode: 'page' }, [
        {
          id: 'same',
          fileName: 'a',
          contentType: 'text/plain',
          bytes: Buffer.from('a'),
        },
        {
          id: 'same',
          fileName: 'b',
          contentType: 'text/plain',
          bytes: Buffer.from('b'),
        },
      ]),
    ).toThrow('duplicate');
    expect(() =>
      buildCritiqueMultipart({ mode: 'page' }, [
        {
          id: 'input',
          fileName: 'input',
          contentType: 'text/plain',
          bytes: Buffer.from('a'),
        },
      ]),
    ).toThrow('Invalid');
    expect(() =>
      buildCritiqueMultipart({ mode: 'page' }, [
        {
          id: 'large',
          fileName: 'large.bin',
          contentType: 'application/octet-stream',
          bytes: Buffer.alloc(32 * 1024 * 1024),
        },
      ]),
    ).toThrow('maximum is 33554432');
  });

  it('exercises capture, page review, and comparison through the task-facing handler', async () => {
    vi.stubEnv('ROOMOTE_CRITIQUE_SUBMISSION_CAPABILITY', 'rcq1.123.signature');
    const browser = createBrowserRunner();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'partial',
            findings: [{ id: 'f1', verdict: 'fail', confidence: 0.9 }],
            omittedFindingCount: 2,
            errors: [{ code: 'rule_timeout' }],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'completed',
            findings: [{ id: 'f2', change: 'persisting' }],
            summary: { resolvedRuleIds: ['rule-1'] },
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal('fetch', fetchMock);
    const config = {
      platformApiUrl: 'https://roomote.test',
      token: 'run-token',
    };

    const baselineResult = await handleCritiqueVisualReview(
      { action: 'capture' },
      config,
      undefined,
      browser,
    );
    const baseline = JSON.parse(
      (baselineResult.content[0] as { text: string }).text,
    );
    const candidateResult = await handleCritiqueVisualReview(
      { action: 'capture' },
      config,
      undefined,
      browser,
    );
    const candidate = JSON.parse(
      (candidateResult.content[0] as { text: string }).text,
    );

    const review = await handleCritiqueVisualReview(
      { action: 'review', captureIds: [baseline.id] },
      config,
      undefined,
      browser,
    );
    expect((review.content[0] as { text: string }).text).toContain(
      'omittedFindingCount',
    );
    const comparison = await handleCritiqueVisualReview(
      {
        action: 'compare',
        baselineCaptureId: baseline.id,
        candidateCaptureId: candidate.id,
      },
      config,
      undefined,
      browser,
    );
    expect((comparison.content[0] as { text: string }).text).toContain(
      'resolvedRuleIds',
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const comparisonRequest = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(comparisonRequest.headers).toMatchObject({
      'x-roomote-critique-submission-capability': 'rcq1.123.signature',
    });
    const comparisonBody = Buffer.from(
      await (comparisonRequest.body as Blob).arrayBuffer(),
    ).toString();
    expect(comparisonBody).toContain('name="input"');
    expect(comparisonBody).toContain('"mode":"comparison"');
    expect(comparisonBody).toContain(`"baselineCaptureId":"${baseline.id}"`);
    expect(comparisonBody).toContain(`"candidateCaptureId":"${candidate.id}"`);
  });
});
