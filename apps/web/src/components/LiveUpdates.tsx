'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { socketTicketAction } from '@/app/actions/customer';
import { createRefreshScheduler } from '@/lib/refresh-scheduler';

const MESSAGES: Record<string, (d: Record<string, unknown>, lots: Record<string, string>) => string | null> = {
  'lot.outbid': (d, lots) => `You were outbid on lot ${lots[String(d['lotId'])] ?? ''}.`,
  'lot.leading': (d, lots) => `You are leading on lot ${lots[String(d['lotId'])] ?? ''}.`,
  'auction.extended': () => 'A late bid extended the auction.',
  'auction.opened': () => 'The auction is now open.',
  'auction.closed': () => 'The auction has closed.',
  'auction.cancelled': () => 'The auction was cancelled.',
};

/**
 * Keeps an auction page live. Connects with a one-time ticket fetched through a server action (the browser never
 * sees an access token), subscribes to the auction, and on any relevant event re-renders the page from the server —
 * so the numbers shown always come from the API, never from the push message itself.
 */
export function LiveUpdates({ auctionId, lotNumbers }: { auctionId: string; lotNumbers: Record<string, string> }) {
  const router = useRouter();
  const [state, setState] = useState<'connecting' | 'live' | 'offline'>('connecting');
  const [notice, setNotice] = useState<string | null>(null);
  const lots = useRef(lotNumbers);
  lots.current = lotNumbers;

  useEffect(() => {
    let socket: Socket | null = null;
    let cancelled = false;
    // Price broadcasts reach every spectator: rate-limited per browser. Own-position and auction events stay prompt.
    const refresh = createRefreshScheduler(() => router.refresh());

    (async () => {
      const first = await socketTicketAction();
      if (!first || cancelled) { setState('offline'); return; }
      let pending: string | null = first.ticket;
      socket = io(first.url, {
        path: '/realtime',
        transports: ['websocket'],
        // Called on every (re)connect: the first ticket is used once, later attempts fetch a fresh one.
        auth: (cb) => {
          if (pending) { const t = pending; pending = null; cb({ ticket: t }); return; }
          socketTicketAction().then((r) => cb({ ticket: r?.ticket ?? '' }));
        },
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10_000,
      });
      socket.on('connect', () => {
        setState('live');
        socket!.emit('auction.subscribe', { auctionId }, () => undefined);
        refresh.urgent();   // catch up on anything missed while disconnected
      });
      socket.on('disconnect', (reason) => {
        setState('offline');
        if (reason === 'io server disconnect') socket!.connect();   // token expired server-side: reconnect with a new ticket
      });
      socket.on('connect_error', () => setState('offline'));
      socket.onAny((event: string, data: Record<string, unknown>) => {
        if (data?.['auctionId'] !== auctionId) return;
        const msg = MESSAGES[event]?.(data, lots.current);
        if (msg) setNotice(msg);
        if (event === 'lot.price') refresh.broadcast(); else refresh.urgent();
      });
    })();

    return () => { cancelled = true; refresh.cancel(); socket?.close(); };
  }, [auctionId, router]);

  return (
    <div className="live" aria-live="polite">
      <span className={`dot ${state}`} data-testid="live-state" data-state={state} />
      {state === 'live' ? 'Live updates on' : state === 'connecting' ? 'Connecting…' : 'Live updates offline — refresh to see changes'}
      {notice && <span className="notice" data-testid="live-notice">{notice}</span>}
    </div>
  );
}
