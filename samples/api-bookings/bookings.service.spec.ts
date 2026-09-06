import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BookingStatus, SlotStatus } from '@prisma/client';
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
    booking: { create: jest.fn() },
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
            slot: { update: jest.fn() },
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
      ],
    }).compile();

    service = module.get(BookingsService);
    prisma = module.get(PrismaService);
    redis = module.get(RedisService);
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
});
