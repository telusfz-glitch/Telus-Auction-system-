import { Body, Controller, Get, Ip, Post } from '@nestjs/common';
import { AUCTION_MANAGERS, CUSTOMER_ROLES, CreateCustomerSchema, STAFF_ROLES, type CreateCustomerInput } from '@telus/shared';
import { AuditService } from '../audit/audit.service';
import { CurrentPrincipal, Roles } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { ZodValidationPipe } from '../common/zod.pipe';
import { DbService } from '../db/db.service';

@Controller()
export class CustomersController {
  constructor(private readonly db: DbService, private readonly audit: AuditService) {}

  // Two independent layers: the explicit WHERE (app logic) AND row-level security (database).
  @Get('customers/me')
  @Roles(...CUSTOMER_ROLES)
  me(@CurrentPrincipal() p: Principal) {
    return this.db.withPrincipal(p, async (c) => {
      const { rows } = await c.query('SELECT id, code, company_name, status FROM customers WHERE id = $1', [p.customerId]);
      return rows[0] ?? null;
    });
  }

  @Get('admin/customers')
  @Roles(...STAFF_ROLES)
  list(@CurrentPrincipal() p: Principal) {
    return this.db.withPrincipal(p, async (c) => {
      const { rows } = await c.query('SELECT id, code, company_name, contact_email, status, created_at FROM customers ORDER BY created_at DESC LIMIT 500');
      return rows;
    });
  }

  @Post('admin/customers')
  @Roles(...AUCTION_MANAGERS)
  create(@CurrentPrincipal() p: Principal, @Body(new ZodValidationPipe(CreateCustomerSchema)) body: CreateCustomerInput, @Ip() ip: string) {
    return this.db.withPrincipal(p, async (c) => {
      const { rows } = await c.query(
        'INSERT INTO customers (company_name, contact_email) VALUES ($1,$2) RETURNING id, code, company_name, contact_email, status',
        [body.companyName, body.contactEmail],
      );
      const row = rows[0];
      await this.audit.record(c, { actor: p, action: 'customer.create', referenceType: 'customer', referenceId: row.id, after: body, ip });
      return row;
    });
  }
}
