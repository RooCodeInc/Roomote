import { proxyRemoteMcpRequest } from '@/lib/server/remote-mcp-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const DELETE = (request: Parameters<typeof proxyRemoteMcpRequest>[0]) =>
  proxyRemoteMcpRequest(request, 'mcp');
export const GET = DELETE;
export const POST = DELETE;
