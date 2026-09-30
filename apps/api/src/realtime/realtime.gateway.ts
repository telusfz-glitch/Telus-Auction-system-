import { Logger } from '@nestjs/common';
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage,
  WebSocketGateway, WebSocketServer,
} from '@nestjs/websockets';
import { AuctionSubscriptionSchema } from '@telus/shared';
import { decodeJwt } from 'jose';
import type { Server, Socket } from 'socket.io';
import { Authenticated } from '../auth/decorators';
import type { Principal } from '../auth/principal';
import { TokenVerifier } from '../auth/token-verifier';
import { DbService } from '../db/db.service';
import { rooms, type Delivery } from './routing';
import { TicketService } from './ticket.service';

const MAX_TOKEN_LENGTH = 8192;
const MAX_AUCTION_SUBSCRIPTIONS = 20;

interface SocketData { principal?: Principal; exp?: number; expiryTimer?: NodeJS.Timeout }
type Client = Socket<Record<string, never>, Record<string, never>, Record<string, never>, SocketData>;
export type Ack = { ok: true } | { ok: false; code: string };

/**
 * Realtime push over Socket.IO at path /realtime. The handshake carries either a one-time ticket (`auth: { ticket }`,
 * what browsers use, see ticket.service.ts) or a Keycloak access token (`auth: { token }`, checked by the same verifier
 * as the HTTP API). The socket is disconnected when the underlying token expires (the client reconnects). Customers join their own `customer:<id>` room; they join an
 * `auction:<id>` room only if RLS lets them see that auction. What each room hears is decided by ./routing.ts.
 */
@WebSocketGateway({ path: '/realtime', serveClient: false })
export class RealtimeGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(RealtimeGateway.name);
  @WebSocketServer() server!: Server;

  constructor(private readonly verifier: TokenVerifier, private readonly tickets: TicketService, private readonly db: DbService) {}

  afterInit(server: Server): void {
    server.use((socket: Client, next) => {
      const auth = socket.handshake.auth ?? {};
      const ticket: unknown = auth['ticket'];
      const token: unknown = auth['token'];
      const ok = (principal: Principal, exp: number | undefined) => {
        socket.data.principal = principal;
        socket.data.exp = exp;
        next();
      };
      const fail = () => next(new Error('unauthorized'));   // one message for every failure: no oracle for probing
      // Browsers present a one-time ticket (the web app keeps tokens server-side); API clients may present a token.
      if (typeof ticket === 'string' && ticket.length > 0 && ticket.length <= MAX_TOKEN_LENGTH && this.tickets.enabled) {
        this.tickets.redeem(ticket).then((t) => ok(t.principal, t.tokenExp), fail);
      } else if (typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LENGTH) {
        this.verifier.verify(token).then((p) => ok(p, decodeJwt(token).exp), fail);
      } else {
        fail();
      }
    });
  }

  handleConnection(socket: Client): void {
    const p = socket.data.principal;
    if (!p || !socket.data.exp) return void socket.disconnect(true);
    void socket.join(p.kind === 'staff' ? rooms.staff : rooms.customer(p.customerId!));
    const msLeft = socket.data.exp * 1000 - Date.now();
    socket.data.expiryTimer = setTimeout(() => socket.disconnect(true), Math.max(0, msLeft));
  }

  handleDisconnect(socket: Client): void {
    clearTimeout(socket.data.expiryTimer);
  }

  @Authenticated()
  @SubscribeMessage('auction.subscribe')
  async subscribe(@ConnectedSocket() socket: Client, @MessageBody() body: unknown): Promise<Ack> {
    const parsed = AuctionSubscriptionSchema.safeParse(body);
    if (!parsed.success) return { ok: false, code: 'BAD_REQUEST' };
    const room = rooms.auction(parsed.data.auctionId);
    if (socket.rooms.has(room)) return { ok: true };
    const joined = [...socket.rooms].filter((r) => r.startsWith('auction:')).length;
    if (joined >= MAX_AUCTION_SUBSCRIPTIONS) return { ok: false, code: 'TOO_MANY_SUBSCRIPTIONS' };
    try {
      // RLS decides: staff see every auction; a customer only non-draft auctions they are invited to.
      const visible = await this.db.withPrincipal(socket.data.principal!, async (c) =>
        (await c.query('SELECT 1 FROM auctions WHERE id = $1', [parsed.data.auctionId])).rowCount === 1);
      if (!visible) return { ok: false, code: 'NOT_FOUND' };
    } catch (e) {
      this.logger.error('auction.subscribe failed', e instanceof Error ? e.stack : String(e));
      return { ok: false, code: 'ERROR' };
    }
    await socket.join(room);
    return { ok: true };
  }

  @Authenticated()
  @SubscribeMessage('auction.unsubscribe')
  async unsubscribe(@ConnectedSocket() socket: Client, @MessageBody() body: unknown): Promise<Ack> {
    const parsed = AuctionSubscriptionSchema.safeParse(body);
    if (!parsed.success) return { ok: false, code: 'BAD_REQUEST' };
    await socket.leave(rooms.auction(parsed.data.auctionId));
    return { ok: true };
  }

  /** Removes every socket of a customer from an auction room (on every instance, when the Redis adapter is on).
   *  They cannot re-join: auction.subscribe re-checks access through RLS. */
  evict(customerId: string, auctionId: string): void {
    this.server?.in(rooms.customer(customerId)).socketsLeave(rooms.auction(auctionId));
  }

  deliver(deliveries: Delivery[]): void {
    for (const d of deliveries) this.server?.to(d.room).emit(d.event, d.data);
  }
}
