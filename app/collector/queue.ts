import { CollectorEvent } from './contracts';
import { NormalizedCollectorEvent } from './normalizer';

export const COLLECTOR_QUEUE_MAX_EVENTS = 10000;
export const COLLECTOR_BATCH_MAX_EVENTS = 100;

export class CollectorEventQueue {
  private events: CollectorEvent[] = [];
  private nextEventSequence = 0;
  private dropped = 0;

  constructor(private readonly capacity = COLLECTOR_QUEUE_MAX_EVENTS) {}

  enqueue(event: NormalizedCollectorEvent): CollectorEvent {
    const sequenced = { ...event, eventSequence: this.nextEventSequence++ };
    this.events.push(sequenced);
    this.trimToCapacity();
    return sequenced;
  }

  take(max = COLLECTOR_BATCH_MAX_EVENTS): CollectorEvent[] {
    return this.events.splice(0, Math.max(0, max));
  }

  restoreToFront(events: CollectorEvent[]): void {
    if (events.length === 0) return;
    this.events = [...events, ...this.events];
    this.trimToCapacity();
  }

  get pendingDepth(): number {
    return this.events.length;
  }

  get droppedByCap(): number {
    return this.dropped;
  }

  get lastEventSequence(): number {
    return this.nextEventSequence - 1;
  }

  private trimToCapacity(): void {
    const overflow = this.events.length - this.capacity;
    if (overflow <= 0) return;
    this.events.splice(0, overflow);
    this.dropped += overflow;
  }
}
