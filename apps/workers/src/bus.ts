import { PubSub, type Message } from '@google-cloud/pubsub';
import type { Logger } from '@naaradh/shared';

/**
 * Inbound side of Pub/Sub for the consumers, plus an in-memory bus for tests and for
 * `pnpm dev` without the emulator. Handlers are at-least-once: they must be idempotent
 * (they are — every write keys on the webhook_events / intent / attempt id).
 */
export type TopicName = 'shopify.events' | 'engine.events' | 'provider.events' | 'billing.events';

export interface EventMessage {
  readonly webhook_event_id: string;
  readonly source: string;
  readonly topic: string;
  readonly tenant_id: string | null;
  readonly external_account: string | null;
  readonly received_at: string;
}

export type Handler = (message: EventMessage) => Promise<void>;

export interface Bus {
  subscribe(topic: TopicName, worker: string, handler: Handler): Promise<() => Promise<void>>;
}

export function subscriptionId(prefix: string, topic: TopicName, worker: string): string {
  return `${prefix}.${topic}.${worker}`;
}

export function createPubSubBus(
  projectId: string,
  prefix: string,
  log: Logger,
  ensure: boolean,
): Bus & { close(): Promise<void> } {
  const client = new PubSub({ projectId });
  return {
    async subscribe(topic, worker, handler) {
      const topicName = `${prefix}.${topic}`;
      const subName = subscriptionId(prefix, topic, worker);
      if (ensure) {
        const t = client.topic(topicName);
        const [topicExists] = await t.exists();
        if (!topicExists) await client.createTopic(topicName);
        const s = t.subscription(subName);
        const [subExists] = await s.exists();
        if (!subExists)
          await t.createSubscription(subName, {
            ackDeadlineSeconds: 60,
            enableMessageOrdering: true,
          });
      }
      const subscription = client.subscription(subName, { flowControl: { maxMessages: 10 } });
      subscription.on('message', (m: Message) => {
        void (async () => {
          try {
            const parsed = JSON.parse(m.data.toString('utf8')) as EventMessage;
            await handler(parsed);
            m.ack();
          } catch (error) {
            log.error({ err: error, message_id: m.id, topic }, 'handler failed; nack');
            m.nack();
          }
        })();
      });
      subscription.on('error', (error) => {
        log.error({ err: error, subscription: subName }, 'subscription error');
      });
      return async () => {
        await subscription.close();
      };
    },
    close: () => client.close(),
  };
}

/** Synchronous in-process bus: publish() awaits every handler. Tests drive the pipeline with it. */
export function memoryBus(): Bus & {
  publish(topic: TopicName, message: EventMessage): Promise<void>;
  handlers: Map<string, Handler[]>;
} {
  const handlers = new Map<string, Handler[]>();
  return {
    handlers,
    async subscribe(topic, _worker, handler) {
      const list = handlers.get(topic) ?? [];
      list.push(handler);
      handlers.set(topic, list);
      return async () => {
        handlers.set(
          topic,
          (handlers.get(topic) ?? []).filter((h) => h !== handler),
        );
      };
    },
    async publish(topic, message) {
      for (const h of handlers.get(topic) ?? []) await h(message);
    },
  };
}
