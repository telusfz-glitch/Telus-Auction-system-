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
