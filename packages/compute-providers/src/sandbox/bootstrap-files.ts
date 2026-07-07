import * as fs from 'node:fs';
import * as path from 'node:path';

const SANDBOX_BOOTSTRAP_FILES = [
  'install-browser-agent.sh',
  'install-worker.sh',
] as const;

type SandboxBootstrapFileName = (typeof SANDBOX_BOOTSTRAP_FILES)[number];

export interface LoadedSandboxBootstrapFiles {
  files: { path: string; content: Buffer }[];
  ignoredFiles: string[];
  localDir: string;
}

function getLocalSandboxFilesDir(): string {
  if (process.env.LOCAL_SANDBOX_FILES_DIR) {
    return path.resolve(process.env.LOCAL_SANDBOX_FILES_DIR);
  }

  return path.resolve(process.cwd(), '../../.docker/sandbox');
}

export function loadSandboxBootstrapFiles(
  remoteDir: string,
): LoadedSandboxBootstrapFiles {
  const localDir = getLocalSandboxFilesDir();

  if (!fs.existsSync(localDir)) {
    throw new Error(`Missing sandbox bootstrap directory: ${localDir}`);
  }

  const files = SANDBOX_BOOTSTRAP_FILES.map((fileName) => {
    const localPath = path.join(localDir, fileName);

    if (!fs.existsSync(localPath)) {
      throw new Error(`Missing required sandbox bootstrap file: ${localPath}`);
    }

    return {
      path: `${remoteDir}/${fileName}`,
      content: fs.readFileSync(localPath),
    };
  });

  const ignoredFiles = fs
    .readdirSync(localDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isFile() &&
        !SANDBOX_BOOTSTRAP_FILES.includes(
          entry.name as SandboxBootstrapFileName,
        ),
    )
    .map((entry) => entry.name);

  return {
    files,
    ignoredFiles,
    localDir,
  };
}
