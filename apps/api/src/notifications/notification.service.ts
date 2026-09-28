import { Inject, Injectable, Logger, OnApplicationShutdown } from '@nestjs/common';
import { createTransport, type Transporter } from 'nodemailer';
import type { Env } from '../config/env';
import { ENV } from '../config/tokens';
import { DbService } from '../db/db.service';
import { renderEmail, type EmailJob } from './email-templates';

/**
 * Sends queued notification emails (queued by the outbox publisher, see 007_notifications.sql). Each job is claimed
 * with SKIP LOCKED, sent, and marked in the same transaction; a failed send is retried with backoff by the database.
 * Disabled (jobs stay queued) when SMTP_URL is not set.
 */
@Injectable()
export class NotificationService implements OnApplicationShutdown {
  private readonly logger = new Logger(NotificationService.name);
  private transport: Transporter | null = null;

  constructor(@Inject(ENV) private readonly env: Env, private readonly db: DbService) {
    if (env.SMTP_URL) this.transport = createTransport(env.SMTP_URL, { from: env.MAIL_FROM });
  }

  get enabled(): boolean { return this.transport !== null; }

  /** Sends one batch; returns how many jobs were processed (0 ⇒ nothing due). */
  async sendBatch(limit = 20): Promise<number> {
    if (!this.transport) return 0;
    return this.db.withSystem('email', async (c) => {
      const { rows } = await c.query(
        'SELECT id, kind, attempts, customer_code, company_name, recipients, auction_id, auction_number, auction_name, details FROM email_claim($1)',
        [limit]);
      for (const r of rows) {
        const job: EmailJob = {
          id: String(r.id), kind: r.kind, customerCode: r.customer_code, companyName: r.company_name, recipients: r.recipients ?? [],
          auctionId: r.auction_id, auctionNumber: r.auction_number, auctionName: r.auction_name, details: r.details ?? {},
        };
        let outcome = 'sent';
        let error: string | null = null;
        if (job.recipients.length === 0) {
          outcome = 'skipped';
          error = 'no recipients';
        } else {
          try {
            const msg = renderEmail(job, { webUrl: this.env.PUBLIC_WEB_URL, timeZone: this.env.DISPLAY_TIMEZONE });
            await this.transport!.sendMail({ to: job.recipients, subject: msg.subject, text: msg.text, html: msg.html });
          } catch (e) {
            outcome = 'retry';
            error = e instanceof Error ? `${e.name}: ${e.message}` : 'send failed';
            this.logger.warn(`email ${job.id} (${job.kind}) failed, will retry: ${error}`);
          }
        }
        await c.query('SELECT email_mark($1, $2, $3)', [r.id, outcome, error]);
      }
      return rows.length;
    });
  }

  onApplicationShutdown(): void {
    this.transport?.close();
  }
}
