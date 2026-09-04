import { basename } from 'node:path';

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Env } from '@roomote/env';
import { getArtifactStorageKey } from '@roomote/types';

const PRESIGNED_URL_EXPIRY_SECONDS = 3600;
const LOCAL_DOCKER_HOSTNAME = 'host.docker.internal';
const HOST_LOCAL_ENDPOINT_HOSTNAMES = new Set(['localhost', '127.0.0.1']);

const s3PresignClients = new Map<string, S3Client>();

function createS3Client(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: Env.S3_REGION,
    credentials: {
      accessKeyId: Env.S3_ACCESS_KEY_ID,
      secretAccessKey: Env.S3_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
  });
}

function getS3PresignClient(endpoint: string): S3Client {
  const existingClient = s3PresignClients.get(endpoint);
  if (existingClient) {
    return existingClient;
  }

  const client = createS3Client(endpoint);
  s3PresignClients.set(endpoint, client);
  return client;
}

function parseHostname(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

function formatEndpointUrl(url: URL): string {
  if (url.pathname === '/' && !url.search && !url.hash) {
    return `${url.protocol}//${url.host}`;
  }

  return url.toString();
}

export function resolveArtifactPresignEndpointForRequest(
  requestHost: string | undefined,
  baseEndpoint = Env.S3_PRESIGN_ENDPOINT ?? Env.S3_ENDPOINT,
): string {
  if (parseHostname(requestHost) !== LOCAL_DOCKER_HOSTNAME) {
    return baseEndpoint;
  }

  let endpointUrl: URL;
  try {
    endpointUrl = new URL(baseEndpoint);
  } catch {
    return baseEndpoint;
  }

  if (!HOST_LOCAL_ENDPOINT_HOSTNAMES.has(endpointUrl.hostname)) {
    return baseEndpoint;
  }

  endpointUrl.hostname = LOCAL_DOCKER_HOSTNAME;
  return formatEndpointUrl(endpointUrl);
}

export async function generateUploadUrl(
  taskId: string,
  artifactId: string,
  path: string,
  version: number,
  contentType: string,
  size: number,
  options: { presignEndpoint?: string } = {},
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: Env.S3_BUCKET_ARTIFACTS,
    Key: getArtifactStorageKey({ taskId }, artifactId, path, version),
    ContentType: contentType,
    ContentLength: size,
  });

  return getSignedUrl(
    getS3PresignClient(
      options.presignEndpoint ?? Env.S3_PRESIGN_ENDPOINT ?? Env.S3_ENDPOINT,
    ),
    command,
    {
      expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
    },
  );
}

export async function generateDownloadUrl(
  taskId: string,
  artifactId: string,
  path: string,
  version: number,
  options: { presignEndpoint?: string } = {},
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: Env.S3_BUCKET_ARTIFACTS,
    Key: getArtifactStorageKey({ taskId }, artifactId, path, version),
    ResponseContentDisposition: `attachment; filename="${basename(path)}"`,
  });

  return getSignedUrl(
    getS3PresignClient(
      options.presignEndpoint ?? Env.S3_PRESIGN_ENDPOINT ?? Env.S3_ENDPOINT,
    ),
    command,
    {
      expiresIn: PRESIGNED_URL_EXPIRY_SECONDS,
    },
  );
}
