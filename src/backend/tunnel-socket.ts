import type { SSHConnectionConfig } from '../types';
import { isPrivateAddress, toSocketHostname } from './security';

export function wrapWebSocketAsSocket(ws: WebSocket, remoteAddress: string): Socket {
  let streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let streamClosed = false;
  let pendingBlobChain: Promise<void> | null = null;

  try {
    (ws as unknown as { binaryType?: string }).binaryType = 'arraybuffer';
  } catch {
    // Ignore if the runtime does not permit setting binaryType
  }

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

  const enqueueBytes = (bytes: Uint8Array) => {
    if (streamClosed || !streamController || bytes.byteLength === 0) return;
    try {
      streamController.enqueue(bytes);
    } catch {
      // Controller may already be closed
    }
  };

  const extractSyncBytes = (data: unknown): Uint8Array | null => {
    if (data instanceof ArrayBuffer || Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
      const buf = data as ArrayBuffer;
      return buf.byteLength > 0 ? new Uint8Array(buf) : new Uint8Array(0);
    }
    if (ArrayBuffer.isView(data)) {
      return data.byteLength > 0
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(0);
    }
    if (typeof data === 'string') {
      return data.length > 0 ? new TextEncoder().encode(data) : new Uint8Array(0);
    }
    return null;
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
    const data = event.data as unknown;
    const syncBytes = extractSyncBytes(data);
    if (syncBytes !== null && !pendingBlobChain) {
      enqueueBytes(syncBytes);
      return;
    }
    if (syncBytes !== null && pendingBlobChain) {
      pendingBlobChain = pendingBlobChain.then(() => {
        enqueueBytes(syncBytes);
      });
      return;
    }
    if (data && typeof (data as Blob).arrayBuffer === 'function') {
      const prev = pendingBlobChain ?? Promise.resolve();
      const next = prev
        .then(() => (data as Blob).arrayBuffer())
        .then((buf) => {
          enqueueBytes(new Uint8Array(buf));
        })
        .catch((err) => {
          errorReadable(err);
        })
        .finally(() => {
          if (pendingBlobChain === next) {
            pendingBlobChain = null;
          }
        });
      pendingBlobChain = next;
    }
  });

  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  ws.addEventListener('close', () => {
    if (pendingBlobChain) {
      void pendingBlobChain.finally(() => {
        closeReadable();
        resolveClosed();
      });
    } else {
      closeReadable();
      resolveClosed();
    }
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
