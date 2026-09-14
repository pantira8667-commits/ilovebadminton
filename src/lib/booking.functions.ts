import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Mock booking API with temporary slot locking.
 *
 * When a user picks a time slot, the selected court(s) are locked for 5
 * minutes so they can fill in their details and confirm. The locks must be
 * presented (lockIds) when confirming; expired or missing locks are rejected.
 * Multiple courts can be locked/booked at once when available.
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

const newLockId = () =>
  `LK-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

const courtsField = z
  .array(z.string().min(1))
  .min(1, "กรุณาเลือกคอร์ทอย่างน้อย 1 คอร์ท");

const lockInputSchema = z.object({
  date: z.string().min(1, "กรุณาเลือกวันที่"),
  courts: courtsField,
  time: z.string().min(1, "กรุณาเลือกช่วงเวลา"),
});

/** Lock one or more court slots for 5 minutes (all-or-nothing). */
export const lockSlot = createServerFn({ method: "POST" })
  .inputValidator((raw) => lockInputSchema.parse(raw))
  .handler(async ({ data }) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    sweepExpired();

    const conflicts = data.courts.filter((court) =>
      locks.has(slotKey(data.date, court, data.time)),
    );
    if (conflicts.length > 0) {
      return { ok: false as const, reason: "locked" as const, conflicts };
    }

    const expiresAt = Date.now() + LOCK_DURATION_MS;
    const lockIds: string[] = [];
    for (const court of data.courts) {
      const entry: LockEntry = {
        lockId: newLockId(),
        date: data.date,
        court,
        time: data.time,
        expiresAt,
      };
      locks.set(slotKey(data.date, court, data.time), entry);
      lockIds.push(entry.lockId);
    }

    return {
      ok: true as const,
      lockIds,
      expiresAt,
      expiresInSec: LOCK_DURATION_MS / 1000,
    };
  });

/** Release locks early (user changed slot / cancelled). */
export const releaseLock = createServerFn({ method: "POST" })
  .inputValidator((raw) =>
    z.object({ lockIds: z.array(z.string().min(1)).min(1) }).parse(raw),
  )
  .handler(async ({ data }) => {
    const ids = new Set(data.lockIds);
    for (const [key, lock] of locks) {
      if (ids.has(lock.lockId)) locks.delete(key);
    }
    return { ok: true as const };
  });

/** List currently locked {court, time} pairs for a date. */
export const getLockedSlots = createServerFn({ method: "GET" })
  .inputValidator((raw) =>
    z.object({ date: z.string().min(1) }).parse(raw),
  )
  .handler(async ({ data }) => {
    sweepExpired();
    const entries: Array<{ court: string; time: string }> = [];
    for (const lock of locks.values()) {
      if (lock.date === data.date) {
        entries.push({ court: lock.court, time: lock.time });
      }
    }
    return { locked: entries };
  });

const bookingSchema = lockInputSchema.extend({
  lockIds: z.array(z.string().min(1)).min(1, "ไม่พบการล็อกคอร์ท"),
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

    // Verify the caller still holds valid locks for every requested court.
    const heldIds = new Set(data.lockIds);
    for (const court of data.courts) {
      const lock = locks.get(slotKey(data.date, court, data.time));
      if (!lock || !heldIds.has(lock.lockId)) {
        return {
          ok: false as const,
          reason: "lock_expired" as const,
          message: "หมดเวลาการล็อกคอร์ทชั่วคราวแล้ว กรุณาเลือกช่วงเวลาอีกครั้ง",
        };
      }
    }

    // Consume the locks — the booking is confirmed.
    for (const court of data.courts) {
      locks.delete(slotKey(data.date, court, data.time));
    }

    const id = `BK-${Date.now().toString(36).toUpperCase()}`;
    const { lockIds, ...bookingData } = data;

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
