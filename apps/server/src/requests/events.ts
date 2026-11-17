import { EventEmitter } from 'node:events';
import type { AccessRequestDto, AutoModeDto } from '@asm/shared';

export type RequestEvent =
  | { type: 'request.created' | 'request.updated'; data: AccessRequestDto }
  | { type: 'automode.changed'; data: AutoModeDto }
  /** A device's state (status, standing approval) changed; clients refetch the device list. */
  | { type: 'device.changed'; data: { deviceId: string } };

export type RequestEventListener = (event: RequestEvent) => void;

/** In-process, per-user event bus (SSE streams, waitForRequest). Payloads never contain secret values. */
export class RequestEvents {
  private readonly emitter = new EventEmitter();

  constructor() {
    // One listener per open SSE stream / long-poll; bounded elsewhere (SSE: 10 per user).
    this.emitter.setMaxListeners(0);
  }

  emit(userId: string, event: RequestEvent): void {
    for (const fn of this.emitter.listeners(userId) as RequestEventListener[]) {
      try {
        fn(event);
      } catch {
        // A failing subscriber must not break the emitter or other subscribers.
      }
    }
  }

  subscribe(userId: string, fn: RequestEventListener): () => void {
    this.emitter.on(userId, fn);
    return () => {
      this.emitter.off(userId, fn);
    };
  }
}
