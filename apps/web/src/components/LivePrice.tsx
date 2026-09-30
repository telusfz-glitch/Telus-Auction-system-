'use client';

import { useEffect, useState } from 'react';
import { aed } from '@/lib/format';
import { LOT_PRICE_EVENT, higherPrice } from '@/lib/live-price';

/**
 * The current bid of one lot in a full-price auction. Shows a pushed price the moment it arrives (LiveUpdates
 * re-broadcasts it as a browser event) instead of waiting for the next page refresh; the refresh then brings the
 * server's figures (and the minimum next bid, which only the server computes). Never shows a lower price than it has seen.
 */
export function LivePrice({ lotId, serverValue }: { lotId: string; serverValue: string | null | undefined }) {
  const [pushed, setPushed] = useState<string | null>(null);
  useEffect(() => {
    const onPrice = (e: Event) => {
      const d = (e as CustomEvent<{ lotId?: unknown; highestBid?: unknown }>).detail;
      if (d?.lotId === lotId && typeof d.highestBid === 'string') setPushed((prev) => higherPrice(prev, d.highestBid as string));
    };
    window.addEventListener(LOT_PRICE_EVENT, onPrice);
    return () => window.removeEventListener(LOT_PRICE_EVENT, onPrice);
  }, [lotId]);
  return <span data-testid="current-bid">{aed(higherPrice(serverValue, pushed))}</span>;
}
