import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { notifications } from '../../db/schema.js';

/** The 🔔 in the owner area and in the client app. */

export type RecipientKind = 'owner' | 'customer';

export interface NewNotification {
  kind: string;
  title: string;
  body: string;
  link?: string | null;
  branchId?: string | null;
  /** Same key for the same person = notified once. */
  dedupeKey?: string | null;
}

export const NotificationView = Type.Object({
  id: Type.String(),
  kind: Type.String(),
  title: Type.String(),
  body: Type.String(),
  link: Type.Union([Type.String(), Type.Null()]),
  read: Type.Boolean(),
  at: Type.String(),
});
export type NotificationView = Static<typeof NotificationView>;

export const NotificationsList = Type.Object({ unread: Type.Integer(), items: Type.Array(NotificationView) });

/** Something that can run SQL: the db, or a transaction (sync). */
type Exec = { execute: Db['execute'] };

/** Copies [n] to every owner/manager of the business. Used inside the sync transaction too. */
export async function notifyOwnersSql(tx: Exec, tenantId: string, n: NewNotification): Promise<void> {
  await tx.execute(sql`
    insert into notifications (id, recipient_kind, recipient_id, branch_id, kind, title, body, link, dedupe_key)
    select gen_random_uuid(), 'owner', u.id, ${n.branchId ?? null}, ${n.kind}, ${n.title}, ${n.body}, ${n.link ?? null}, ${n.dedupeKey ?? null}
    from owner_users u where u.tenant_id = ${tenantId}
    on conflict do nothing`);
}

export interface NotificationsRepo {
  forOwners(tenantId: string, n: NewNotification): Promise<void>;
  forCustomer(customerId: string, n: NewNotification): Promise<void>;
  list(kind: RecipientKind, recipientId: string, limit: number): Promise<{ id: string; kind: string; title: string; body: string; link: string | null; readAt: Date | null; createdAt: Date }[]>;
  unread(kind: RecipientKind, recipientId: string): Promise<number>;
  /** ids = null: all. */
  markRead(kind: RecipientKind, recipientId: string, ids: string[] | null, at: Date): Promise<void>;
}

export class DrizzleNotificationsRepo implements NotificationsRepo {
  constructor(private readonly db: Db) {}

  forOwners(tenantId: string, n: NewNotification) {
    return notifyOwnersSql(this.db, tenantId, n);
  }

  async forCustomer(customerId: string, n: NewNotification) {
    await this.db.execute(sql`
      insert into notifications (id, recipient_kind, recipient_id, branch_id, kind, title, body, link, dedupe_key)
      values (gen_random_uuid(), 'customer', ${customerId}, ${n.branchId ?? null}, ${n.kind}, ${n.title}, ${n.body}, ${n.link ?? null}, ${n.dedupeKey ?? null})
      on conflict do nothing`);
  }

  list(kind: RecipientKind, recipientId: string, limit: number) {
    return this.db
      .select({
        id: notifications.id,
        kind: notifications.kind,
        title: notifications.title,
        body: notifications.body,
        link: notifications.link,
        readAt: notifications.readAt,
        createdAt: notifications.createdAt,
      })
      .from(notifications)
      .where(and(eq(notifications.recipientKind, kind), eq(notifications.recipientId, recipientId)))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
  }

  async unread(kind: RecipientKind, recipientId: string) {
    const [r] = await this.db
      .select({ n: count() })
      .from(notifications)
      .where(and(eq(notifications.recipientKind, kind), eq(notifications.recipientId, recipientId), isNull(notifications.readAt)));
    return Number(r?.n ?? 0);
  }

  async markRead(kind: RecipientKind, recipientId: string, ids: string[] | null, at: Date) {
    await this.db
      .update(notifications)
      .set({ readAt: at })
      .where(
        and(
          eq(notifications.recipientKind, kind),
          eq(notifications.recipientId, recipientId),
          isNull(notifications.readAt),
          ...(ids ? [inArray(notifications.id, ids.length ? ids : ['00000000-0000-0000-0000-000000000000'])] : []),
        ),
      );
  }
}

export class NotificationsService {
  constructor(
    private readonly repo: NotificationsRepo,
    private readonly log: (msg: string, err?: unknown) => void = () => {},
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Never breaks the action that caused it: a failed notification is only logged. */
  async owners(tenantId: string, n: NewNotification) {
    await this.repo.forOwners(tenantId, n).catch((e) => this.log('owner notification failed', e));
  }

  async customer(customerId: string, n: NewNotification) {
    await this.repo.forCustomer(customerId, n).catch((e) => this.log('customer notification failed', e));
  }

  async list(kind: RecipientKind, recipientId: string): Promise<Static<typeof NotificationsList>> {
    const [items, unread] = await Promise.all([this.repo.list(kind, recipientId, 30), this.repo.unread(kind, recipientId)]);
    return {
      unread,
      items: items.map((i) => ({ id: i.id, kind: i.kind, title: i.title, body: i.body, link: i.link, read: i.readAt !== null, at: i.createdAt.toISOString() })),
    };
  }

  markRead(kind: RecipientKind, recipientId: string, ids: string[] | null) {
    return this.repo.markRead(kind, recipientId, ids, this.now());
  }
}

export const notificationRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const n = app.services.notifications;
  const ReadBody = Type.Object(
    { ids: Type.Optional(Type.Array(Type.String({ format: 'uuid' }), { maxItems: 100 })) },
    { additionalProperties: false },
  );
  const ok = { 200: Type.Object({ ok: Type.Literal(true) }) };

  app.get('/v1/owner/notifications', { schema: { response: { 200: NotificationsList } }, preHandler: app.requireOwner }, (req) =>
    n.list('owner', req.owner.userId),
  );
  app.post('/v1/owner/notifications/read', { schema: { body: ReadBody, response: ok }, preHandler: app.requireOwner }, async (req) => {
    await n.markRead('owner', req.owner.userId, req.body.ids ?? null);
    return { ok: true as const };
  });
  app.get('/v1/customer/notifications', { schema: { response: { 200: NotificationsList } }, preHandler: app.requireCustomer }, (req) =>
    n.list('customer', req.customer.customerId),
  );
  app.post('/v1/customer/notifications/read', { schema: { body: ReadBody, response: ok }, preHandler: app.requireCustomer }, async (req) => {
    await n.markRead('customer', req.customer.customerId, req.body.ids ?? null);
    return { ok: true as const };
  });
};
