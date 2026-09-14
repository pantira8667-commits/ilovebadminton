import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Mock booking API with temporary slot locking.
 *
 * When a user picks a time slot, the slot is locked for 5 minutes so they can
 * fill in their details and confirm. The lock must be presented (lockId) when
 * confirming; expired or missing locks are rejected.
 *
 * In a real app this would live in a database (Lovable Cloud). Here we keep an
 * in-memory store as a mock.
 */

export const LOCK_DURATION_MS = 5 * 60 * 1000; // 5 นาที

type LockEntry = {
  lockId: string;
  date: string;
  court: string;
  time: string;
  expiresAt: number; // epoch ms
};

// Mock in-memory lock store (per server instance).
const locks = new Map<string, LockEntry>();

const slotKey = (date: string, court: string, time: string) =>
  `${date}|${court}|${time}`;

function sweepExpired() {
  const now = Date.now();
  for (const [key, lock] of locks) {
    if (lock.expiresAt <= now) locks.delete(key);
  }
}

const slotSchema = z.object({
  date: z.string().min(1, "กรุณาเลือกวันที่"),
  court: z.string().min(1, "กรุณาเลือกคอร์ท"),
  time: z.string().min(1, "กรุณาเลือกช่วงเวลา"),
});

/** Lock a slot for 5 minutes. */
export const lockSlot = createServerFn({ method: "POST" })
  .inputValidator((raw) => slotSchema.parse(raw))
  .handler(async ({ data }) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    sweepExpired();

    const key = slotKey(data.date, data.court, data.time);
    if (locks.has(key)) {
      return { ok: false as const, reason: "locked" as const };
    }

    const entry: LockEntry = {
      lockId: `LK-${Date.now().toString(36).toUpperCase()}-${Math.random()
        .toString(36)
        .slice(2, 6)
        .toUpperCase()}`,
      ...data,
      expiresAt: Date.now() + LOCK_DURATION_MS,
    };
    locks.set(key, entry);

    return {
      ok: true as const,
      lockId: entry.lockId,
      expiresAt: entry.expiresAt,
      expiresInSec: LOCK_DURATION_MS / 1000,
    };
  });

/** Release a lock early (user changed slot / cancelled). */
export const releaseLock = createServerFn({ method: "POST" })
  .inputValidator((raw) => z.object({ lockId: z.string().min(1) }).parse(raw))
  .handler(async ({ data }) => {
    for (const [key, lock] of locks) {
      if (lock.lockId === data.lockId) {
        locks.delete(key);
        return { ok: true as const };
      }
    }
    return { ok: true as const };
  });

/** List time slots currently locked for a date + court. */
export const getLockedSlots = createServerFn({ method: "GET" })
  .inputValidator((raw) =>
    z
      .object({ date: z.string().min(1), court: z.string().min(1) })
      .parse(raw),
  )
  .handler(async ({ data }) => {
    sweepExpired();
    const times: string[] = [];
    for (const lock of locks.values()) {
      if (lock.date === data.date && lock.court === data.court) {
        times.push(lock.time);
      }
    }
    return { lockedTimes: times };
  });

const bookingSchema = slotSchema.extend({
  lockId: z.string().min(1, "ไม่พบการล็อกคอร์ท"),
  duration: z
    .union([z.literal(1), z.literal(2)])
    .describe("ระยะเวลาจอง (ชั่วโมง)"),
  name: z
    .string()
    .trim()
    .min(2, "กรุณากรอกชื่อให้ถูกต้อง")
    .max(80, "ชื่อยาวเกินไป"),
  phone: z
    .string()
    .trim()
    .regex(/^[0-9]{9,10}$/, "เบอร์โทรศัพท์ต้องเป็นตัวเลข 9-10 หลัก"),
});

export type BookingPayload = z.infer<typeof bookingSchema>;

export const createBooking = createServerFn({ method: "POST" })
  .inputValidator((raw) => bookingSchema.parse(raw))
  .handler(async ({ data }) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    sweepExpired();

    // Verify the caller still holds a valid lock for this slot.
    const key = slotKey(data.date, data.court, data.time);
    const lock = locks.get(key);
    if (!lock || lock.lockId !== data.lockId) {
      return {
        ok: false as const,
        reason: "lock_expired" as const,
        message: "หมดเวลาการล็อกคอร์ทชั่วคราวแล้ว กรุณาเลือกช่วงเวลาอีกครั้ง",
      };
    }

    // Consume the lock — the booking is confirmed.
    locks.delete(key);

    const id = `BK-${Date.now().toString(36).toUpperCase()}`;
    const { lockId, ...bookingData } = data;

    return {
      ok: true as const,
      booking: {
        id,
        ...bookingData,
        status: "confirmed" as const,
        createdAt: new Date().toISOString(),
      },
    };
  });

export type CreateBookingResult = Awaited<ReturnType<typeof createBooking>>;
