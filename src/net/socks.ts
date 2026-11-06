/**
 * A minimal SOCKS5 client (RFC 1928, CONNECT, no authentication), used to dial
 * through the proxy inside a hopsql VPN container. Hostnames are sent as-is so
 * the container resolves them with the VPN's DNS.
 */

import net from 'node:net';

export interface SocksProxy {
  host: string;
  port: number;
}

const REPLIES: Record<number, string> = {
  1: 'general failure',
  2: 'connection not allowed',
  3: 'network unreachable',
  4: 'host unreachable',
  5: 'connection refused',
  6: 'TTL expired',
  7: 'command not supported',
  8: 'address type not supported',
};

export function socksRequest(host: string, port: number): Buffer {
  const portBytes = [(port >> 8) & 0xff, port & 0xff];
  if (net.isIPv4(host))
    return Buffer.from([5, 1, 0, 1, ...host.split('.').map(Number), ...portBytes]);
  const name = Buffer.from(host, 'utf8');
  if (name.length === 0 || name.length > 255) throw new Error('Invalid SOCKS destination host');
  return Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from(portBytes)]);
}

/** Bytes in a complete CONNECT reply, or 0 while more are needed. */
export function socksReplyLength(reply: Buffer): number {
  if (reply.length < 5) return 0;
  const atyp = reply[3];
  const length =
    atyp === 1 ? 10 : atyp === 4 ? 22 : atyp === 3 ? 7 + reply[4] : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(length)) throw new Error('Malformed SOCKS reply');
  return reply.length >= length ? length : 0;
}

/** Whether a SOCKS5 server answers the no-auth greeting, i.e. the proxy is serving. */
export function socksAvailable(proxy: SocksProxy, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('error', () => done(false));
    socket.once('close', () => done(false));
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    socket.once('data', (data: Buffer) => done(data[0] === 5 && data[1] === 0));
  });
}

/** A socket connected to `host:port` through the proxy, ready for the caller's protocol. */
export function socksConnect(
  proxy: SocksProxy,
  host: string,
  port: number,
  timeoutMs: number
): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.host, port: proxy.port });
    let stage: 'greeting' | 'connect' = 'greeting';
    let buffer = Buffer.alloc(0);
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs, () => fail(new Error('VPN proxy timed out')));
    socket.once('error', (error) => fail(new Error(`VPN proxy unreachable: ${error.message}`)));
    socket.once('close', () => fail(new Error('VPN proxy closed the connection')));
    socket.once('connect', () => socket.write(Buffer.from([5, 1, 0])));
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      try {
        if (stage === 'greeting') {
          if (buffer.length < 2) return;
          if (buffer[0] !== 5 || buffer[1] !== 0)
            return fail(new Error('VPN proxy refused the SOCKS handshake'));
          buffer = buffer.subarray(2);
          stage = 'connect';
          socket.write(socksRequest(host, port));
        }
        const length = socksReplyLength(buffer);
        if (!length) return;
        if (buffer[1] !== 0)
          return fail(
            new Error(
              `VPN could not reach ${host}:${port}: ${REPLIES[buffer[1]] ?? `error ${buffer[1]}`}`
            )
          );
        // Paused so nothing after the reply is lost before the caller reads.
        socket.pause();
        socket.off('data', onData);
        socket.removeAllListeners('close');
        socket.removeAllListeners('error');
        socket.removeAllListeners('timeout');
        socket.setTimeout(0);
        const rest = buffer.subarray(length);
        if (rest.length) socket.unshift(rest);
        resolve(socket);
      } catch (error) {
        fail(error as Error);
      }
    };
    socket.on('data', onData);
  });
}
