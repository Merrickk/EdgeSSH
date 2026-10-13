import type { SSHConnectionConfig } from '../types';
import { isPrivateAddress, toSocketHostname } from './security';

export function wrapWebSocketAsSocket(ws: WebSocket, remoteAddress: string): Socket {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let streamClosed = false;

  const closeReadable = () => {
    if (streamClosed) return;
    streamClosed = true;
    try {
      streamController?.close();
    } catch {
      // Stream already closed or errored
    }
  };

  const errorReadable = (reason: unknown) => {
    if (streamClosed) return;
    streamClosed = true;
    try {
      streamController?.error(reason instanceof Error ? reason : new Error('Cloudflare Tunnel WebSocket error'));
    } catch {
      // Stream already closed or errored
    }
  };

  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
    },
    cancel() {
      streamClosed = true;
      try {
        ws.close(1000, 'SSH stream cancelled');
      } catch {
        // Ignore close errors
      }
    },
  });

  ws.addEventListener('message', (event: MessageEvent) => {
    if (streamClosed || !streamController) return;
    try {
      if (event.data instanceof ArrayBuffer) {
        if (event.data.byteLength > 0) {
          streamController.enqueue(new Uint8Array(event.data));
        }
      } else if (ArrayBuffer.isView(event.data)) {
        const view = event.data;
        if (view.byteLength > 0) {
          streamController.enqueue(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
        }
      } else if (typeof event.data === 'string' && event.data.length > 0) {
        streamController.enqueue(new TextEncoder().encode(event.data));
      }
    } catch {
      // Controller may already be closed
    }
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  ws.addEventListener('close', () => {
    closeReadable();
    resolveClosed();
  });

  ws.addEventListener('error', (event) => {
    errorReadable(event);
    resolveClosed();
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (ws.readyState !== WebSocket.OPEN) {
        throw new Error('Cloudflare Tunnel WebSocket is not open');
      }
      ws.send(chunk);
    },
    close() {
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'SSH session closed');
        }
      } catch {
        // Ignore close errors
      }
    },
    abort() {
      try {
        ws.close(1000, 'SSH stream aborted');
      } catch {
        // Ignore close errors
      }
    },
  });

  const closeSocket = async (): Promise<void> => {
    closeReadable();
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'SSH session closed');
      }
    } catch {
      // Ignore close errors
    }
    resolveClosed();
  };

  const socketLike = {
    readable,
    writable,
    closed,
    opened: Promise.resolve({ remoteAddress, localAddress: 'cloudflare-tunnel' }),
    close: closeSocket,
    startTls: () => {
      throw new Error('startTls is not supported on Cloudflare Tunnel WebSocket connections');
    },
  };

  return socketLike as unknown as Socket;
}

export async function openCloudflareTunnelSocket(
  config: SSHConnectionConfig,
  timeoutMs: number,
): Promise<Socket> {
  if (isPrivateAddress(config.host)) {
    throw new Error('Private and reserved SSH targets are disabled');
  }

  const hostHeader = toSocketHostname(config.host);
  const customPort = config.port && config.port !== 22 && config.port !== 443 ? `:${config.port}` : '';
  const targetUrl = `https://${hostHeader}${customPort}/`;

  const headers: Record<string, string> = {
    Upgrade: 'websocket',
  };
  if (config.cfAccessClientId) {
    headers['CF-Access-Client-Id'] = config.cfAccessClientId;
  }
  if (config.cfAccessClientSecret) {
    headers['CF-Access-Client-Secret'] = config.cfAccessClientSecret;
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const response = await Promise.race([
      fetch(targetUrl, {
        headers,
        redirect: 'manual',
      }),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error('Cloudflare Tunnel WebSocket connection timed out')),
          timeoutMs,
        );
      }),
    ]);

    const tunnelWs = response.webSocket;
    if (!tunnelWs) {
      if (response.status === 302 || response.status === 301 || response.status === 403) {
        const location = response.headers.get('Location') ?? '';
        if (location.includes('cloudflareaccess.com')) {
          throw new Error(
            'Cloudflare Access authentication required: configure Service Token (CF-Access-Client-Id & Secret) or set Tunnel policy to Service Auth / Bypass',
          );
        }
      }
      throw new Error(
        `Cloudflare Tunnel WebSocket upgrade failed (HTTP ${response.status}). Ensure Public Hostname service type is set to SSH`,
      );
    }

    const socket = wrapWebSocketAsSocket(tunnelWs, `${hostHeader}:443`);
    tunnelWs.accept();
    return socket;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
