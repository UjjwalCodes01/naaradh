import { PubSub } from '@google-cloud/pubsub';

/**
 * Outbound side of the hooks service. Messages are PII-free by construction: they carry the
 * `webhook_events.id` and routing attributes; consumers load the payload from Postgres with
 * the service role. Pub/Sub therefore never holds a phone number or an order.
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

export interface Publisher {
  publish(topic: TopicName, message: EventMessage): Promise<string>;
}

export function topicId(prefix: string, topic: TopicName): string {
  return `${prefix}.${topic}`;
}

export function createPubSubPublisher(
  projectId: string,
  prefix: string,
): Publisher & { ensureTopics(): Promise<void>; close(): Promise<void> } {
  const client = new PubSub({ projectId });
  const topics: TopicName[] = [
    'shopify.events',
    'engine.events',
    'provider.events',
    'billing.events',
  ];
  return {
    async publish(topic, message) {
      const t = client.topic(topicId(prefix, topic), { batching: { maxMessages: 1 } });
      const messageId: string = await t.publishMessage({
        json: message,
        attributes: {
          source: message.source,
          topic: message.topic,
          tenant_id: message.tenant_id ?? '',
        },
        ...(message.tenant_id === null ? {} : { orderingKey: message.tenant_id }),
      });
      return messageId;
    },
    /** Dev/emulator only — production topics come from Terraform. */
    async ensureTopics() {
      for (const t of topics) {
        const [exists] = await client.topic(topicId(prefix, t)).exists();
        if (!exists) await client.createTopic(topicId(prefix, t));
      }
    },
    close: () => client.close(),
  };
}

/** For tests and for `pnpm dev` without Pub/Sub. */
export function memoryPublisher(): Publisher & {
  messages: { topic: TopicName; message: EventMessage }[];
  failNext: number;
} {
  const store = {
    messages: [] as { topic: TopicName; message: EventMessage }[],
    failNext: 0,
    async publish(topic: TopicName, message: EventMessage): Promise<string> {
      if (store.failNext > 0) {
        store.failNext -= 1;
        throw new Error('simulated publish failure');
      }
      store.messages.push({ topic, message });
      return `mem-${String(store.messages.length)}`;
    },
  };
  return store;
}
