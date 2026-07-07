import { EventEmitter } from 'events';
import type { IncomingMessage, ServerResponse } from 'http';

vi.mock('../logger', () => ({
  logger: {
    info: vi.fn(),
  },
  escapeForLog: (s: string) => s,
}));

vi.mock('../request-context', () => ({
  getRequestContext: vi.fn(),
}));

import { createAccessLog, emitWsAccessLog } from '../access-log';
import { logger } from '../logger';
import { getRequestContext } from '../request-context';

function createMockReq(
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    method: 'GET',
    url: '/',
    headers: { host: 'test.example.com' },
    ...overrides,
  } as unknown as IncomingMessage;
}

interface MockRes extends EventEmitter {
  statusCode: number;
  writableFinished: boolean;
}

function createMockRes(): MockRes {
  const res = new EventEmitter() as MockRes;
  res.statusCode = 200;
  res.writableFinished = false;
  return res;
}

interface AccessLogEntry {
  method: string;
  path: string;
  host: string;
  requestId?: string;
  traceparent?: string;
  flyRequestId?: string;
  statusCode: number;
  clientError?: string;
  upstreamStatusCode?: number;
  upstreamError?: string;
  upstreamTarget?: string;
  durationMs: number;
  outcome: string;
}

function getLogEntry(): AccessLogEntry {
  const calls = vi.mocked(logger.info).mock.calls;
  const [fields] = calls[0]!;
  return fields as unknown as AccessLogEntry;
}

describe('createAccessLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRequestContext).mockReturnValue(undefined);
  });

  it('emits an info access log on response finish', () => {
    const req = createMockReq();
    const res = createMockRes();

    const ctx = createAccessLog(req, res as unknown as ServerResponse);
    ctx.outcome = 'proxied';

    res.writableFinished = true;
    res.emit('finish');

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = vi.mocked(logger.info).mock.calls[0]!;
    expect(msg).toBe('access');
    expect(fields).toMatchObject({
      method: 'GET',
      path: '/',
      host: 'test.example.com',
      statusCode: 200,
      outcome: 'proxied',
    });
    expect(typeof getLogEntry().durationMs).toBe('number');
  });

  it('sets clientError on close before finish', () => {
    const req = createMockReq();
    const res = createMockRes();

    createAccessLog(req, res as unknown as ServerResponse);

    res.emit('close');

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(getLogEntry().clientError).toBe('connection_closed');
  });

  it('does not double-log when both finish and close fire', () => {
    const req = createMockReq();
    const res = createMockRes();

    const ctx = createAccessLog(req, res as unknown as ServerResponse);
    ctx.outcome = 'proxied';

    res.writableFinished = true;
    res.emit('finish');
    res.emit('close');

    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('includes upstream fields when set', () => {
    const req = createMockReq();
    const res = createMockRes();

    const ctx = createAccessLog(req, res as unknown as ServerResponse);
    ctx.outcome = 'proxied';
    ctx.upstreamStatusCode = 200;
    ctx.upstreamTarget = 'https://sandbox.example.com:3000';

    res.writableFinished = true;
    res.emit('finish');

    const entry = getLogEntry();
    expect(entry.upstreamStatusCode).toBe(200);
    expect(entry.upstreamTarget).toBe('https://sandbox.example.com:3000');
  });

  it('includes upstream error on proxy failure', () => {
    const req = createMockReq();
    const res = createMockRes();

    const ctx = createAccessLog(req, res as unknown as ServerResponse);
    ctx.outcome = 'proxy_error';
    ctx.upstreamError = 'ECONNREFUSED';
    res.statusCode = 502;

    res.writableFinished = true;
    res.emit('finish');

    expect(logger.info).toHaveBeenCalledTimes(1);
    const entry = getLogEntry();
    expect(entry.outcome).toBe('proxy_error');
    expect(entry.upstreamError).toBe('ECONNREFUSED');
    expect(entry.statusCode).toBe(502);
  });

  it('logs at info level for 5xx status codes', () => {
    const req = createMockReq();
    const res = createMockRes();

    const ctx = createAccessLog(req, res as unknown as ServerResponse);
    ctx.outcome = 'server_error';
    res.statusCode = 500;

    res.writableFinished = true;
    res.emit('finish');

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(getLogEntry().statusCode).toBe(500);
  });

  it('logs at info level for non-5xx status codes', () => {
    const req = createMockReq();
    const res = createMockRes();

    const ctx = createAccessLog(req, res as unknown as ServerResponse);
    ctx.outcome = 'not_found';
    res.statusCode = 404;

    res.writableFinished = true;
    res.emit('finish');

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(getLogEntry().statusCode).toBe(404);
  });

  it('defaults outcome to unknown when not set', () => {
    const req = createMockReq();
    const res = createMockRes();

    createAccessLog(req, res as unknown as ServerResponse);

    res.writableFinished = true;
    res.emit('finish');

    expect(getLogEntry().outcome).toBe('unknown');
  });

  it('includes correlation fields from request context and headers', () => {
    vi.mocked(getRequestContext).mockReturnValue({
      requestId: 'req-123',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });

    const req = createMockReq({
      headers: {
        host: 'test.example.com',
        'fly-request-id': 'fly-123',
      },
    });
    const res = createMockRes();

    createAccessLog(req, res as unknown as ServerResponse);

    res.writableFinished = true;
    res.emit('finish');

    expect(getLogEntry()).toMatchObject({
      requestId: 'req-123',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      flyRequestId: 'fly-123',
    });
  });

  it('normalizes array-valued correlation headers when context is absent', () => {
    const req = createMockReq({
      headers: {
        host: 'test.example.com',
        'x-request-id': ['', 'req-array'],
        traceparent: [
          '',
          '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        ],
        'fly-request-id': ['', 'fly-array'],
      },
    });
    const res = createMockRes();

    createAccessLog(req, res as unknown as ServerResponse);

    res.writableFinished = true;
    res.emit('finish');

    expect(getLogEntry()).toMatchObject({
      requestId: 'req-array',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      flyRequestId: 'fly-array',
    });
  });

  it('omits flyRequestId when absent', () => {
    vi.mocked(getRequestContext).mockReturnValue({
      requestId: 'req-123',
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });

    const req = createMockReq();
    const res = createMockRes();

    createAccessLog(req, res as unknown as ServerResponse);

    res.writableFinished = true;
    res.emit('finish');

    expect(getLogEntry().flyRequestId).toBeUndefined();
  });
});

describe('emitWsAccessLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getRequestContext).mockReturnValue(undefined);
  });

  it('emits an info ws_access log', () => {
    const req = createMockReq();

    emitWsAccessLog(req, {
      outcome: 'proxied',
      upstreamTarget: 'https://sandbox.example.com:3000',
      statusCode: 101,
      durationMs: 42,
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [fields, msg] = vi.mocked(logger.info).mock.calls[0]!;
    expect(msg).toBe('ws_access');
    expect(fields).toMatchObject({
      method: 'GET',
      path: '/',
      host: 'test.example.com',
      outcome: 'proxied',
      statusCode: 101,
      upstreamTarget: 'https://sandbox.example.com:3000',
      durationMs: 42,
    });
  });

  it('omits upstream target when not provided', () => {
    const req = createMockReq();

    emitWsAccessLog(req, {
      outcome: 'bad_request',
      durationMs: 1,
    });

    expect(getLogEntry().upstreamTarget).toBeUndefined();
  });

  it('logs at info level for 5xx status codes', () => {
    const req = createMockReq();

    emitWsAccessLog(req, {
      outcome: 'upstream_error',
      statusCode: 503,
      durationMs: 10,
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(getLogEntry().statusCode).toBe(503);
  });

  it('logs at info level for non-5xx status codes', () => {
    const req = createMockReq();

    emitWsAccessLog(req, {
      outcome: 'proxied',
      statusCode: 101,
      durationMs: 5,
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('includes ws correlation fields', () => {
    vi.mocked(getRequestContext).mockReturnValue({
      requestId: 'ws-req-123',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
    });

    const req = createMockReq({
      headers: {
        host: 'test.example.com',
        'fly-request-id': 'fly-ws-123',
      },
    });

    emitWsAccessLog(req, {
      outcome: 'proxied',
      statusCode: 101,
      durationMs: 5,
    });

    expect(getLogEntry()).toMatchObject({
      requestId: 'ws-req-123',
      traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01',
      flyRequestId: 'fly-ws-123',
    });
  });
});
