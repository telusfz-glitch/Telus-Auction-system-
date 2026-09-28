/** Shapes returned by the API (snake_case where the API returns raw rows). Money is always a decimal string. */
export type AuctionStatus = 'draft' | 'scheduled' | 'live' | 'closing' | 'closed' | 'under_review' | 'finalized' | 'archived' | 'cancelled';
export type Visibility = 'full_price' | 'winning_losing_only' | 'rank_no_identity' | 'own_bid_only';

export interface CustomerAuction {
  id: string; number: string; name: string; status: AuctionStatus; start_at: string; close_at: string;
  bid_visibility: Visibility; terms_accepted_at: string | null;
}
export interface CustomerLot { id: string; lot_number: string; description: string; quantity: number; starting_price: string; status: 'active' | 'withdrawn' }
export interface Position {
  lotId: string; lotStatus: string; status: 'no_bid' | 'leading' | 'outbid';
  myHighestBid: string | null; currentHighestBid: string | null; minNextBid: string | null;
}
export interface MyResults { auctionId: string; status: AuctionStatus; lotsWon: Array<{ lot_id: string; lot_number: string; description: string; quantity: number; unit_price: string; total: string }> }

export interface AdminAuctionRow {
  id: string; number: string; name: string; status: AuctionStatus; start_at: string; close_at: string; bid_visibility: Visibility;
  lot_count: number; participant_count: number;
}
export interface AdminAuction {
  id: string; number: string; name: string; status: AuctionStatus; start_at: string; close_at: string; bid_visibility: Visibility;
  extension_enabled: boolean; extension_window_seconds: number; extension_seconds: number;
  lots: Array<{ id: string; lot_number: string; description: string; quantity: number; starting_price: string; fallback_increment: string;
    status: 'active' | 'withdrawn'; highest_amount: string | null; bid_count: number | null; leader_code: string | null }>;
  participants: Array<{ customer_id: string; code: string; company_name: string; customer_status: string; is_allowed: boolean; terms_accepted_at: string | null }>;
}
export interface AdminResults {
  status: AuctionStatus;
  lots: Array<{ lot_id: string; lot_number: string; description: string; outcome: 'won' | 'unsold' | 'withdrawn'; quantity: number;
    unit_price: string | null; total: string | null; winner_code: string | null; winner_name: string | null }>;
}
export interface AdminCustomer { id: string; code: string; company_name: string; contact_email: string; status: string; created_at: string }
export interface RuleSet { id: string; name: string; brackets: Array<{ priceFrom: string; priceTo: string; margin: string }>; customer_count: number }
export interface SecuritySettings { max_bid_limit: string; range_enabled: boolean; range_min: string; range_max: string; updated_at: string }
