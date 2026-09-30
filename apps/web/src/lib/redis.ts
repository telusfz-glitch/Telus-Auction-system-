import 'server-only';
import { createClient } from 'redis';
import { env } from './env';

type Client = ReturnType<typeof createClient>;
const g = globalThis as unknown as { __telusRedis?: Promise<Client> };

/** One shared connection per server process (survives Next dev hot reloads). */
export function redis(): Promise<Client> {
  if (!g.__telusRedis) {
    const client = createClient({ url: env().REDIS_URL });
    // Never log the URL: it carries the Redis password.
    client.on('error', (e: Error) => console.error(`[redis] ${e.name}: ${e.message.replace(/\/\/[^@]*@/, '//***@')}`));
    g.__telusRedis = client.connect().then(() => client).catch((e) => { g.__telusRedis = undefined; throw e; });
  }
  return g.__telusRedis;
}
