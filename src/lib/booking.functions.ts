import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Mock booking API for a 2-step badminton court booking flow.
 *
 * Step 1: user picks date / courts / start time / duration.
 * Step 2: the chosen court-time is locked for 3 minutes while the user fills
 * in their name + phone and confirms.
 *
 * Availability is tracked on 30-minute sub-slots so a 1h or 2h reservation
 * blocks every half hour it covers. In a real app this lives in a database.
 */

export const LOCK_DURATION_MS = 3 * 60 * 1000; // 3 นาที
export const OPEN_MINUTES = 10 * 60; // 10:00
export const CLOSE_MINUTES = 22 * 60; // 22:00
export const SLOT_STEP_MIN = 30;
export const PRICE_PER_HOUR = 300;

export const COURTS = [
  "คอร์ท 1",
  "คอร์ท 2",
  "คอร์ท 3",
  "คอร์ท 5",
  "คอร์ท 6",
] as const;

/** All bookable start times (last 1h slot starts at 21:00). */
export const START_TIMES: string[] = (() => {
  const out: string[] = [];
  for (let m = OPEN_MINUTES; m + 60 <= CLOSE_MINUTES; m += SLOT_STEP_MIN) {
    out.push(toTime(m));
  }
  return out;
})();

export function toMinutes(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m ?? 0);
}

export function toTime(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

/** Expand a start time + duration into the 30-min sub-slots it occupies. */
export function subSlots(time: string, durationHours: number): string[] {
  const start = toMinutes(time);
  const out: string[] = [];
  for (let m = start; m < start + durationHours * 60; m += SLOT_STEP_MIN) {
    out.push(toTime(m));
  }
  return out;
}

type LockEntry = { lockId: string; expiresAt: number };

// Mock in-memory stores (per server instance).
const locks = new Map<string, LockEntry>();
const booked = new Map<string, string>(); // key -> bookingId
const seededDates = new Set<string>();

const key = (date: string, court: string, slot: string) =>
  `${date}|${court}|${slot}`;

function sweepExpired() {
  const now = Date.now();
  for (const [k, lock] of locks) {
    if (lock.expiresAt <= now) locks.delete(k);
  }
}

/** Deterministic pseudo-random pre-booked slots so the UI shows "Booked". */
function seedDate(date: string) {
  if (seededDates.has(date)) return;
  seededDates.add(date);
  let h = 2166136261;
  for (const ch of date) {
    h = (h ^ ch.charCodeAt(0)) * 16777619;
    h >>>= 0;
  }
  const rand = () => {
    h = (h * 1103515245 + 12345) >>> 0;
    return h / 0xffffffff;
  };
  for (const court of COURTS) {
    const blocks = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < blocks; i++) {
      const start = START_TIMES[Math.floor(rand() * START_TIMES.length)]!;
      const hours = rand() > 0.5 ? 2 : 1;
      for (const slot of subSlots(start, hours)) {
        if (toMinutes(slot) + SLOT_STEP_MIN > CLOSE_MINUTES) continue;
        booked.set(key(date, court, slot), "SEED");
      }
    }
  }
}

const newId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random()
    .toString(36)
    .slice(2, 6)
    .toUpperCase()}`;

const dateField = z.string().min(1, "กรุณาเลือกวันที่");
const courtsField = z
  .array(z.string().min(1))
  .min(1, "กรุณาเลือกคอร์ทอย่างน้อย 1 คอร์ท")
  .max(2, "เลือกได้สูงสุด 2 คอร์ท");
const durationField = z.union([z.literal(1), z.literal(2)]);

/** Quota rule: 2 ชม. ได้ 1 คอร์ท หรือ 1 ชม. ได้สูงสุด 2 คอร์ท */
export function quotaError(courts: string[], duration: 1 | 2): string | null {
  if (courts.length === 0) return "กรุณาเลือกคอร์ทอย่างน้อย 1 คอร์ท";
  if (duration === 2 && courts.length > 1)
    return "จอง 2 ชั่วโมง ได้สูงสุด 1 คอร์ท";
  if (duration === 1 && courts.length > 2)
    return "จอง 1 ชั่วโมง ได้สูงสุด 2 คอร์ท";
  return null;
}

const selectionSchema = z
  .object({
    date: dateField,
    courts: courtsField,
    time: z.string().min(1, "กรุณาเลือกช่วงเวลา"),
    duration: durationField,
  })
  .refine((v) => quotaError(v.courts, v.duration) === null, {
    message: "เกินโควตาการจอง (2 ชม./1 คอร์ท หรือ 1 ชม./2 คอร์ท)",
    path: ["courts"],
  })
  .refine((v) => toMinutes(v.time) + v.duration * 60 <= CLOSE_MINUTES, {
    message: "ช่วงเวลาเกินเวลาปิดทำการ (22:00)",
    path: ["time"],
  });

/** Availability for a date: booked + currently locked sub-slots. */
export const getAvailability = createServerFn({ method: "GET" })
  .inputValidator((raw) => z.object({ date: dateField }).parse(raw))
  .handler(async ({ data }) => {
    sweepExpired();
    seedDate(data.date);

    const bookedSlots: Array<{ court: string; time: string }> = [];
    for (const k of booked.keys()) {
      const [d, court, slot] = k.split("|");
      if (d === data.date) bookedSlots.push({ court: court!, time: slot! });
    }
    const lockedSlots: Array<{ court: string; time: string }> = [];
    for (const k of locks.keys()) {
      const [d, court, slot] = k.split("|");
      if (d === data.date) lockedSlots.push({ court: court!, time: slot! });
    }

    return {
      courts: [...COURTS],
      startTimes: START_TIMES,
      booked: bookedSlots,
      locked: lockedSlots,
    };
  });

/** Lock the selected courts for 3 minutes (all-or-nothing). */
export const lockSlot = createServerFn({ method: "POST" })
  .inputValidator((raw) => selectionSchema.parse(raw))
  .handler(async ({ data }) => {
    await new Promise((resolve) => setTimeout(resolve, 150));
    sweepExpired();
    seedDate(data.date);

    const slots = subSlots(data.time, data.duration);
    const conflicts = data.courts.filter((court) =>
      slots.some(
        (slot) =>
          locks.has(key(data.date, court, slot)) ||
          booked.has(key(data.date, court, slot)),
      ),
    );
    if (conflicts.length > 0) {
      return { ok: false as const, reason: "unavailable" as const, conflicts };
    }

    const expiresAt = Date.now() + LOCK_DURATION_MS;
    const lockIds: string[] = [];
    for (const court of data.courts) {
      const lockId = newId("LK");
      for (const slot of slots) {
        locks.set(key(data.date, court, slot), { lockId, expiresAt });
      }
      lockIds.push(lockId);
    }

    return {
      ok: true as const,
      lockIds,
      expiresAt,
      expiresInSec: LOCK_DURATION_MS / 1000,
    };
  });

/** Release locks early (countdown expired / user went back). */
export const releaseLock = createServerFn({ method: "POST" })
  .inputValidator((raw) =>
    z.object({ lockIds: z.array(z.string().min(1)).min(1) }).parse(raw),
  )
  .handler(async ({ data }) => {
    const ids = new Set(data.lockIds);
    for (const [k, lock] of locks) {
      if (ids.has(lock.lockId)) locks.delete(k);
    }
    return { ok: true as const };
  });

const bookingSchema = z.intersection(
  selectionSchema,
  z.object({
    lockIds: z.array(z.string().min(1)).min(1, "ไม่พบการล็อกคอร์ท"),
    name: z
      .string()
      .trim()
      .min(2, "กรุณากรอกชื่อให้ถูกต้อง")
      .max(80, "ชื่อยาวเกินไป"),
    phone: z
      .string()
      .trim()
      .regex(/^[0-9]{9,10}$/, "เบอร์โทรศัพท์ต้องเป็นตัวเลข 9-10 หลัก"),
  }),
);

export type BookingPayload = z.infer<typeof bookingSchema>;

export const createBooking = createServerFn({ method: "POST" })
  .inputValidator((raw) => bookingSchema.parse(raw))
  .handler(async ({ data }) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    sweepExpired();

    const slots = subSlots(data.time, data.duration);
    const held = new Set(data.lockIds);

    for (const court of data.courts) {
      for (const slot of slots) {
        const lock = locks.get(key(data.date, court, slot));
        if (!lock || !held.has(lock.lockId)) {
          return {
            ok: false as const,
            reason: "lock_expired" as const,
            message:
              "หมดเวลาการล็อกคอร์ทแล้ว กรุณาเลือกคอร์ทและเวลาใหม่อีกครั้ง",
          };
        }
      }
    }

    const id = newId("BK");
    for (const court of data.courts) {
      for (const slot of slots) {
        locks.delete(key(data.date, court, slot));
        booked.set(key(data.date, court, slot), id);
      }
    }

    const endTime = toTime(toMinutes(data.time) + data.duration * 60);
    const { lockIds: _lockIds, ...bookingData } = data;

    return {
      ok: true as const,
      booking: {
        id,
        ...bookingData,
        endTime,
        totalPrice: PRICE_PER_HOUR * data.duration * data.courts.length,
        status: "confirmed" as const,
        createdAt: new Date().toISOString(),
      },
    };
  });

export type CreateBookingResult = Awaited<ReturnType<typeof createBooking>>;
