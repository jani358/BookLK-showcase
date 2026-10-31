// From apps/api/src/bookings/bookings.service.ts in github.com/jani358/BookLK.

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  Booking,
  BookingStatus,
  PaymentStatus,
  Prisma,
  Role,
  SlotStatus,
} from '@prisma/client';
import {
  PaginatedResult,
  buildCursorArgs,
  toPaginatedResult,
} from '../common/dto/pagination.dto';
import { OutboxService } from '../events/outbox/outbox.service';
import { FollowUpDispatcher } from '../payments/application/follow-up.dispatcher';
import { PaymentLifecycleService } from '../payments/application/payment-lifecycle.service';
import { FollowUp } from '../payments/domain/provider-event';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreateBookingDto, ListBookingsQueryDto } from './dto/booking.dto';

/** Shape returned by the raw locking SELECT. */
interface LockedSlotRow {
  id: string;
  vendorId: string;
  serviceId: string;
  startsAt: Date;
  endsAt: Date;
  status: SlotStatus;
  heldUntil: Date | null;
  version: number;
}

@Injectable()
export class BookingsService {
  private readonly logger = new Logger(BookingsService.name);

  /**
   * Redis lock TTL. Comfortably longer than the DB transaction (single-digit
   * ms) but short enough that a crashed process cannot wedge a slot: worst
   * case the slot is unbookable for 10 seconds, then self-heals.
   */
  private static readonly LOCK_TTL_SECONDS = 10;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly outbox: OutboxService,
    private readonly payments: PaymentLifecycleService,
    private readonly followUps: FollowUpDispatcher,
  ) {}

  /**
   * Creates a booking, guaranteeing at most one booking per slot.
   *
   * DEFENCE IN DEPTH — four layers, each covering the previous one's gap:
   *
   *   1. Idempotency key   — the same client retrying gets the same booking.
   *   2. Redis SET NX lock — cheap first-line filter. OPTIMISATION ONLY.
   *   3. SELECT FOR UPDATE inside a READ COMMITTED transaction — the REAL
   *      guarantee. Concurrent transactions serialise on the slot row.
   *   4. UNIQUE(activeSlotId) on Booking — the database's own final backstop,
   *      which holds even if every line of logic above is wrong. activeSlotId
   *      is cleared on cancellation, so a freed slot can be booked again.
   *
   * Layer 2 is explicitly NOT the correctness mechanism. Redis is a separate
   * system that can be down, evict a key, or fail over and lose it; treating a
   * Redis lock as authoritative for money or inventory is a classic
   * distributed-systems mistake. It exists to shed load from obvious
   * double-clicks before they reach Postgres. Correctness lives in layers 3-4.
   */
  async create(customerId: string, dto: CreateBookingDto): Promise<Booking> {
    // ---- Layer 1: idempotency -----------------------------------------
    // Checked before taking any lock so a retry is cheap and never blocks.
    if (dto.idempotencyKey) {
      const existing = await this.prisma.booking.findUnique({
        where: { idempotencyKey: dto.idempotencyKey },
      });

      if (existing) {
        if (existing.customerId !== customerId) {
          // A key is scoped to its creator; another user replaying it must not
          // be handed someone else's booking.
          throw new ConflictException('Idempotency key already used');
        }

        this.logger.log(`Idempotent replay for key ${dto.idempotencyKey}`);
        return existing;
      }
    }

    // ---- Load shedding: unlocked status read (optimisation) -------------
    // Under a spike almost every request is a loser. Without this, each loser
    // that gets the Redis lock after the winner released it opens a full
    // transaction only to find the slot BOOKED, and those doomed
    // transactions queue for the Prisma connection pool (k6 spike: p95 5.6 s,
    // see docs/LOAD-TEST-REPORT.md). A plain read rejects them in one short
    // query. It can only be wrong in two harmless ways: it says FREE when the
    // slot was just taken (the FOR UPDATE re-check below catches that), or
    // BOOKED when it was just freed (a 409 the client can retry).
    const current = await this.prisma.slot.findUnique({
      where: { id: dto.slotId },
      select: { status: true, heldUntil: true },
    });
    if (current && !isBookable(current.status, current.heldUntil, new Date())) {
      throw new ConflictException('Slot no longer available');
    }

    // ---- Layer 2: Redis advisory lock (optimisation) -------------------
    const lockKey = `lock:slot:${dto.slotId}`;
    const lockToken = await this.redis.acquireLock(lockKey, BookingsService.LOCK_TTL_SECONDS);

    if (!lockToken) {
      // Someone is mid-checkout on this slot right now. Rejecting immediately
      // saves a doomed transaction, but note this is a FAST PATH, not the
      // guarantee — if Redis were unavailable we would fall through to the DB
      // transaction and still be correct.
      throw new ConflictException('Slot no longer available');
    }

    try {
      return await this.createWithinTransaction(customerId, dto);
    } finally {
      // Always release, even on failure, so a rejected attempt does not hold
      // the slot for the full TTL. Token-checked release prevents deleting a
      // lock another request acquired after ours expired.
      await this.redis.releaseLock(lockKey, lockToken);
    }
  }

  private async createWithinTransaction(
    customerId: string,
    dto: CreateBookingDto,
  ): Promise<Booking> {
    return this.prisma.$transaction(
      async (tx) => {
        // ---- Layer 3: pessimistic row lock ----------------------------
        //
        // FOR UPDATE takes an exclusive lock on the slot row. A second
        // transaction reaching this line BLOCKS until we commit or roll back,
        // then re-reads and sees status = BOOKED.
        //
        // Pessimistic over optimistic here because contention is genuinely
        // high (many users chase the same popular slot) and the lock is held
        // for microseconds. An optimistic version-check would make every
        // loser burn a full transaction and retry, which is more total work
        // than briefly waiting on a lock.
        //
        // Raw SQL because Prisma's query builder has no FOR UPDATE.
        const rows = await tx.$queryRaw<LockedSlotRow[]>`
          SELECT id, "vendorId", "serviceId", "startsAt", "endsAt", status, "heldUntil", version
          FROM "Slot"
          WHERE id = ${dto.slotId}
          FOR UPDATE
        `;

        const slot = rows[0];

        if (!slot) {
          throw new NotFoundException('Slot not found');
        }

        // Re-validated INSIDE the lock. Any check performed before the lock is
        // a stale read by definition.
        const now = new Date();
        if (!isBookable(slot.status, slot.heldUntil, now)) {
          throw new ConflictException('Slot no longer available');
        }

        if (slot.startsAt <= now) {
          throw new BadRequestException('Cannot book a slot in the past');
        }

        const service = await tx.service.findUnique({ where: { id: slot.serviceId } });

        if (!service || !service.isActive) {
          throw new BadRequestException('Service is no longer available');
        }

        await tx.slot.update({
          where: { id: slot.id },
          data: {
            status: SlotStatus.BOOKED,
            heldUntil: null,
            // Bump the optimistic counter too, so any concurrent reader
            // holding an older version can detect that it went stale.
            version: { increment: 1 },
          },
        });

        // ---- Layer 4: UNIQUE(activeSlotId) ----------------------------
        // If a bug ever let two transactions get here, Postgres rejects the
        // second with P2002, which the exception filter maps to a 409.
        const booking = await tx.booking.create({
          data: {
            slotId: slot.id,
            activeSlotId: slot.id,
            customerId,
            vendorId: slot.vendorId,
            serviceId: slot.serviceId,
            status: BookingStatus.PENDING,
            // Price is SNAPSHOT at booking time. Referencing service.priceCents
            // later would let a vendor's price change silently alter what an
            // existing customer owes.
            priceCents: service.priceCents,
            idempotencyKey: dto.idempotencyKey,
          },
        });

        // ---- Event: same transaction, never a direct publish ------------
        // The outbox row commits or rolls back with the booking. A rolled-back
        // booking therefore never emits booking.created, and a committed one
        // always does, even if the process dies right after COMMIT.
        await this.outbox.enqueue(tx, 'booking.created.v1', booking.id, {
          bookingId: booking.id,
          slotId: slot.id,
          vendorId: slot.vendorId,
          serviceId: slot.serviceId,
          customerId,
          status: 'PENDING',
          priceCents: service.priceCents,
          slotStartsAt: slot.startsAt.toISOString(),
          slotStatus: 'BOOKED',
          // The row is locked FOR UPDATE, so the increment above is exactly +1.
          slotVersion: slot.version + 1,
        });

        return booking;
      },
      {
        // READ COMMITTED is enough, and Serializable was harmful. Every row
        // this transaction decides on is locked: the slot by FOR UPDATE above,
        // and the booking by UNIQUE(activeSlotId). Serializable added predicate
        // locks on top, and under the k6 spike bookings for DIFFERENT slots
        // aborted each other (40001 -> P2034 -> 409), which left slots unbooked
        // and burnt CPU on doomed work (docs/LOAD-TEST-REPORT.md, ADR 0002).
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        // Fail fast rather than queue behind a long lock; the client can retry.
        timeout: 10_000,
        maxWait: 5_000,
      },
    );
  }

  async findMine(
    customerId: string,
    query: ListBookingsQueryDto,
  ): Promise<PaginatedResult<Booking>> {
    const rows = await this.prisma.booking.findMany({
      where: { customerId, ...(query.status && { status: query.status }) },
      ...buildCursorArgs(query),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        slot: { select: { id: true, startsAt: true, endsAt: true, status: true } },
        service: { select: { id: true, name: true, durationMinutes: true, priceCents: true } },
        vendor: { select: { id: true, name: true, slug: true, city: true } },
      },
    });

    return toPaginatedResult(rows, query);
  }

  /** Vendor inbox across every vendor the user owns (dashboard view). */
  async findIncoming(
    ownerId: string,
    query: ListBookingsQueryDto,
  ): Promise<PaginatedResult<Booking>> {
    const rows = await this.prisma.booking.findMany({
      where: {
        vendor: { ownerId },
        ...(query.status && { status: query.status }),
      },
      ...buildCursorArgs(query),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        slot: { select: { id: true, startsAt: true, endsAt: true, status: true } },
        service: { select: { id: true, name: true, durationMinutes: true, priceCents: true } },
        vendor: { select: { id: true, name: true, slug: true, city: true } },
        customer: { select: { name: true, phone: true } },
      },
    });

    return toPaginatedResult(rows, query);
  }

  /** Vendor-side inbox of incoming bookings. */
  async findForVendor(
    vendorId: string,
    query: ListBookingsQueryDto,
  ): Promise<PaginatedResult<Booking>> {
    const rows = await this.prisma.booking.findMany({
      where: { vendorId, ...(query.status && { status: query.status }) },
      ...buildCursorArgs(query),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: {
        slot: { select: { startsAt: true, endsAt: true } },
        service: { select: { name: true } },
        customer: { select: { name: true, phone: true } },
      },
    });

    return toPaginatedResult(rows, query);
  }

  async findById(id: string, userId: string, role: Role): Promise<Booking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: {
        slot: true,
        service: true,
        vendor: { select: { id: true, name: true, slug: true, ownerId: true, city: true } },
        payment: true,
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    // A booking is visible to its customer, the owning vendor, or an admin.
    const isCustomer = booking.customerId === userId;
    const isVendorOwner = booking.vendor.ownerId === userId;

    if (!isCustomer && !isVendorOwner && role !== Role.ADMIN) {
      throw new ForbiddenException('You do not have access to this booking');
    }

    return booking;
  }

  /**
   * Cancels a booking and returns the slot to inventory.
   *
   * Runs in a transaction so the slot release, the status change and the refund
   * ledger entry are all-or-nothing: a partial failure could otherwise free the
   * slot while leaving the booking active, or refund without cancelling.
   */
  async cancel(id: string, userId: string, role: Role): Promise<Booking> {
    const existing = await this.findById(id, userId, role);

    if (existing.status === BookingStatus.CANCELLED) {
      // Idempotent: cancelling twice is a no-op, not an error.
      return existing;
    }

    if (existing.status === BookingStatus.COMPLETED) {
      throw new BadRequestException('A completed booking cannot be cancelled');
    }

    const refundFollowUps: FollowUp[] = [];
    const cancelled = await this.prisma.$transaction(async (tx) => {
      // Conditional update: two concurrent cancels both pass the status check
      // above, but only one of them can flip PENDING/CONFIRMED -> CANCELLED.
      // The loser becomes a no-op instead of freeing the slot, refunding and
      // emitting booking.cancelled a second time.
      const cancelledAt = new Date();
      const flipped = await tx.booking.updateMany({
        where: { id, status: { in: [BookingStatus.PENDING, BookingStatus.CONFIRMED] } },
        // activeSlotId -> NULL releases the UNIQUE claim, so the freed slot can be
        // booked again while this row stays as history.
        data: { status: BookingStatus.CANCELLED, cancelledAt, activeSlotId: null },
      });

      if (flipped.count === 0) {
        const current = await tx.booking.findUnique({ where: { id } });
        if (current?.status === BookingStatus.CANCELLED) return current;
        throw new BadRequestException('This booking can no longer be cancelled');
      }

      const booking = await tx.booking.findUniqueOrThrow({ where: { id } });

      // Return the slot to the pool so someone else can book it.
      const slot = await tx.slot.update({
        where: { id: booking.slotId },
        data: {
          status: SlotStatus.FREE,
          heldUntil: null,
          version: { increment: 1 },
        },
      });

      const payment = await tx.payment.findUnique({ where: { bookingId: id } });
      let refunded = false;

      // Only a captured payment can be refunded. A PENDING one was never
      // charged; if it succeeds later, the payment lifecycle refunds it then.
      if (
        payment &&
        (payment.status === PaymentStatus.SUCCEEDED || payment.status === PaymentStatus.PARTIALLY_REFUNDED) &&
        payment.refundedCents < payment.amountCents
      ) {
        // A Refund ROW, written in this transaction: the decision to refund
        // commits with the cancellation. The refunds job then executes it at
        // the provider and appends the ledger reversal when it succeeds. The
        // key makes a retried cancel return the same refund.
        const refund = await this.payments.requestRefund(tx, {
          paymentId: payment.id,
          reason: 'Booking cancelled',
          idempotencyKey: `cancel-${id}`,
        });
        refunded = true;
        refundFollowUps.push({ kind: 'execute-refund', refundId: refund.id });
        this.logger.log(`Refund ${refund.id} requested for cancelled booking ${id}`);
      }

      await this.outbox.enqueue(tx, 'booking.cancelled.v1', booking.id, {
        bookingId: booking.id,
        slotId: booking.slotId,
        vendorId: booking.vendorId,
        serviceId: booking.serviceId,
        customerId: booking.customerId,
        status: 'CANCELLED',
        priceCents: booking.priceCents,
        slotStartsAt: slot.startsAt.toISOString(),
        slotStatus: 'FREE',
        slotVersion: slot.version,
        cancelledAt: cancelledAt.toISOString(),
        refunded,
      });

      return booking;
    });

    // After COMMIT: hand the refund to the refunds queue. If this is lost, the
    // refund sweeper finds the PENDING row.
    await this.followUps.dispatch(refundFollowUps);
    return cancelled;
  }

  /**
   * Vendor marks a booking as fulfilled. Gates the review flow — only a
   * COMPLETED booking can be reviewed.
   */
  async complete(id: string, userId: string, role: Role): Promise<Booking> {
    const booking = await this.prisma.booking.findUnique({
      where: { id },
      include: { vendor: { select: { ownerId: true } } },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    if (booking.vendor.ownerId !== userId && role !== Role.ADMIN) {
      throw new ForbiddenException('Only the vendor can complete a booking');
    }

    if (booking.status !== BookingStatus.CONFIRMED) {
      throw new BadRequestException('Only a confirmed booking can be completed');
    }

    return this.prisma.$transaction(async (tx) => {
      // Conditional, so a concurrent cancel cannot be overwritten by a complete.
      const flipped = await tx.booking.updateMany({
        where: { id, status: BookingStatus.CONFIRMED },
        data: { status: BookingStatus.COMPLETED },
      });
      if (flipped.count === 0) {
        throw new BadRequestException('Only a confirmed booking can be completed');
      }

      const completed = await tx.booking.findUniqueOrThrow({
        where: { id },
        include: { slot: { select: { startsAt: true, version: true } } },
      });

      await this.outbox.enqueue(tx, 'booking.completed.v1', id, {
        bookingId: id,
        slotId: completed.slotId,
        vendorId: completed.vendorId,
        serviceId: completed.serviceId,
        customerId: completed.customerId,
        status: 'COMPLETED',
        priceCents: completed.priceCents,
        slotStartsAt: completed.slot.startsAt.toISOString(),
        slotStatus: 'BOOKED',
        slotVersion: completed.slot.version,
      });

      const { slot: _slot, ...plain } = completed;
      return plain;
    });
  }
}

/** FREE, or HELD with a hold that has expired. */
function isBookable(status: SlotStatus, heldUntil: Date | null, now: Date): boolean {
  if (status === SlotStatus.FREE) return true;
  return status === SlotStatus.HELD && heldUntil !== null && heldUntil < now;
}
