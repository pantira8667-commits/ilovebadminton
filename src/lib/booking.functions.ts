import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * Mock booking API.
 *
 * Simulates a server-side reservation endpoint. In a real app this would write
 * to a database (Lovable Cloud) and return the persisted record. Here we echo
 * back the booking with a generated id + status so the UI can show a summary.
 */

const bookingSchema = z.object({
  date: z.string().min(1, "กรุณาเลือกวันที่"),
  court: z.string().min(1, "กรุณาเลือกคอร์ท"),
  time: z.string().min(1, "กรุณาเลือกช่วงเวลา"),
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
    // Simulate network / DB latency.
    await new Promise((resolve) => setTimeout(resolve, 450));

    const id = `BK-${Date.now().toString(36).toUpperCase()}`;

    return {
      ok: true,
      booking: {
        id,
        ...data,
        status: "confirmed" as const,
        createdAt: new Date().toISOString(),
      },
    };
  });

export type CreateBookingResult = Awaited<ReturnType<typeof createBooking>>;
