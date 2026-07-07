import type { WebSocket } from 'ws';

/**
 * Messages sent from the client (browser) to the server.
 */
interface ClientMessage {
  type: 'input' | 'resize';
  data?: string;
  cols?: number;
  rows?: number;
}

/**
 * Messages sent from the server to the client (browser).
 */
interface ServerMessage {
  type: 'output' | 'exit' | 'error';
  data?: string;
  exitCode?: number;
  message?: string;
}

/**
 * Lazily loaded node-pty module. Loaded on first terminal connection rather
 * than at module import time so setup() can ensure the native binary is ready
 * before terminals are used.
 */
let ptyModule: typeof import('node-pty') | null = null;

async function getPty(): Promise<typeof import('node-pty')> {
  if (!ptyModule) {
    ptyModule = await import('node-pty');
  }

  return ptyModule;
}

function send(ws: WebSocket, msg: ServerMessage) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// Use a generic type for PTY process to avoid importing node-pty at the top level.
interface PtyProcess {
  onData(callback: (data: string) => void): { dispose(): void };
  onExit(callback: (e: { exitCode: number }) => void): { dispose(): void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

interface Session {
  pty: PtyProcess;
  dataDisposable: { dispose(): void };
  exitDisposable: { dispose(): void };
}

/**
 * Manages pseudo-terminal sessions and bridges them to WebSocket connections.
 */
export class TerminalManager {
  private sessions = new Map<string, Session>();

  /**
   * @param workingDirectory - The working directory for terminal sessions.
   * @param userEnv - Explicit env or getter for terminal sessions. When
   *   provided, replaces process.env to prevent worker infrastructure vars from
   *   leaking to user shells.
   */
  constructor(
    private workingDirectory: string,
    private userEnv?: Record<string, string> | (() => Record<string, string>),
  ) {}

  async handleConnection(ws: WebSocket, params: URLSearchParams) {
    const sessionId = params.get('sessionId') ?? 'default';

    const cols = Math.min(
      Math.max(parseInt(params.get('cols') ?? '80', 10) || 80, 1),
      500,
    );

    const rows = Math.min(
      Math.max(parseInt(params.get('rows') ?? '24', 10) || 24, 1),
      200,
    );

    // Kill any existing session with this ID before creating a new one.
    this.killSession(sessionId);

    let pty: typeof import('node-pty');

    try {
      pty = await getPty();
    } catch (err) {
      send(ws, { type: 'error', message: `node-pty not available: ${err}` });
      ws.close();
      return;
    }

    // Track the latest terminal size for this session.
    let currentCols = cols;
    let currentRows = rows;

    const spawnShell = () => {
      let ptyProcess: PtyProcess;

      try {
        const baseEnv =
          typeof this.userEnv === 'function'
            ? this.userEnv()
            : (this.userEnv ?? (process.env as Record<string, string>));

        ptyProcess = pty.spawn('bash', ['--login'], {
          name: 'xterm-256color',
          cols: currentCols,
          rows: currentRows,
          cwd: this.workingDirectory,
          env: {
            ...baseEnv,
            TERM: 'xterm-256color',
            COLORTERM: 'truecolor',
          },
        });
      } catch (err) {
        send(ws, { type: 'error', message: `Failed to spawn shell: ${err}` });
        ws.close();
        return;
      }

      const dataDisposable = ptyProcess.onData((data) =>
        send(ws, { type: 'output', data }),
      );

      const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
        send(ws, { type: 'exit', exitCode });
        this.sessions.delete(sessionId);
        ws.close();
      });

      this.sessions.set(sessionId, {
        pty: ptyProcess,
        dataDisposable,
        exitDisposable,
      });
    };

    spawnShell();

    // WebSocket → PTY.
    ws.on('message', (raw) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString());
        const session = this.sessions.get(sessionId);

        if (!session) {
          return;
        }

        switch (msg.type) {
          case 'input':
            if (typeof msg.data === 'string') {
              session.pty.write(msg.data);
            }

            break;

          case 'resize':
            if (typeof msg.cols === 'number' && typeof msg.rows === 'number') {
              const c = Math.min(Math.max(msg.cols, 1), 500);
              const r = Math.min(Math.max(msg.rows, 1), 200);
              currentCols = c;
              currentRows = r;
              session.pty.resize(c, r);
            }

            break;
        }
      } catch {
        // Malformed message, ignore.
      }
    });

    ws.on('close', () => {
      this.killSession(sessionId);
    });
  }

  private killSession(sessionId: string) {
    const session = this.sessions.get(sessionId);

    if (session) {
      session.dataDisposable.dispose();
      session.exitDisposable.dispose();

      try {
        session.pty.kill();
      } catch {
        // Already dead, ignore.
      }

      this.sessions.delete(sessionId);
    }
  }

  dispose() {
    for (const id of this.sessions.keys()) {
      this.killSession(id);
    }
  }
}
