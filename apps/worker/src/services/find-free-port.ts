import net from 'node:net';

/**
 * Finds a free ephemeral port on the loopback interface.
 *
 * Binds a temporary TCP server to port 0 on 127.0.0.1, which causes the OS
 * to assign an available ephemeral port. The server is immediately closed
 * and the assigned port is returned.
 *
 * There is a small race window between closing the temporary server and
 * another service binding to the port. In practice this is milliseconds and
 * collisions are extremely unlikely.
 */
export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (typeof addr !== 'object' || !addr || !addr.port) {
        srv.close(() =>
          reject(
            new Error('Failed to resolve ephemeral port from server address'),
          ),
        );
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}
