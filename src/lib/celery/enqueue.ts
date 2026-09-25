import type Redis from 'ioredis'

/** Celery's default queue — the worker consumes from this Redis list. */
const CELERY_QUEUE = 'celery'

export type CeleryMessage = {
  id: string
  payload: string
}

/**
 * Builds a Celery task-protocol-v2 message in the envelope kombu's Redis transport expects.
 *
 * Input: registered task name (e.g. 'tasks.welcome_briefing'), positional args, optional priority.
 * Output: { id, payload } — payload is the JSON string to LPUSH onto the 'celery' list.
 *
 * The body MUST be base64 with body_encoding 'base64': kombu skips decoding when
 * body_encoding is 'utf-8', so the worker would try to JSON-parse base64 text and
 * drop the message with "Can't decode message body". delivery_info is required by
 * the Redis transport's ack emulation.
 */
export function buildCeleryMessage(
  task: string,
  args: unknown[],
  options: { priority?: number } = {},
): CeleryMessage {
  const id = crypto.randomUUID()
  // Protocol v2 body: [args, kwargs, embed]
  const body = [args, {}, { callbacks: null, errbacks: null, chain: null, chord: null }]

  const payload = JSON.stringify({
    'content-type': 'application/json',
    'content-encoding': 'utf-8',
    headers: {
      id,
      task,
      lang: 'py',
      root_id: id,
      parent_id: null,
      group: null,
    },
    properties: {
      correlation_id: id,
      reply_to: '',
      delivery_mode: 2,
      delivery_tag: id,
      delivery_info: { exchange: '', routing_key: CELERY_QUEUE },
      body_encoding: 'base64',
      priority: options.priority ?? 0,
    },
    body: Buffer.from(JSON.stringify(body)).toString('base64'),
  })

  return { id, payload }
}

/**
 * Enqueues a Celery task onto the worker's Redis queue.
 *
 * Input: a connected ioredis client (caller owns its lifecycle), task name, positional args.
 * Output: the task id. Throws if the LPUSH fails.
 */
export async function enqueueCeleryTask(
  redis: Redis,
  task: string,
  args: unknown[],
  options: { priority?: number } = {},
): Promise<string> {
  const { id, payload } = buildCeleryMessage(task, args, options)
  await redis.lpush(CELERY_QUEUE, payload)
  return id
}
