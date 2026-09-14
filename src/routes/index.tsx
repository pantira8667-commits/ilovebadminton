import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { addDays, format, isSameDay, parseISO } from "date-fns";
import { th as thLocale } from "date-fns/locale";
import {
  ArrowLeft,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  Clock,
  Hourglass,
  Loader2,
  Lock,
  MapPin,
  Phone,
  Timer,
  TriangleAlert,
  User,
} from "lucide-react";

import {
  COURTS,
  CLOSE_MINUTES,
  PRICE_PER_HOUR,
  START_TIMES,
  createBooking,
  getAvailability,
  lockSlot,
  quotaError,
  releaseLock,
  subSlots,
  toMinutes,
  toTime,
} from "@/lib/booking.functions";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

const DURATIONS = [1, 2] as const;
const PHONE_RE = /^[0-9]{9,10}$/;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "จองคอร์ทแบดมินตัน 2 ขั้นตอน | Smash Court" },
      {
        name: "description",
        content:
          "จองคอร์ทแบดมินตันออนไลน์ เปิด 10:00-22:00 เลือกคอร์ทและเวลาแบบครึ่งชั่วโมง ล็อกคอร์ท 3 นาทีเพื่อยืนยันข้อมูล",
      },
      {
        property: "og:title",
        content: "จองคอร์ทแบดมินตัน 2 ขั้นตอน | Smash Court",
      },
      {
        property: "og:description",
        content:
          "เลือกคอร์ทและเวลา แล้วยืนยันข้อมูลภายใน 3 นาที ระบบล็อกคอร์ทให้อัตโนมัติ",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BookingPage,
});

type Slot = { court: string; time: string };

type Errors = {
  courts?: string | undefined;
  time?: string | undefined;
  name?: string | undefined;
  phone?: string | undefined;
  lock?: string | undefined;
};

type BookingResult = Extract<
  Awaited<ReturnType<typeof createBooking>>,
  { ok: true }
>;

function BookingPage() {
  const today = useMemo(() => new Date(), []);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(today, i)),
    [today],
  );

  const [step, setStep] = useState<1 | 2>(1);
  const [date, setDate] = useState(format(today, "yyyy-MM-dd"));
  const [courts, setCourts] = useState<string[]>([]);
  const [time, setTime] = useState<string | null>(null);
  const [duration, setDuration] = useState<1 | 2>(1);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<Errors>({});

  const [booked, setBooked] = useState<Slot[]>([]);
  const [locked, setLocked] = useState<Slot[]>([]);

  const [lock, setLock] = useState<{ lockIds: string[]; expiresAt: number } | null>(
    null,
  );
  const [remainingMs, setRemainingMs] = useState(0);
  const [locking, setLocking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BookingResult | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const lockRef = useRef<typeof lock>(null);
  lockRef.current = lock;

  const selectedDate = parseISO(date);
  const totalPrice = PRICE_PER_HOUR * duration * courts.length;
  const endTime = time ? toTime(toMinutes(time) + duration * 60) : null;

  const refreshAvailability = useCallback(async (forDate: string) => {
    try {
      const res = await getAvailability({ data: { date: forDate } });
      setBooked(res.booked);
      setLocked(res.locked);
    } catch {
      // mock API — ignore
    }
  }, []);

  useEffect(() => {
    void refreshAvailability(date);
  }, [date, refreshAvailability]);

  // Countdown for the 3-minute hold in step 2.
  useEffect(() => {
    if (!lock) return;
    const id = window.setInterval(() => {
      const r = lock.expiresAt - Date.now();
      if (r <= 0) {
        window.clearInterval(id);
        setLock(null);
        setRemainingMs(0);
        setStep(1);
        setTime(null);
        setErrors({
          lock: "หมดเวลา 3 นาที ระบบปลดล็อกคอร์ทแล้ว กรุณาเลือกคอร์ทและเวลาใหม่",
        });
        void refreshAvailability(date);
      } else {
        setRemainingMs(r);
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [lock, date, refreshAvailability]);

  const isUnavailable = useCallback(
    (court: string, start: string, hours: number) => {
      if (toMinutes(start) + hours * 60 > CLOSE_MINUTES) return true;
      const slots = subSlots(start, hours);
      return slots.some(
        (slot) =>
          booked.some((b) => b.court === court && b.time === slot) ||
          locked.some((l) => l.court === court && l.time === slot),
      );
    },
    [booked, locked],
  );

  function toggleCourt(court: string) {
    setErrors({});
    setCourts((prev) => {
      if (prev.includes(court)) return prev.filter((c) => c !== court);
      const max = duration === 2 ? 1 : 2;
      if (prev.length >= max) {
        setErrors({
          courts:
            duration === 2
              ? "จอง 2 ชั่วโมง ได้สูงสุด 1 คอร์ท"
              : "จอง 1 ชั่วโมง ได้สูงสุด 2 คอร์ท",
        });
        return prev;
      }
      return [...prev, court].sort();
    });
  }

  function pickDuration(next: 1 | 2) {
    setErrors({});
    setDuration(next);
    if (next === 2 && courts.length > 1) setCourts(courts.slice(0, 1));
    if (time && toMinutes(time) + next * 60 > CLOSE_MINUTES) setTime(null);
  }

  function pickDate(iso: string) {
    setErrors({});
    setDate(iso);
    setTime(null);
    setCourts([]);
  }

  const step1Error = quotaError(courts, duration) ?? (!time ? "กรุณาเลือกช่วงเวลา" : null);

  async function goToStep2() {
    const quota = quotaError(courts, duration);
    if (quota) {
      setErrors({ courts: quota });
      return;
    }
    if (!time) {
      setErrors({ time: "กรุณาเลือกช่วงเวลา" });
      return;
    }
    setLocking(true);
    setErrors({});
    try {
      const res = await lockSlot({ data: { date, courts, time, duration } });
      if (!res.ok) {
        setCourts((prev) => prev.filter((c) => !res.conflicts.includes(c)));
        setErrors({
          courts: `${res.conflicts.join(", ")} เพิ่งถูกจองไปแล้วในช่วงเวลานี้`,
        });
        void refreshAvailability(date);
        return;
      }
      setLock({ lockIds: res.lockIds, expiresAt: res.expiresAt });
      setRemainingMs(res.expiresAt - Date.now());
      setStep(2);
    } catch (err) {
      console.error(err);
      setErrors({ lock: "ไม่สามารถล็อกคอร์ทได้ กรุณาลองอีกครั้ง" });
    } finally {
      setLocking(false);
    }
  }

  async function backToStep1() {
    const current = lockRef.current;
    setLock(null);
    setRemainingMs(0);
    setStep(1);
    setErrors({});
    if (current) {
      await releaseLock({ data: { lockIds: current.lockIds } }).catch(() => {});
      void refreshAvailability(date);
    }
  }

  async function handleSubmit() {
    const next: Errors = {};
    if (name.trim().length < 2) next.name = "กรุณากรอกชื่อให้ถูกต้อง";
    if (!PHONE_RE.test(phone.trim()))
      next.phone = "เบอร์โทรศัพท์ต้องเป็นตัวเลข 9-10 หลัก";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    const current = lockRef.current;
    if (!current || !time) {
      setErrors({ lock: "การล็อกคอร์ทหมดอายุ กรุณาเลือกใหม่" });
      setStep(1);
      return;
    }

    setSubmitting(true);
    try {
      const res = await createBooking({
        data: {
          date,
          courts,
          time,
          duration,
          lockIds: current.lockIds,
          name: name.trim(),
          phone: phone.trim(),
        },
      });
      if (!res.ok) {
        setLock(null);
        setRemainingMs(0);
        setStep(1);
        setTime(null);
        setErrors({ lock: res.message });
        void refreshAvailability(date);
        return;
      }
      setLock(null);
      setRemainingMs(0);
      setResult(res);
      setModalOpen(true);
      void refreshAvailability(date);
    } catch (err) {
      console.error(err);
      setErrors({ lock: "ไม่สามารถยืนยันการจองได้ กรุณาลองอีกครั้ง" });
    } finally {
      setSubmitting(false);
    }
  }

  function resetAll() {
    setModalOpen(false);
    setResult(null);
    setStep(1);
    setCourts([]);
    setTime(null);
    setDuration(1);
    setName("");
    setPhone("");
    setErrors({});
    void refreshAvailability(date);
  }

  const countdown = useMemo(() => {
    const total = Math.max(0, Math.ceil(remainingMs / 1000));
    return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
      total % 60,
    ).padStart(2, "0")}`;
  }, [remainingMs]);

  const urgent = lock !== null && remainingMs <= 45_000;

  const requestPayload = useMemo(
    () =>
      JSON.stringify(
        {
          date,
          courts,
          time,
          duration,
          name: name.trim(),
          phone: phone.trim(),
        },
        null,
        2,
      ),
    [date, courts, time, duration, name, phone],
  );

  return (
    <div className="min-h-screen bg-surface text-ink-fg court-grid">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <header className="text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-neon/40 bg-neon-soft px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-neon">
            Smash Court · เปิด 10:00 - 22:00
          </span>
          <h1 className="neon-text mt-4 text-3xl font-black leading-tight sm:text-4xl">
            จองคอร์ทแบดมินตัน
          </h1>
          <p className="mt-2 text-sm text-ink-muted">
            เลือกคอร์ทและเวลาในขั้นตอนที่ 1 แล้วยืนยันข้อมูลภายใน 3 นาที
          </p>
        </header>

        {/* Stepper */}
        <div className="mt-7 flex items-center gap-3">
          {[
            { n: 1 as const, label: "เลือกสนามและเวลา" },
            { n: 2 as const, label: "ยืนยันข้อมูล" },
          ].map((s, i) => (
            <div key={s.n} className="flex flex-1 items-center gap-3">
              <div
                className={cn(
                  "flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold sm:text-sm",
                  step === s.n
                    ? "border-neon bg-neon text-neon-foreground neon-glow"
                    : step > s.n
                      ? "border-neon/40 bg-neon-soft text-neon"
                      : "border-ink-border bg-ink text-ink-muted",
                )}
              >
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-black/20 text-[11px] font-black">
                  {s.n}
                </span>
                <span className="whitespace-nowrap">{s.label}</span>
              </div>
              {i === 0 && (
                <div
                  className={cn(
                    "hidden h-px flex-1 sm:block",
                    step === 2 ? "bg-neon/60" : "bg-ink-border",
                  )}
                />
              )}
            </div>
          ))}
        </div>

        {errors.lock && (
          <div className="mt-5 flex items-start gap-2 rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive-foreground">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{errors.lock}</span>
          </div>
        )}

        {step === 1 ? (
          <div className="mt-6 space-y-6">
            <Section icon={<CalendarDays className="h-4 w-4" />} title="เลือกวันที่">
              <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
                {days.map((day) => {
                  const iso = format(day, "yyyy-MM-dd");
                  const selected = iso === date;
                  return (
                    <button
                      key={iso}
                      type="button"
                      onClick={() => pickDate(iso)}
                      className={cn(
                        "flex min-w-[68px] shrink-0 flex-col items-center rounded-xl border px-3 py-2.5 transition-all",
                        selected
                          ? "border-neon bg-neon text-neon-foreground neon-glow"
                          : "border-ink-border bg-ink text-ink-fg hover:border-neon/60",
                      )}
                    >
                      <span className="text-[11px] font-medium uppercase tracking-wide opacity-70">
                        {format(day, "EE", { locale: thLocale })}
                      </span>
                      <span className="text-lg font-bold leading-tight">
                        {format(day, "d")}
                      </span>
                      <span className="text-[10px] opacity-70">
                        {isSameDay(day, today)
                          ? "วันนี้"
                          : format(day, "MMM", { locale: thLocale })}
                      </span>
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                {format(selectedDate, "EEEEที่ d MMMM yyyy", { locale: thLocale })}
              </p>
            </Section>

            <Section
              icon={<Hourglass className="h-4 w-4" />}
              title="ระยะเวลาต่อคอร์ท (ขั้นต่ำ 1 ชม.)"
            >
              <div className="grid grid-cols-2 gap-3">
                {DURATIONS.map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => pickDuration(d)}
                    className={cn(
                      "flex flex-col items-center gap-0.5 rounded-xl border py-3.5 transition-all",
                      duration === d
                        ? "border-neon bg-neon text-neon-foreground neon-glow"
                        : "border-ink-border bg-ink hover:border-neon/50",
                    )}
                  >
                    <span className="text-base font-bold">{d} ชั่วโมง</span>
                    <span className="text-[11px] opacity-75">
                      {d === 2 ? "ได้สูงสุด 1 คอร์ท" : "ได้สูงสุด 2 คอร์ท"}
                    </span>
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-ink-muted">
                โควตา: จองได้สูงสุด 2 ชม. ต่อ 1 คอร์ท หรือ 1 ชม. ได้สูงสุด 2 คอร์ท
              </p>
            </Section>

            <Section
              icon={<MapPin className="h-4 w-4" />}
              title="เลือกคอร์ท"
              error={errors.courts}
            >
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {COURTS.map((court) => {
                  const selected = courts.includes(court);
                  const unavailable =
                    time !== null && !selected && isUnavailable(court, time, duration);
                  return (
                    <button
                      key={court}
                      type="button"
                      disabled={unavailable}
                      onClick={() => toggleCourt(court)}
                      className={cn(
                        "relative flex flex-col items-center gap-2 rounded-xl border p-4 transition-all",
                        selected
                          ? "border-neon bg-neon-soft neon-glow"
                          : unavailable
                            ? "cursor-not-allowed border-ink-border bg-ink/50 text-ink-muted opacity-60"
                            : "border-ink-border bg-ink hover:border-neon/50",
                      )}
                    >
                      <div
                        className={cn(
                          "flex h-10 w-10 items-center justify-center rounded-lg text-sm font-black",
                          selected
                            ? "bg-neon text-neon-foreground"
                            : "bg-ink-soft text-ink-fg",
                        )}
                      >
                        {court.replace("คอร์ท ", "")}
                      </div>
                      <span className="text-xs font-semibold">{court}</span>
                      <span className="text-[10px] uppercase tracking-wide opacity-70">
                        {selected ? "Selected" : unavailable ? "Booked" : "Available"}
                      </span>
                      {selected && (
                        <CheckCircle2 className="absolute right-2 top-2 h-4 w-4 text-neon" />
                      )}
                      {unavailable && (
                        <Lock className="absolute right-2 top-2 h-3 w-3" />
                      )}
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section
              icon={<Clock className="h-4 w-4" />}
              title="เลือกเวลาเริ่ม (ทุก 30 นาที)"
              error={errors.time}
            >
              <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                {START_TIMES.map((start) => {
                  const fits = toMinutes(start) + duration * 60 <= CLOSE_MINUTES;
                  const pool = courts.length > 0 ? courts : [...COURTS];
                  const anyFree = pool.some(
                    (court) => !isUnavailable(court, start, duration),
                  );
                  const selected = time === start;
                  const disabled = !fits || (!selected && !anyFree);
                  return (
                    <button
                      key={start}
                      type="button"
                      disabled={disabled}
                      onClick={() => {
                        setErrors({});
                        setTime(start);
                        setCourts((prev) =>
                          prev.filter((c) => !isUnavailable(c, start, duration)),
                        );
                      }}
                      className={cn(
                        "relative rounded-xl border py-2.5 text-center transition-all",
                        selected
                          ? "border-neon bg-neon text-neon-foreground neon-glow"
                          : disabled
                            ? "cursor-not-allowed border-ink-border bg-ink/50 text-ink-muted line-through opacity-60"
                            : "border-ink-border bg-ink hover:border-neon/50",
                      )}
                    >
                      <span className="block text-sm font-bold">
                        {start} - {toTime(toMinutes(start) + duration * 60)}
                      </span>
                      <span className="block text-[10px] uppercase tracking-wide opacity-70">
                        {selected ? "Selected" : disabled ? "Booked" : "Available"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </Section>

            <div className="rounded-2xl border border-ink-border bg-ink p-5">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink-muted">รวมทั้งหมด</span>
                <span className="text-2xl font-black text-neon">
                  ฿{totalPrice.toLocaleString()}
                </span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                ฿{PRICE_PER_HOUR}/ชม. × {duration} ชม. ×{" "}
                {Math.max(courts.length, 0)} คอร์ท
              </p>
              <Button
                onClick={() => void goToStep2()}
                disabled={!!step1Error || locking}
                className="mt-4 h-12 w-full rounded-xl bg-neon text-base font-bold text-neon-foreground hover:bg-neon/90 disabled:opacity-40"
              >
                {locking ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    กำลังล็อกคอร์ท...
                  </>
                ) : (
                  <>
                    ถัดไป
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </>
                )}
              </Button>
              {step1Error && (
                <p className="mt-2 text-center text-xs text-ink-muted">
                  {step1Error}
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="mt-6 space-y-6">
            <div
              className={cn(
                "flex items-center justify-between rounded-2xl border px-4 py-3",
                urgent
                  ? "border-destructive/60 bg-destructive/10"
                  : "border-neon/50 bg-neon-soft",
              )}
            >
              <div className="flex items-center gap-2 text-sm">
                <Timer className={cn("h-4 w-4", urgent ? "text-destructive" : "text-neon")} />
                <span className={urgent ? "text-destructive" : "text-neon"}>
                  ล็อกคอร์ทไว้ให้คุณ กรุณายืนยันภายใน
                </span>
              </div>
              <span
                className={cn(
                  "font-mono text-lg font-black tabular-nums",
                  urgent ? "text-destructive" : "text-neon",
                )}
              >
                {countdown}
              </span>
            </div>

            <Section icon={<CheckCircle2 className="h-4 w-4" />} title="สรุปรายละเอียดการจอง">
              <dl className="space-y-2.5 text-sm">
                <Row
                  label="วันที่"
                  value={format(selectedDate, "EEEEที่ d MMMM yyyy", {
                    locale: thLocale,
                  })}
                />
                <Row label="คอร์ท" value={courts.join(", ")} />
                <Row label="เวลา" value={`${time} - ${endTime}`} />
                <Row label="ระยะเวลา" value={`${duration} ชั่วโมง`} />
                <div className="mt-3 flex items-center justify-between border-t border-ink-border pt-3">
                  <dt className="font-semibold">ราคารวม</dt>
                  <dd className="text-xl font-black text-neon">
                    ฿{totalPrice.toLocaleString()}
                  </dd>
                </div>
              </dl>
            </Section>

            <Section icon={<User className="h-4 w-4" />} title="ข้อมูลผู้จอง">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <Label htmlFor="name" className="text-xs text-ink-muted">
                    ชื่อ-นามสกุล
                  </Label>
                  <div className="relative mt-1.5">
                    <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                    <Input
                      id="name"
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        setErrors((p) => ({ ...p, name: undefined }));
                      }}
                      placeholder="เช่น สมชาย ใจดี"
                      className="h-11 border-ink-border bg-ink pl-9 text-ink-fg placeholder:text-ink-muted/70"
                    />
                  </div>
                  {errors.name && (
                    <p className="mt-1 text-xs text-destructive">{errors.name}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="phone" className="text-xs text-ink-muted">
                    เบอร์โทรศัพท์
                  </Label>
                  <div className="relative mt-1.5">
                    <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                    <Input
                      id="phone"
                      inputMode="numeric"
                      value={phone}
                      onChange={(e) => {
                        setPhone(e.target.value.replace(/[^0-9]/g, ""));
                        setErrors((p) => ({ ...p, phone: undefined }));
                      }}
                      placeholder="0812345678"
                      className="h-11 border-ink-border bg-ink pl-9 text-ink-fg placeholder:text-ink-muted/70"
                    />
                  </div>
                  {errors.phone && (
                    <p className="mt-1 text-xs text-destructive">{errors.phone}</p>
                  )}
                </div>
              </div>
            </Section>

            <div className="flex flex-col gap-3 sm:flex-row">
              <Button
                variant="outline"
                onClick={() => void backToStep1()}
                className="h-12 rounded-xl border-ink-border bg-ink text-ink-fg hover:bg-ink-soft sm:w-40"
              >
                <ArrowLeft className="mr-2 h-4 w-4" />
                ย้อนกลับ
              </Button>
              <Button
                onClick={() => void handleSubmit()}
                disabled={submitting}
                className="h-12 flex-1 rounded-xl bg-neon text-base font-bold text-neon-foreground hover:bg-neon/90 disabled:opacity-40"
              >
                {submitting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    กำลังยืนยัน...
                  </>
                ) : (
                  "ยืนยันการจอง"
                )}
              </Button>
            </div>
          </div>
        )}
      </div>

      <Dialog
        open={modalOpen}
        onOpenChange={(open) => {
          if (!open) resetAll();
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto border-ink-border bg-ink text-ink-fg sm:max-w-lg">
          <DialogHeader>
            <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-neon-soft">
              <CheckCircle2 className="h-8 w-8 text-neon" />
            </div>
            <DialogTitle className="text-center text-xl font-black">
              ยืนยันการจองสำเร็จ
            </DialogTitle>
            <DialogDescription className="text-center text-ink-muted">
              รหัสการจอง {result?.booking.id}
            </DialogDescription>
          </DialogHeader>

          {result && (
            <div className="space-y-4">
              <dl className="space-y-2 rounded-xl border border-ink-border bg-surface p-4 text-sm">
                <Row label="ชื่อผู้จอง" value={result.booking.name} />
                <Row label="เบอร์โทรศัพท์" value={result.booking.phone} />
                <Row
                  label="วันที่"
                  value={format(parseISO(result.booking.date), "d MMMM yyyy", {
                    locale: thLocale,
                  })}
                />
                <Row label="คอร์ท" value={result.booking.courts.join(", ")} />
                <Row
                  label="เวลา"
                  value={`${result.booking.time} - ${result.booking.endTime}`}
                />
                <Row label="ระยะเวลา" value={`${result.booking.duration} ชั่วโมง`} />
                <Row
                  label="ราคารวม"
                  value={`฿${result.booking.totalPrice.toLocaleString()}`}
                />
              </dl>

              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  Mock API request
                </p>
                <pre className="max-h-40 overflow-auto rounded-xl border border-ink-border bg-surface p-3 text-[11px] leading-relaxed text-neon">
                  {requestPayload}
                </pre>
              </div>
              <div>
                <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
                  Mock API response
                </p>
                <pre className="max-h-48 overflow-auto rounded-xl border border-ink-border bg-surface p-3 text-[11px] leading-relaxed text-neon">
                  {JSON.stringify(result, null, 2)}
                </pre>
              </div>

              <Button
                onClick={resetAll}
                className="h-11 w-full rounded-xl bg-neon font-bold text-neon-foreground hover:bg-neon/90"
              >
                จองอีกครั้ง
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Section({
  icon,
  title,
  error,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-ink-border bg-ink/60 p-5 backdrop-blur">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-neon-soft text-neon">
          {icon}
        </span>
        <h2 className="text-sm font-bold">{title}</h2>
      </div>
      {children}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-semibold">{value}</dd>
    </div>
  );
}
