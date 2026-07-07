import { access, readFile, unlink } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import mime from 'mime-types';
import type { TaskArtifactType } from '@roomote/types';

import { uploadArtifact } from './api-client.js';
import type { ArtifactConfig } from './types.js';

const TMP_DIR = (() => {
  try {
    return realpathSync('/tmp');
  } catch {
    return resolve('/tmp');
  }
})();

function toPosixPath(value: string): string {
  return value.split(sep).join('/');
}

export function resolveWorkspaceOrTmpPath(
  filePath: string,
  workspacePath: string,
): string {
  const workspaceRoot = resolve(workspacePath);
  const resolvedPath = resolve(workspaceRoot, filePath);

  let canonicalPath: string;
  try {
    canonicalPath = realpathSync(resolvedPath);
  } catch {
    canonicalPath = resolvedPath;
  }

  const allowedRoots = [workspaceRoot, TMP_DIR];
  const matchedRoot = allowedRoots.find(
    (allowedRoot) =>
      canonicalPath === allowedRoot ||
      canonicalPath.startsWith(`${allowedRoot}${sep}`),
  );

  if (!matchedRoot) {
    throw new Error(
      `Path must be within workspace or /tmp. Resolved: ${canonicalPath}, Workspace: ${workspaceRoot}`,
    );
  }

  return canonicalPath;
}

function resolveArtifactPath(
  filePath: string,
  workspacePath: string,
): { artifactPath: string; canonicalPath: string } {
  const workspaceRoot = resolve(workspacePath);
  const canonicalPath = resolveWorkspaceOrTmpPath(filePath, workspacePath);

  const allowedRoots = [workspaceRoot, TMP_DIR];
  const matchedRoot = allowedRoots.find(
    (allowedRoot) =>
      canonicalPath === allowedRoot ||
      canonicalPath.startsWith(`${allowedRoot}${sep}`),
  );

  if (!matchedRoot) {
    throw new Error(
      `Path must be within workspace or /tmp. Resolved: ${canonicalPath}, Workspace: ${workspaceRoot}`,
    );
  }

  if (matchedRoot === TMP_DIR) {
    const relativeTmpPath = relative(TMP_DIR, canonicalPath);
    return {
      canonicalPath,
      artifactPath: toPosixPath(`tmp/${relativeTmpPath}`),
    };
  }

  return {
    canonicalPath,
    artifactPath: toPosixPath(relative(workspaceRoot, canonicalPath)),
  };
}

interface PreparedLocalArtifactUpload {
  filePath: string;
  artifactPath: string;
  contentType: string;
  content: Buffer;
}

export async function prepareLocalArtifactUpload(
  filePath: string,
  workspacePath: string,
): Promise<PreparedLocalArtifactUpload> {
  const { artifactPath } = resolveArtifactPath(filePath, workspacePath);
  const resolvedPath = resolve(workspacePath, filePath);

  try {
    await access(resolvedPath, constants.R_OK);
  } catch {
    throw new Error(`File not found or not readable: ${filePath}`);
  }

  return {
    filePath: resolvedPath,
    artifactPath,
    contentType:
      mime.lookup(resolvedPath) ||
      mime.lookup(filePath) ||
      'application/octet-stream',
    content: await readFile(resolvedPath),
  };
}

export async function uploadPreparedArtifact(
  config: ArtifactConfig,
  input: {
    taskId: string;
    artifactType: TaskArtifactType;
    preparedArtifact: PreparedLocalArtifactUpload;
  },
): Promise<{
  artifactId: string;
  version: number;
  viewUrl: string;
  artifactType: TaskArtifactType;
  rawUrl?: string;
}> {
  const { preparedArtifact } = input;

  return uploadArtifact(config, {
    taskId: input.taskId,
    path: preparedArtifact.artifactPath,
    artifactType: input.artifactType,
    contentType: preparedArtifact.contentType,
    content: preparedArtifact.content,
  });
}

export async function deletePreparedLocalArtifact(
  preparedArtifact: PreparedLocalArtifactUpload,
): Promise<void> {
  try {
    await unlink(preparedArtifact.filePath);
  } catch {
    // Non-fatal -- file may already be gone.
  }
}
