/**
 * Realtime client for WebSocket/SSE connections.
 * Used by workforce chat, voice agents, and live dashboards.
 */

/** Listener invoked with the decoded payload of a server event. */
export type RealtimeListener<T = unknown> = (data: T) => void;

export interface RealtimeClientOptions {
  url?: string;
  token?: string;
  reconnect?: boolean;
}

export class RealtimeClient {
  private url: string;
  private token: string;
  private reconnect: boolean;
  private ws: WebSocket | null = null;
  private listeners: Map<string, Set<RealtimeListener<unknown>>> = new Map();
  private connectListeners: Set<() => void> = new Set();
  private disconnectListeners: Set<() => void> = new Set();
  public isConnected = false;
  public isConnecting = false;
  public socketId: string | null = null;

  constructor(options: RealtimeClientOptions = {}) {
    this.url = options.url || process.env.NEXT_PUBLIC_APP_URL || "https://learn.alolabs.net";
    this.token = options.token || "";
    this.reconnect = options.reconnect ?? true;
  }

  connect(): void {
    if (typeof WebSocket === "undefined") return;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return;
    this.isConnecting = true;
    try {
      const wsUrl = this.url.replace(/^http/, "ws") + "/ws";
      this.ws = new WebSocket(wsUrl);
      this.ws.onopen = () => {
        this.isConnected = true;
        this.isConnecting = false;
        for (const cb of this.connectListeners) cb();
      };
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          this.emit(data.type || "message", data);
        } catch { /* ignore non-JSON */ }
      };
      this.ws.onclose = () => {
        this.isConnected = false;
        this.isConnecting = false;
        for (const cb of this.disconnectListeners) cb();
        if (this.reconnect) setTimeout(() => this.connect(), 5000);
      };
    } catch {
      this.isConnecting = false;
    }
  }

  disconnect(): void {
    this.reconnect = false;
    this.isConnected = false;
    this.isConnecting = false;
    this.ws?.close();
    this.ws = null;
  }

  onConnect(callback: () => void): () => void {
    this.connectListeners.add(callback);
    return () => { this.connectListeners.delete(callback); };
  }

  onDisconnect(callback: () => void): () => void {
    this.disconnectListeners.add(callback);
    return () => { this.disconnectListeners.delete(callback); };
  }

  on<T = unknown>(event: string, callback: RealtimeListener<T>): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    const wrapped = callback as RealtimeListener<unknown>;
    this.listeners.get(event)!.add(wrapped);
    return () => this.off(event, wrapped);
  }

  off<T = unknown>(event: string, callback: RealtimeListener<T>): void {
    this.listeners.get(event)?.delete(callback as RealtimeListener<unknown>);
  }

  private emit(event: string, data: unknown): void {
    this.listeners.get(event)?.forEach((cb) => {
      try { cb(data); } catch { /* swallow */ }
    });
  }

  send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}

let singletonClient: RealtimeClient | null = null;

export function getRealtimeClientInstance(): RealtimeClient | null {
  if (typeof window === "undefined") return null;
  if (!singletonClient) {
    singletonClient = new RealtimeClient({
      url: window.location.origin,
      reconnect: false,
    });
  }
  return singletonClient;
}

export function createRealtimeClient(options?: RealtimeClientOptions): RealtimeClient {
  return new RealtimeClient(options);
}

export default RealtimeClient;
