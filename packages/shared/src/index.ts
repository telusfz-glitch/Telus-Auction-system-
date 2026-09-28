import { z } from 'zod';

export const STAFF_ROLES = ['super_admin', 'auction_manager', 'sales_manager', 'finance', 'view_only'] as const;
export const CUSTOMER_ROLES = ['customer_admin', 'customer_bidder', 'customer_viewer'] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];
export type CustomerRole = (typeof CUSTOMER_ROLES)[number];

/** .strict() everywhere: unknown keys are rejected, which blocks mass-assignment
 *  (e.g. a client smuggling `status: "active"` or `customerId` into a request body). */
export const CreateCustomerSchema = z
  .object({
    companyName: z.string().trim().min(2).max(200),
    contactEmail: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();
export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

export const PlaceBidSchema = z
  .object({
    lotId: z.string().uuid(),
    amount: z.number().positive().max(1_000_000_000).multipleOf(0.01),
    idempotencyKey: z.string().min(16).max(128),
  })
  .strict();
export type PlaceBidInput = z.infer<typeof PlaceBidSchema>;

/** Socket.IO `auction.subscribe` / `auction.unsubscribe` payload. */
export const AuctionSubscriptionSchema = z.object({ auctionId: z.string().uuid() }).strict();
export type AuctionSubscription = z.infer<typeof AuctionSubscriptionSchema>;

// ---------------- staff admin ----------------
/** Money arrives as a JSON number with at most 2 decimals and is converted to an exact decimal string server-side. */
const Money = z.number().positive().max(1_000_000_000).multipleOf(0.01);
const MoneyOrZero = z.number().min(0).max(10_000_000_000).multipleOf(0.01);
const Code = (max: number) => z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'letters, digits and dashes only').max(max);
const IsoTime = z.string().datetime({ offset: true });
export const BID_VISIBILITIES = ['full_price', 'winning_losing_only', 'rank_no_identity', 'own_bid_only'] as const;
export const CUSTOMER_STATUSES = ['pending', 'active', 'suspended', 'blocked', 'expired'] as const;

const AuctionFields = z.object({
  number: Code(40),
  name: z.string().trim().min(2).max(200),
  startAt: IsoTime,
  closeAt: IsoTime,
  bidVisibility: z.enum(BID_VISIBILITIES),
  extensionEnabled: z.boolean(),
  extensionWindowSeconds: z.number().int().min(10).max(3600),
  extensionSeconds: z.number().int().min(10).max(3600),
});
const closeAfterStart = (v: { startAt?: string; closeAt?: string }) => !v.startAt || !v.closeAt || Date.parse(v.closeAt) > Date.parse(v.startAt);

export const CreateAuctionSchema = AuctionFields
  .extend({
    bidVisibility: AuctionFields.shape.bidVisibility.default('winning_losing_only'),
    extensionEnabled: AuctionFields.shape.extensionEnabled.default(true),
    extensionWindowSeconds: AuctionFields.shape.extensionWindowSeconds.default(120),
    extensionSeconds: AuctionFields.shape.extensionSeconds.default(120),
  })
  .strict()
  .refine(closeAfterStart, { message: 'closeAt must be after startAt', path: ['closeAt'] });
export type CreateAuctionInput = z.infer<typeof CreateAuctionSchema>;

export const UpdateAuctionSchema = AuctionFields.partial().strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' })
  .refine(closeAfterStart, { message: 'closeAt must be after startAt', path: ['closeAt'] });
export type UpdateAuctionInput = z.infer<typeof UpdateAuctionSchema>;

const LotFields = z.object({
  lotNumber: Code(20),
  description: z.string().trim().min(1).max(500),
  quantity: z.number().int().min(1).max(1_000_000),
  startingPrice: Money,
  fallbackIncrement: Money,
});
export const CreateLotsSchema = z.object({
  lots: z.array(LotFields.extend({ fallbackIncrement: Money.default(25) }).strict()).min(1).max(1000)
    .refine((ls) => new Set(ls.map((l) => l.lotNumber.toLowerCase())).size === ls.length, { message: 'duplicate lotNumber' }),
}).strict();
export type CreateLotsInput = z.infer<typeof CreateLotsSchema>;

export const UpdateLotSchema = LotFields.omit({ lotNumber: true }).partial().strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type UpdateLotInput = z.infer<typeof UpdateLotSchema>;

export const InviteCustomersSchema = z.object({ customerIds: z.array(z.string().uuid()).min(1).max(500) }).strict();
export type InviteCustomersInput = z.infer<typeof InviteCustomersSchema>;

export const UpdateCustomerSchema = z.object({
  status: z.enum(CUSTOMER_STATUSES),
  marginRuleSetId: z.string().uuid().nullable(),
}).partial().strict().refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;

export const SetCustomerLimitSchema = z.object({ maxPurchaseValue: MoneyOrZero }).strict();
export type SetCustomerLimitInput = z.infer<typeof SetCustomerLimitSchema>;

const Bracket = z.object({ priceFrom: MoneyOrZero, priceTo: Money, margin: Money }).strict()
  .refine((b) => b.priceTo > b.priceFrom, { message: 'priceTo must be greater than priceFrom' });
export const BracketsSchema = z.object({ brackets: z.array(Bracket).min(1).max(50) }).strict();
export type BracketsInput = z.infer<typeof BracketsSchema>;
export const CreateMarginRuleSetSchema = z.object({ name: z.string().trim().min(2).max(100), brackets: BracketsSchema.shape.brackets }).strict();
export type CreateMarginRuleSetInput = z.infer<typeof CreateMarginRuleSetSchema>;

export const UpdateSecuritySettingsSchema = z.object({
  maxBidLimit: Money,
  rangeEnabled: z.boolean(),
  rangeMin: MoneyOrZero,
  rangeMax: Money,
}).partial().strict().refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type UpdateSecuritySettingsInput = z.infer<typeof UpdateSecuritySettingsSchema>;

// ---------------- customer team logins ----------------
const PersonName = z.string().trim().min(1).max(100).regex(/^[^<>"\n\r]+$/, 'no special characters');
export const CreateTeamUserSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  firstName: PersonName,
  lastName: PersonName,
  role: z.enum(CUSTOMER_ROLES),
}).strict();
export type CreateTeamUserInput = z.infer<typeof CreateTeamUserSchema>;

export const UpdateTeamUserSchema = z.object({
  role: z.enum(CUSTOMER_ROLES),
  status: z.enum(['active', 'suspended']),
}).partial().strict().refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });
export type UpdateTeamUserInput = z.infer<typeof UpdateTeamUserSchema>;

// ---------------- invoices ----------------
export const SettleInvoiceSchema = z.object({
  status: z.enum(['paid', 'void']),
  note: z.string().trim().max(500).optional(),
}).strict();
export type SettleInvoiceInput = z.infer<typeof SettleInvoiceSchema>;
