import { isIP } from 'net';

/**
 * The browser's address, for the API's audit log. The load balancer appends the address it received the connection
 * from to X-Forwarded-For, so only the LAST entry is trustworthy (earlier ones are whatever the client sent). Without a
 * proxy, Next sets the header to the socket's peer address.
 */
export function clientAddress(xff: string | null): string | null {
  const last = xff?.split(',').pop()?.trim() ?? '';
  const ip = last.startsWith('::ffff:') && isIP(last.slice(7)) === 4 ? last.slice(7) : last;
  return isIP(ip) ? ip : null;
}
