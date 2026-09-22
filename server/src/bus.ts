export interface GatewayEvent {
  type: string;
  [key: string]: unknown;
}

type Handler = (event: GatewayEvent) => void;

class Bus {
  private handlers = new Set<Handler>();

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(event: GatewayEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        console.error('[bus] handler error:', err);
      }
    }
  }
}

export const bus = new Bus();
