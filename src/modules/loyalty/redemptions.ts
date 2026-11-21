import { randomInt } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { customers, loyaltyLedger, loyaltyRedemptions } from '../../db/schema.js';
import { AppError } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';
import type { CustomerContext } from '../customers/customers.js';
import type { DeviceContext } from '../devices/devices.service.js';
import { LoyaltyErrors, type LoyaltyRepo } from './loyalty.js';

/**
 * Spending points at the café:
 * 1. the customer picks a reward in the app → a 6-digit code, valid 10 minutes;
 * 2. the cashier types it on the POS → the POS sees the reward (nothing spent yet)
 *    and checks it fits the ticket;
 * 3. the POS redeems it → the points are spent once, the POS applies the discount.
 */

// ── Schema ──────────────────────────────────────────────────────

export const RedemptionCode = Type.Object({
  code: Type.String(),
  expiresAt: Type.String(),
  rewardName: Type.String(),
  points: Type.Integer(),
});

/** What the POS sees for a code. */
export const RedemptionView = Type.Object({
  id: Type.String(),
  rewardName: Type.String(),
  points: Type.Integer(),
  kind: Type.Union([Type.Literal('free_product'), Type.Literal('amount_off')]),
  productId: Type.Union([Type.String(), Type.Null()]),
  amount: Type.Union([Type.Integer(), Type.Null()]),
  customerName: Type.String(),
});
export type RedemptionView = Static<typeof RedemptionView>;

const CodeParams = Type.Object({ code: Type.String({ pattern: '^[0-9]{6}$' }) });
const RedeemBody = Type.Object({ orderId: Type.String({ format: 'uuid' }) }, { additionalProperties: false });

// ── Repo ────────────────────────────────────────────────────────

export interface RedemptionRecord {
  id: string;
  code: string;
  customerId: string;
  branchId: string;
  rewardId: string;
  rewardName: string;
  points: number;
  kind: 'free_product' | 'amount_off';
  productId: string | null;
  amount: number | null;
  expiresAt: Date;
}

export interface RedemptionsRepo {
  /** Is [code] already used by a live code of the branch? */
  codeTaken(branchId: string, code: string, now: Date): Promise<boolean>;
  /** Replaces the customer's earlier unused codes at this café. */
  cancelPending(customerId: string, branchId: string, now: Date): Promise<void>;
  create(r: RedemptionRecord): Promise<void>;
  /** A live (unused, not cancelled, not expired) code of the branch, with the customer's name. */
  findLive(branchId: string, code: string, now: Date): Promise<(RedemptionRecord & { customerName: string }) | null>;
  /** Marks it used and spends the points, atomically. false if it was used meanwhile. */
  redeem(r: RedemptionRecord, use: { orderId: string; deviceId: string; at: Date }): Promise<boolean>;
}

export class DrizzleRedemptionsRepo implements RedemptionsRepo {
  constructor(private readonly db: Db) {}

  private live(branchId: string, code: string, now: Date) {
    return and(
      eq(loyaltyRedemptions.branchId, branchId),
      eq(loyaltyRedemptions.code, code),
      isNull(loyaltyRedemptions.usedAt),
      isNull(loyaltyRedemptions.cancelledAt),
      gt(loyaltyRedemptions.expiresAt, now),
    );
  }

  async codeTaken(branchId: string, code: string, now: Date) {
    const rows = await this.db.select({ id: loyaltyRedemptions.id }).from(loyaltyRedemptions).where(this.live(branchId, code, now)).limit(1);
    return rows.length > 0;
  }

  async cancelPending(customerId: string, branchId: string, now: Date) {
    await this.db
      .update(loyaltyRedemptions)
      .set({ cancelledAt: now })
      .where(
        and(
          eq(loyaltyRedemptions.customerId, customerId),
          eq(loyaltyRedemptions.branchId, branchId),
          isNull(loyaltyRedemptions.usedAt),
          isNull(loyaltyRedemptions.cancelledAt),
        ),
      );
  }

  async create(r: RedemptionRecord) {
    await this.db.insert(loyaltyRedemptions).values(r);
  }

  async findLive(branchId: string, code: string, now: Date) {
    const [r] = await this.db
      .select({
        id: loyaltyRedemptions.id,
        code: loyaltyRedemptions.code,
        customerId: loyaltyRedemptions.customerId,
        branchId: loyaltyRedemptions.branchId,
        rewardId: loyaltyRedemptions.rewardId,
        rewardName: loyaltyRedemptions.rewardName,
        points: loyaltyRedemptions.points,
        kind: loyaltyRedemptions.kind,
        productId: loyaltyRedemptions.productId,
        amount: loyaltyRedemptions.amount,
        expiresAt: loyaltyRedemptions.expiresAt,
        customerName: customers.name,
      })
      .from(loyaltyRedemptions)
      .innerJoin(customers, eq(customers.id, loyaltyRedemptions.customerId))
      .where(this.live(branchId, code, now));
    return r ?? null;
  }

  async redeem(r: RedemptionRecord, use: { orderId: string; deviceId: string; at: Date }) {
    return this.db.transaction(async (tx) => {
      const done = await tx
        .update(loyaltyRedemptions)
        .set({ usedAt: use.at, orderId: use.orderId, deviceId: use.deviceId })
        .where(and(eq(loyaltyRedemptions.id, r.id), isNull(loyaltyRedemptions.usedAt), isNull(loyaltyRedemptions.cancelledAt)))
        .returning({ id: loyaltyRedemptions.id });
      if (done.length !== 1) return false;
      await tx.insert(loyaltyLedger).values({
        id: newId(),
        customerId: r.customerId,
        branchId: r.branchId,
        points: -r.points,
        kind: 'redeem',
        orderId: use.orderId,
        rewardName: r.rewardName,
        createdAt: use.at,
      });
      return true;
    });
  }
}

// ── Service ─────────────────────────────────────────────────────

export const RedemptionErrors = {
  rewardNotFound: () => new AppError('REWARD_NOT_FOUND', 'This reward does not exist anymore', 404),
  notEnoughPoints: () => new AppError('NOT_ENOUGH_POINTS', 'Not enough points for this reward', 409),
  codeNotFound: () => new AppError('REDEMPTION_NOT_FOUND', 'Unknown or expired reward code', 404),
  alreadyUsed: () => new AppError('REDEMPTION_USED', 'This reward code was already used', 409),
};

/** A code lives 10 minutes: enough to walk to the counter. */
export const REDEMPTION_TTL_MS = 10 * 60_000;

export class RedemptionsService {
  constructor(
    private readonly repo: RedemptionsRepo,
    private readonly loyalty: LoyaltyRepo,
    private readonly now: () => Date = () => new Date(),
    private readonly randomCode: () => string = () => String(randomInt(0, 1_000_000)).padStart(6, '0'),
  ) {}

  /** Customer: "Utiliser" on a reward. */
  async create(ctx: CustomerContext, branchId: string, rewardId: string): Promise<Static<typeof RedemptionCode>> {
    const program = await this.loyalty.program(branchId);
    if (!program?.enabled) throw LoyaltyErrors.loyaltyDisabled();
    const reward = program.rewards.find((r) => r.id === rewardId);
    if (!reward?.id) throw RedemptionErrors.rewardNotFound();
    if ((await this.loyalty.balance(ctx.customerId, branchId)) < reward.points) throw RedemptionErrors.notEnoughPoints();

    const now = this.now();
    await this.repo.cancelPending(ctx.customerId, branchId, now);
    let code = this.randomCode();
    for (let i = 0; i < 10 && (await this.repo.codeTaken(branchId, code, now)); i++) code = this.randomCode();
    if (await this.repo.codeTaken(branchId, code, now)) throw new AppError('TRY_AGAIN', 'Try again', 503);

    const expiresAt = new Date(now.getTime() + REDEMPTION_TTL_MS);
    await this.repo.create({
      id: newId(),
      code,
      customerId: ctx.customerId,
      branchId,
      rewardId: reward.id,
      rewardName: reward.name,
      points: reward.points,
      kind: reward.kind,
      productId: reward.productId ?? null,
      amount: reward.amount ?? null,
      expiresAt,
    });
    return { code, expiresAt: expiresAt.toISOString(), rewardName: reward.name, points: reward.points };
  }

  /** POS: what is this code? Nothing is spent. */
  async check(device: DeviceContext, code: string): Promise<RedemptionView> {
    const { view } = await this.live(device, code);
    return view;
  }

  /** POS: spend the points (once). The POS then applies the discount on [orderId]. */
  async redeem(device: DeviceContext, code: string, orderId: string): Promise<RedemptionView> {
    const { record, view } = await this.live(device, code);
    if (!(await this.repo.redeem(record, { orderId, deviceId: device.deviceId, at: this.now() }))) {
      throw RedemptionErrors.alreadyUsed();
    }
    return view;
  }

  private async live(device: DeviceContext, code: string) {
    const r = await this.repo.findLive(device.branchId, code, this.now());
    if (!r) throw RedemptionErrors.codeNotFound();
    // Points may have gone meanwhile (a refund, another reward).
    if ((await this.loyalty.balance(r.customerId, r.branchId)) < r.points) throw RedemptionErrors.notEnoughPoints();
    const { customerName, ...record } = r;
    const view: RedemptionView = {
      id: r.id,
      rewardName: r.rewardName,
      points: r.points,
      kind: r.kind,
      productId: r.productId,
      amount: r.amount,
      customerName,
    };
    return { record, view };
  }
}

// ── Routes ──────────────────────────────────────────────────────

export const redemptionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  const redemptions = app.services.redemptions;
  // 6 digits and 10 minutes: a few tries per minute make guessing useless.
  const limited = { rateLimit: { max: 30, timeWindow: '1 minute' } };

  app.post(
    '/v1/customer/points/:branchId/redemptions',
    {
      config: limited,
      schema: {
        params: Type.Object({ branchId: Type.String({ format: 'uuid' }) }),
        body: Type.Object({ rewardId: Type.String({ minLength: 1, maxLength: 40 }) }, { additionalProperties: false }),
        response: { 200: RedemptionCode },
      },
      preHandler: app.requireCustomer,
    },
    (req) => redemptions.create(req.customer, req.params.branchId, req.body.rewardId),
  );
  app.get(
    '/v1/devices/loyalty/redemptions/:code',
    { config: limited, schema: { params: CodeParams, response: { 200: RedemptionView } }, preHandler: app.requireDevice },
    (req) => redemptions.check(req.device, req.params.code),
  );
  app.post(
    '/v1/devices/loyalty/redemptions/:code/redeem',
    {
      config: limited,
      schema: { params: CodeParams, body: RedeemBody, response: { 200: RedemptionView } },
      preHandler: app.requireDevice,
    },
    (req) => redemptions.redeem(req.device, req.params.code, req.body.orderId),
  );
};
