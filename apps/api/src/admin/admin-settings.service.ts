import { Injectable } from '@nestjs/common';
import type {
  BracketsInput, CreateMarginRuleSetInput, SetCustomerLimitInput, UpdateCustomerInput, UpdateSecuritySettingsInput,
} from '@telus/shared';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import type { Principal } from '../auth/principal';
import { ApiError } from '../common/api-error';
import { mapPgError } from '../common/pg-errors';
import { DbService } from '../db/db.service';

const money = (n: number) => n.toFixed(2);
const SEC_COLS = 'max_bid_limit, range_enabled, range_min, range_max, updated_at';

/** Staff management of customers' commercial settings, margin rule sets and platform security settings. Audited. */
@Injectable()
export class AdminSettingsService {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  private run<T>(p: Principal, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    return this.db.withPrincipal(p, fn).catch((e) => { throw mapPgError(e); });
  }

  // ---------------- customers ----------------

  updateCustomer(p: Principal, id: string, input: UpdateCustomerInput, ip?: string) {
    return this.run(p, async (c) => {
      const before = (await c.query('SELECT id, status, margin_rule_set_id FROM customers WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!before) throw new ApiError('CUSTOMER_NOT_FOUND', 'Customer not found.', 404);
      const after = (await c.query(
        `UPDATE customers SET status = coalesce($2, status),
                margin_rule_set_id = CASE WHEN $3::boolean THEN $4::uuid ELSE margin_rule_set_id END
          WHERE id = $1 RETURNING id, code, company_name, status, margin_rule_set_id`,
        [id, input.status ?? null, 'marginRuleSetId' in input, input.marginRuleSetId ?? null])).rows[0];
      await this.audit.record(c, { actor: p, action: 'customer.update', referenceType: 'customer', referenceId: id,
        before: { status: before.status, marginRuleSetId: before.margin_rule_set_id }, after: input, ip });
      return after;
    });
  }

  /** Purchasing capacity. 0 means the customer cannot bid at all. */
  setLimit(p: Principal, id: string, input: SetCustomerLimitInput, ip?: string) {
    return this.run(p, async (c) => {
      const exists = (await c.query('SELECT 1 FROM customers WHERE id = $1', [id])).rowCount;
      if (!exists) throw new ApiError('CUSTOMER_NOT_FOUND', 'Customer not found.', 404);
      const before = (await c.query('SELECT max_purchase_value::text AS v FROM customer_limits WHERE customer_id = $1', [id])).rows[0];
      const row = (await c.query(
        `INSERT INTO customer_limits (customer_id, max_purchase_value) VALUES ($1, $2)
         ON CONFLICT (customer_id) DO UPDATE SET max_purchase_value = EXCLUDED.max_purchase_value
         RETURNING customer_id, max_purchase_value`, [id, money(input.maxPurchaseValue)])).rows[0];
      await this.audit.record(c, { actor: p, action: 'customer.limit', referenceType: 'customer', referenceId: id,
        before: { maxPurchaseValue: before?.v ?? null }, after: { maxPurchaseValue: row.max_purchase_value }, ip });
      return row;
    });
  }

  // ---------------- margin rule sets ----------------

  listRuleSets(p: Principal) {
    return this.run(p, async (c) => (await c.query(
      `SELECT s.id, s.name, s.created_at,
              coalesce(json_agg(json_build_object('priceFrom', b.price_from::text, 'priceTo', b.price_to::text, 'margin', b.margin::text)
                       ORDER BY b.price_from) FILTER (WHERE b.id IS NOT NULL), '[]') AS brackets,
              (SELECT count(*)::int FROM customers cu WHERE cu.margin_rule_set_id = s.id) AS customer_count
         FROM margin_rule_sets s LEFT JOIN margin_rule_brackets b ON b.rule_set_id = s.id
        GROUP BY s.id ORDER BY s.name`)).rows);
  }

  createRuleSet(p: Principal, input: CreateMarginRuleSetInput, ip?: string) {
    return this.run(p, async (c) => {
      const set = (await c.query('INSERT INTO margin_rule_sets (name) VALUES ($1) RETURNING id, name', [input.name])).rows[0];
      await this.insertBrackets(c, set.id, input.brackets);
      await this.audit.record(c, { actor: p, action: 'margin_rules.create', referenceType: 'margin_rule_set', referenceId: set.id, after: input, ip });
      return { ...set, brackets: input.brackets };
    });
  }

  /** Replaces every bracket atomically. The database rejects overlapping brackets (exclusion constraint). Takes effect
   *  for the next bid of every customer on this set, including in live auctions. */
  replaceBrackets(p: Principal, id: string, input: BracketsInput, ip?: string) {
    return this.run(p, async (c) => {
      const set = (await c.query('SELECT id, name FROM margin_rule_sets WHERE id = $1 FOR UPDATE', [id])).rows[0];
      if (!set) throw new ApiError('RULE_SET_NOT_FOUND', 'Margin rule set not found.', 404);
      const before = (await c.query('SELECT price_from::text, price_to::text, margin::text FROM margin_rule_brackets WHERE rule_set_id = $1 ORDER BY price_from', [id])).rows;
      await c.query('DELETE FROM margin_rule_brackets WHERE rule_set_id = $1', [id]);
      await this.insertBrackets(c, id, input.brackets);
      await this.audit.record(c, { actor: p, action: 'margin_rules.replace', referenceType: 'margin_rule_set', referenceId: id, before, after: input, ip });
      return { ...set, brackets: input.brackets };
    });
  }

  private async insertBrackets(c: PoolClient, setId: string, brackets: BracketsInput['brackets']) {
    await c.query(
      `INSERT INTO margin_rule_brackets (rule_set_id, price_from, price_to, margin)
       SELECT $1, * FROM unnest($2::numeric[], $3::numeric[], $4::numeric[])`,
      [setId, brackets.map((b) => money(b.priceFrom)), brackets.map((b) => money(b.priceTo)), brackets.map((b) => money(b.margin))]);
  }

  // ---------------- platform security settings ----------------

  getSecurity(p: Principal) {
    return this.run(p, async (c) => (await c.query(`SELECT ${SEC_COLS} FROM security_settings`)).rows[0]);
  }

  updateSecurity(p: Principal, input: UpdateSecuritySettingsInput, ip?: string) {
    return this.run(p, async (c) => {
      const before = (await c.query(`SELECT ${SEC_COLS} FROM security_settings FOR UPDATE`)).rows[0];
      const after = (await c.query(
        `UPDATE security_settings SET max_bid_limit = coalesce($1, max_bid_limit), range_enabled = coalesce($2, range_enabled),
                range_min = coalesce($3, range_min), range_max = coalesce($4, range_max), updated_at = now()
         RETURNING ${SEC_COLS}`,
        [input.maxBidLimit === undefined ? null : money(input.maxBidLimit), input.rangeEnabled ?? null,
          input.rangeMin === undefined ? null : money(input.rangeMin), input.rangeMax === undefined ? null : money(input.rangeMax)])).rows[0];
      await this.audit.record(c, { actor: p, action: 'security_settings.update', referenceType: 'security_settings', referenceId: 'singleton', before, after, ip });
      return after;
    });
  }
}
