// From apps/api/src/bookings/bookings.service.spec.ts in github.com/jani358/BookLK.

import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BookingStatus, PaymentStatus, Prisma, Role, SlotStatus } from '@prisma/client';
import { OutboxService } from '../events/outbox/outbox.service';
import { FollowUpDispatcher } from '../payments/application/follow-up.dispatcher';
import { PaymentLifecycleService } from '../payments/application/payment-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { BookingsService } from './bookings.service';

/**
 * Unit tests for the booking concurrency guards.
 *
 * Prisma and Redis are mocked so these run with no live infrastructure and
 * stay fast. The end-to-end behaviour under real parallelism is covered by
 * bookings.concurrency.spec.ts.
 */
describe('BookingsService', () => {
  let service: BookingsService;
  let prisma: jest.Mocked<PrismaService>;
  let redis: jest.Mocked<RedisService>;
  let outbox: { enqueue: jest.Mock };
  let lifecycle: { requestRefund: jest.Mock };
  let followUps: { dispatch: jest.Mock };

  const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111';
  const SLOT_ID = '22222222-2222-4222-8222-222222222222';
  const VENDOR_ID = '33333333-3333-4333-8333-333333333333';
  const SERVICE_ID = '44444444-4444-4444-8444-444444444444';

  /** A slot far enough in the future to pass the "not in the past" check. */
  const futureSlot = (status: SlotStatus, heldUntil: Date | null = null) => ({
    id: SLOT_ID,
    vendorId: VENDOR_ID,
    serviceId: SERVICE_ID,
    startsAt: new Date(Date.now() + 86_400_000),
    endsAt: new Date(Date.now() + 90_000_000),
    status,
    heldUntil,
    version: 0,
  });

  const activeService = {
    id: SERVICE_ID,
    vendorId: VENDOR_ID,
    name: 'Deep Tissue Massage',
    description: null,
    durationMinutes: 60,
    priceCents: 750_000,
    isActive: true,
    createdAt: new Date(),
  };

  /**
   * Builds a mock transaction client and wires $transaction to invoke the
   * callback with it, mirroring how Prisma actually behaves.
   */
  const mockTx = (overrides: Record<string, unknown> = {}) => ({
    $queryRaw: jest.fn(),
    slot: { update: jest.fn() },
    service: { findUnique: jest.fn().mockResolvedValue(activeService) },
    booking: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    payment: { findUnique: jest.fn(), update: jest.fn() },
    ledgerEntry: { create: jest.fn() },
    ...overrides,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingsService,
        {
          provide: PrismaService,
          useValue: {
            booking: { findUnique: jest.fn(), findMany: jest.fn(), update: jest.fn() },
            slot: { update: jest.fn(), findUnique: jest.fn() },
            payment: { findUnique: jest.fn(), update: jest.fn() },
            ledgerEntry: { create: jest.fn() },
            $transaction: jest.fn(),
          },
        },
        {
          provide: RedisService,
          useValue: {
            // Lock granted by default; individual tests override to simulate
            // contention.
            acquireLock: jest.fn().mockResolvedValue('lock-token'),
            releaseLock: jest.fn().mockResolvedValue(true),
          },
        },
        {
          provide: OutboxService,
          useValue: { enqueue: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: PaymentLifecycleService,
          useValue: { requestRefund: jest.fn().mockResolvedValue({ id: 'refund-1' }) },
        },
        { provide: FollowUpDispatcher, useValue: { dispatch: jest.fn().mockResolvedValue(undefined) } },
      ],
    }).compile();

    service = module.get(BookingsService);
    prisma = module.get(PrismaService);
    redis = module.get(RedisService);
    outbox = module.get(OutboxService);
    lifecycle = module.get(PaymentLifecycleService);
    followUps = module.get(FollowUpDispatcher);
  });

  afterEach(() => jest.clearAllMocks());

  describe('create - slot contention', () => {
    it('throws ConflictException when the slot is already BOOKED', async () => {
      const tx = mockTx();
      // The locking SELECT returns a slot someone else already took.
      tx.$queryRaw.mockResolvedValue([futureSlot(SlotStatus.BOOKED)]);

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).rejects.toThrow(
        ConflictException,
      );
      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).rejects.toThrow(
        'Slot no longer available',
      );

      // Critically: no booking row is ever attempted for a taken slot.
      expect(tx.booking.create).not.toHaveBeenCalled();
      expect(tx.slot.update).not.toHaveBeenCalled();
    });

    it('throws ConflictException when the slot is HELD and the hold is still live', async () => {
      const tx = mockTx();
      // Held by another checkout for another 5 minutes.
      tx.$queryRaw.mockResolvedValue([
        futureSlot(SlotStatus.HELD, new Date(Date.now() + 300_000)),
      ]);

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).rejects.toThrow(
        ConflictException,
      );
      expect(tx.booking.create).not.toHaveBeenCalled();
    });

    it('ALLOWS booking when a HELD slot has an EXPIRED hold', async () => {
      const tx = mockTx();
      // Hold lapsed a minute ago — an abandoned checkout must not strand
      // inventory, so this slot is bookable again.
      tx.$queryRaw.mockResolvedValue([
        futureSlot(SlotStatus.HELD, new Date(Date.now() - 60_000)),
      ]);
      tx.booking.create.mockResolvedValue({ id: 'booking-1', slotId: SLOT_ID });

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).resolves.toEqual({
        id: 'booking-1',
        slotId: SLOT_ID,
      });

      expect(tx.slot.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: SlotStatus.BOOKED }),
        }),
      );
    });

    it('books a FREE slot and snapshots the price', async () => {
      const tx = mockTx();
      tx.$queryRaw.mockResolvedValue([futureSlot(SlotStatus.FREE)]);
      tx.booking.create.mockResolvedValue({ id: 'booking-1', priceCents: 750_000 });

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await service.create(CUSTOMER_ID, { slotId: SLOT_ID });

      expect(tx.booking.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          slotId: SLOT_ID,
          // The ACTIVE booking holds the slot through this UNIQUE column.
          activeSlotId: SLOT_ID,
          customerId: CUSTOMER_ID,
          status: BookingStatus.PENDING,
          // Copied from the service at booking time, not referenced later.
          priceCents: 750_000,
        }),
      });
    });

    it('throws NotFoundException when the slot does not exist', async () => {
      const tx = mockTx();
      tx.$queryRaw.mockResolvedValue([]);

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).rejects.toThrow(
        NotFoundException,
      );
    });

    it('uses SELECT ... FOR UPDATE to take a row lock', async () => {
      const tx = mockTx();
      tx.$queryRaw.mockResolvedValue([futureSlot(SlotStatus.FREE)]);
      tx.booking.create.mockResolvedValue({ id: 'booking-1' });

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await service.create(CUSTOMER_ID, { slotId: SLOT_ID });

      // The tagged-template strings array is the first argument.
      const sql = (tx.$queryRaw.mock.calls[0][0] as string[]).join('');
      expect(sql).toContain('FOR UPDATE');
      expect(sql).toContain('"Slot"');
    });

    it('runs at READ COMMITTED: the row lock and UNIQUE(activeSlotId) are the guarantee', async () => {
      // Serializable made bookings for DIFFERENT slots abort each other
      // (40001 / P2034) under the k6 spike, leaving slots unbooked.
      const tx = mockTx();
      tx.$queryRaw.mockResolvedValue([futureSlot(SlotStatus.FREE)]);
      tx.booking.create.mockResolvedValue({ id: 'booking-1' });
      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await service.create(CUSTOMER_ID, { slotId: SLOT_ID });

      const options = (prisma.$transaction as jest.Mock).mock.calls[0][1];
      expect(options.isolationLevel).toBe(Prisma.TransactionIsolationLevel.ReadCommitted);
    });
  });

  describe('create - unlocked pre-check (load shedding)', () => {
    it('rejects a slot that is already BOOKED before taking the lock or opening a transaction', async () => {
      (prisma.slot.findUnique as jest.Mock).mockResolvedValue({ status: SlotStatus.BOOKED, heldUntil: null });

      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).rejects.toThrow('Slot no longer available');

      // Under a spike most requests are losers; each one must not cost a
      // pooled database transaction.
      expect(redis.acquireLock).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects a slot whose hold is still live before taking the lock', async () => {
      (prisma.slot.findUnique as jest.Mock).mockResolvedValue({
        status: SlotStatus.HELD,
        heldUntil: new Date(Date.now() + 60_000),
      });

      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).rejects.toThrow(ConflictException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('still goes through the lock and the locked transaction when the slot looks FREE', async () => {
      // The unlocked read is only a filter: a FREE answer may be stale, so the
      // FOR UPDATE re-check inside the transaction stays the guarantee.
      (prisma.slot.findUnique as jest.Mock).mockResolvedValue({ status: SlotStatus.FREE, heldUntil: null });
      const tx = mockTx();
      tx.$queryRaw.mockResolvedValue([futureSlot(SlotStatus.BOOKED)]);
      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).rejects.toThrow(ConflictException);
      expect(redis.acquireLock).toHaveBeenCalled();
      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('create - Redis lock (first-line guard)', () => {
    it('rejects immediately when the Redis lock is already held', async () => {
      (redis.acquireLock as jest.Mock).mockResolvedValue(null);

      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).rejects.toThrow(
        ConflictException,
      );

      // Short-circuits before the database is touched at all.
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('releases the lock even when the transaction throws', async () => {
      const tx = mockTx();
      tx.$queryRaw.mockResolvedValue([futureSlot(SlotStatus.BOOKED)]);

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).rejects.toThrow(
        ConflictException,
      );

      // Without the finally block a failed attempt would hold the slot for the
      // full 10s TTL, blocking legitimate bookers.
      expect(redis.releaseLock).toHaveBeenCalledWith(`lock:slot:${SLOT_ID}`, 'lock-token');
    });
  });

  describe('create - idempotency', () => {
    it('returns the existing booking for a replayed idempotency key', async () => {
      const existing = {
        id: 'booking-original',
        customerId: CUSTOMER_ID,
        idempotencyKey: 'key-123',
      };
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(existing);

      const result = await service.create(CUSTOMER_ID, {
        slotId: SLOT_ID,
        idempotencyKey: 'key-123',
      });

      expect(result).toEqual(existing);
      // A retry must not re-run the transaction or take a lock.
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(redis.acquireLock).not.toHaveBeenCalled();
    });

    it('rejects an idempotency key belonging to a different customer', async () => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue({
        id: 'booking-original',
        customerId: 'someone-else',
        idempotencyKey: 'key-123',
      });

      await expect(
        service.create(CUSTOMER_ID, { slotId: SLOT_ID, idempotencyKey: 'key-123' }),
      ).rejects.toThrow('Idempotency key already used');
    });
  });

  describe('create - transactional outbox', () => {
    it('writes booking.created.v1 through the SAME transaction client', async () => {
      const tx = mockTx();
      tx.$queryRaw.mockResolvedValue([futureSlot(SlotStatus.FREE)]);
      tx.booking.create.mockResolvedValue({ id: 'booking-1', slotId: SLOT_ID });

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await service.create(CUSTOMER_ID, { slotId: SLOT_ID });

      expect(outbox.enqueue).toHaveBeenCalledTimes(1);
      const [txArg, name, aggregateId, data] = outbox.enqueue.mock.calls[0];
      // The tx client, not the global prisma client: the event commits or
      // rolls back with the booking.
      expect(txArg).toBe(tx);
      expect(name).toBe('booking.created.v1');
      expect(aggregateId).toBe('booking-1');
      expect(data).toEqual(
        expect.objectContaining({
          bookingId: 'booking-1',
          slotId: SLOT_ID,
          vendorId: VENDOR_ID,
          customerId: CUSTOMER_ID,
          status: 'PENDING',
          slotStatus: 'BOOKED',
          priceCents: 750_000,
          // The locked row had version 0; the booking bumps it to 1.
          slotVersion: 1,
        }),
      );
    });

    it('writes no event when the booking is rejected', async () => {
      const tx = mockTx();
      tx.$queryRaw.mockResolvedValue([futureSlot(SlotStatus.BOOKED)]);

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await expect(service.create(CUSTOMER_ID, { slotId: SLOT_ID })).rejects.toThrow(
        ConflictException,
      );
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('cancel - conditional update + outbox', () => {
    const BOOKING_ID = '55555555-5555-4555-8555-555555555555';
    const PAYMENT_ID = '66666666-6666-4666-8666-666666666666';

    const bookingRow = (status: BookingStatus) => ({
      id: BOOKING_ID,
      slotId: SLOT_ID,
      customerId: CUSTOMER_ID,
      vendorId: VENDOR_ID,
      serviceId: SERVICE_ID,
      status,
      priceCents: 750_000,
      cancelledAt: null,
      vendor: { ownerId: 'owner', id: VENDOR_ID },
    });

    beforeEach(() => {
      (prisma.booking.findUnique as jest.Mock).mockResolvedValue(
        bookingRow(BookingStatus.CONFIRMED),
      );
    });

    it('frees the slot, records a full refund, and queues it after commit', async () => {
      const tx = mockTx();
      tx.booking.updateMany.mockResolvedValue({ count: 1 });
      tx.booking.findUniqueOrThrow.mockResolvedValue(bookingRow(BookingStatus.CANCELLED));
      tx.slot.update.mockResolvedValue({ ...futureSlot(SlotStatus.FREE), version: 2 });
      tx.payment.findUnique.mockResolvedValue({
        id: PAYMENT_ID,
        status: PaymentStatus.SUCCEEDED,
        amountCents: 750_000,
        refundedCents: 0,
      });
      tx.payment.update.mockResolvedValue({
        id: PAYMENT_ID,
        provider: 'mock',
        providerRef: 'pi_1',
        amountCents: 750_000,
        platformFeeCents: 75_000,
        vendorAmountCents: 675_000,
      });

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      await service.cancel(BOOKING_ID, CUSTOMER_ID, Role.CUSTOMER);

      // Clearing activeSlotId is what lets the freed slot be booked again.
      expect(tx.booking.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: BookingStatus.CANCELLED, activeSlotId: null }),
        }),
      );
      // No ledger write here: the reversal is appended when the provider
      // confirms the refund (PaymentLifecycleService.completeRefund).
      expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
      expect(lifecycle.requestRefund).toHaveBeenCalledWith(tx, {
        paymentId: PAYMENT_ID,
        reason: 'Booking cancelled',
        idempotencyKey: 'cancel-' + BOOKING_ID,
      });
      expect(followUps.dispatch).toHaveBeenCalledWith([{ kind: 'execute-refund', refundId: 'refund-1' }]);
      const names = outbox.enqueue.mock.calls.map((c) => c[1]);
      expect(names).toEqual(['booking.cancelled.v1']);
      expect(outbox.enqueue.mock.calls[0][3]).toEqual(
        expect.objectContaining({ slotStatus: 'FREE', slotVersion: 2, refunded: true }),
      );
      for (const call of outbox.enqueue.mock.calls) expect(call[0]).toBe(tx);
    });

    it('is a no-op for the loser of two concurrent cancels (no double refund, no second event)', async () => {
      const tx = mockTx();
      // The other cancel already flipped the status.
      tx.booking.updateMany.mockResolvedValue({ count: 0 });
      tx.booking.findUnique.mockResolvedValue(bookingRow(BookingStatus.CANCELLED));

      (prisma.$transaction as jest.Mock).mockImplementation(
        async (cb: (t: unknown) => Promise<unknown>) => cb(tx),
      );

      const result = await service.cancel(BOOKING_ID, CUSTOMER_ID, Role.CUSTOMER);

      expect(result.status).toBe(BookingStatus.CANCELLED);
      expect(tx.slot.update).not.toHaveBeenCalled();
      expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
      expect(lifecycle.requestRefund).not.toHaveBeenCalled();
      expect(outbox.enqueue).not.toHaveBeenCalled();
    });
  });
});
