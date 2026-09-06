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
  LedgerEntryType,
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
  ) {}

  /**
   * Creates a booking, guaranteeing at most one booking per slot.
   *
   * DEFENCE IN DEPTH — four layers, each covering the previous one's gap:
   *
   *   1. Idempotency key   — the same client retrying gets the same booking.
   *   2. Redis SET NX lock — cheap first-line filter. OPTIMISATION ONLY.
   *   3. SELECT FOR UPDATE inside a Serializable transaction — the REAL
   *      guarantee. Concurrent transactions serialise on the slot row.
   *   4. UNIQUE(slotId) on Booking — the database's own final backstop, which
   *      holds even if every line of logic above is wrong.
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
        const holdExpired =
          slot.status === SlotStatus.HELD && slot.heldUntil !== null && slot.heldUntil < now;

        const bookable = slot.status === SlotStatus.FREE || holdExpired;

        if (!bookable) {
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

        // ---- Layer 4: UNIQUE(slotId) ----------------------------------
        // If a bug ever let two transactions get here, Postgres rejects the
        // second with P2002, which the exception filter maps to a 409.
        return tx.booking.create({
          data: {
            slotId: slot.id,
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
      },
      {
        // Serializable is the strictest isolation Postgres offers. Combined
        // with FOR UPDATE it rules out phantom reads as well as lost updates —
        // for money and inventory, correctness beats throughput.
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
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

    return this.prisma.$transaction(async (tx) => {
      const booking = await tx.booking.update({
        where: { id },
        data: { status: BookingStatus.CANCELLED, cancelledAt: new Date() },
      });

      // Return the slot to the pool so someone else can book it.
      await tx.slot.update({
        where: { id: booking.slotId },
        data: {
          status: SlotStatus.FREE,
          heldUntil: null,
          version: { increment: 1 },
        },
      });

      const payment = await tx.payment.findUnique({ where: { bookingId: id } });

      // Only a SUCCEEDED payment can be refunded. A PENDING intent was never
      // captured, so there is nothing to give back.
      if (payment && payment.status === PaymentStatus.SUCCEEDED) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.REFUNDED },
        });

        // Append a REFUND row rather than deleting the CHARGE: the ledger is
        // append-only, so the audit trail shows money in AND money out.
        await tx.ledgerEntry.create({
          data: {
            bookingId: id,
            type: LedgerEntryType.REFUND,
            // Negative: refunds reduce the platform's net position, so summing
            // amountCents over the ledger yields the true balance.
            amountCents: -payment.amountCents,
          },
        });

        this.logger.log(`Refund ledger entry created for booking ${id}`);
      }

      return booking;
    });
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

    return this.prisma.booking.update({
      where: { id },
      data: { status: BookingStatus.COMPLETED },
    });
  }
}
