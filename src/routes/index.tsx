import { useEffect, useMemo, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { addDays, format, isSameDay, parseISO } from "date-fns";
import { th as thLocale } from "date-fns/locale";
import {
  CalendarDays,
  CheckCircle2,
  Clock,
  Hourglass,
  Loader2,
  Lock,
  MapPin,
  Phone,
  Rocket,
  Timer,
  User,
} from "lucide-react";

import {
  createBooking,
  getLockedSlots,
  lockSlot,
  releaseLock,
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

const COURTS = ["คอร์ท 1", "คอร์ท 2", "คอร์ท 3"] as const;
const TIME_SLOTS = ["17:00", "18:00", "19:00", "20:00"] as const;
const DURATIONS = [1, 2] as const;
const PRICE_PER_HOUR = 300;

const PHONE_RE = /^[0-9]{9,10}$/;

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "จองคอร์ทแบดมินตัน | Court Booking" },
      {
        name: "description",
        content:
          "จองคอร์ทแบดมินตันออนไลน์ เลือกวันที่ คอร์ท และช่วงเวลา พร้อมยืนยันการจองทันที",
      },
      { property: "og:title", content: "จองคอร์ทแบดมินตัน | Court Booking" },
      {
        property: "og:description",
        content: "จองคอร์ทแบดมินตันออนไลน์ ง่ายและรวดเร็ว",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: BookingPage,
});

type FormState = {
  date: string; // ISO yyyy-MM-dd
  court: string | null;
  time: string | null;
  duration: 1 | 2;
  name: string;
  phone: string;
};

type SlotLock = { lockId: string; expiresAt: number };

type BookingResult = {
  ok: true;
  booking: {
    id: string;
    date: string;
    court: string;
    time: string;
    duration: 1 | 2;
    name: string;
    phone: string;
    status: "confirmed";
    createdAt: string;
  };
};

function BookingPage() {
  const today = useMemo(() => new Date(), []);
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(today, i)),
    [today],
  );

  const [form, setForm] = useState<FormState>({
    date: format(today, "yyyy-MM-dd"),
    court: null,
    time: null,
    name: "",
    phone: "",
  });

  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>(
    {},
  );
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<BookingResult | null>(null);
  const [modalOpen, setModalOpen] = useState(false);

  // Slot locking state.
  const [lock, setLock] = useState<SlotLock | null>(null);
  const [lockedTimes, setLockedTimes] = useState<string[]>([]);
  const [remainingMs, setRemainingMs] = useState(0);
  const lockRef = useRef<SlotLock | null>(null);
  lockRef.current = lock;

  const selectedDate = parseISO(form.date);

  const isFormValid =
    !!form.court &&
    !!form.time &&
    !!lock &&
    form.name.trim().length >= 2 &&
    PHONE_RE.test(form.phone.trim());

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: undefined }));
  }

  async function refreshLockedTimes(date: string, court: string | null) {
    if (!court) {
      setLockedTimes([]);
      return;
    }
    try {
      const res = await getLockedSlots({ data: { date, court } });
      setLockedTimes(res.lockedTimes);
    } catch {
      // ignore — mock API
    }
  }

  // Fetch locked slots whenever date / court changes.
  useEffect(() => {
    void refreshLockedTimes(form.date, form.court);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.date, form.court]);

  // Acquire / release the 5-minute slot lock when the selection changes.
  useEffect(() => {
    let cancelled = false;
    const prev = lockRef.current;

    async function run() {
      if (prev) {
        setLock(null);
        setRemainingMs(0);
        await releaseLock({ data: { lockId: prev.lockId } }).catch(() => {});
      }
      if (!form.date || !form.court || !form.time) return;

      try {
        const res = await lockSlot({
          data: { date: form.date, court: form.court, time: form.time },
        });
        if (cancelled) {
          if (res.ok) {
            await releaseLock({ data: { lockId: res.lockId } }).catch(
              () => {},
            );
          }
          return;
        }
        if (res.ok) {
          setLock({ lockId: res.lockId, expiresAt: res.expiresAt });
          setRemainingMs(res.expiresAt - Date.now());
        } else {
          // Someone else holds this slot.
          setForm((f) => ({ ...f, time: null }));
          setErrors((e) => ({
            ...e,
            time: "ช่วงเวลานี้เพิ่งถูกผู้ใช้อื่นเลือกไว้ กรุณาเลือกเวลาอื่น",
          }));
          void refreshLockedTimes(form.date, form.court);
        }
      } catch (err) {
        console.error(err);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.date, form.court, form.time]);

  // Countdown ticker — releases the selection when the lock expires.
  useEffect(() => {
    if (!lock) return;
    const tick = window.setInterval(() => {
      const r = lock.expiresAt - Date.now();
      if (r <= 0) {
        window.clearInterval(tick);
        setLock(null);
        setRemainingMs(0);
        setForm((f) => ({ ...f, time: null }));
        setErrors((e) => ({
          ...e,
          time: "หมดเวลาการล็อกคอร์ทชั่วคราวแล้ว กรุณาเลือกช่วงเวลาอีกครั้ง",
        }));
        void refreshLockedTimes(form.date, form.court);
      } else {
        setRemainingMs(r);
      }
    }, 500);
    return () => window.clearInterval(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lock]);

  function validate(): boolean {
    const next: Partial<Record<keyof FormState, string>> = {};
    if (!form.court) next.court = "กรุณาเลือกคอร์ท";
    if (!form.time) next.time = "กรุณาเลือกช่วงเวลา";
    if (form.name.trim().length < 2) next.name = "กรุณากรอกชื่อให้ถูกต้อง";
    if (!PHONE_RE.test(form.phone.trim()))
      next.phone = "เบอร์โทรศัพท์ต้องเป็นตัวเลข 9-10 หลัก";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;
    const currentLock = lockRef.current;
    if (!currentLock) {
      setErrors((e) => ({
        ...e,
        time: "กรุณาเลือกช่วงเวลาเพื่อล็อกคอร์ทก่อนยืนยัน",
      }));
      return;
    }
    setSubmitting(true);
    try {
      const payload = {
        date: form.date,
        court: form.court!,
        time: form.time!,
        lockId: currentLock.lockId,
        name: form.name.trim(),
        phone: form.phone.trim(),
      };
      const res = await createBooking({ data: payload });
      if (!res.ok) {
        setLock(null);
        setForm((f) => ({ ...f, time: null }));
        setErrors({ time: res.message });
        void refreshLockedTimes(form.date, form.court);
        return;
      }
      setLock(null);
      setRemainingMs(0);
      setResult(res);
      setModalOpen(true);
      void refreshLockedTimes(form.date, form.court);
    } catch (err) {
      setErrors({
        name: "ไม่สามารถยืนยันการจองได้ กรุณาลองอีกครั้ง",
      });
      console.error(err);
    } finally {
      setSubmitting(false);
    }
  }

  // JSON shown in the modal "mock API payload" panel.
  const requestPayload = useMemo(
    () =>
      JSON.stringify(
        {
          date: form.date,
          court: form.court,
          time: form.time,
          name: form.name.trim(),
          phone: form.phone.trim(),
        },
        null,
        2,
      ),
    [form],
  );

  const responsePayload = useMemo(
    () => (result ? JSON.stringify(result, null, 2) : ""),
    [result],
  );

  const countdown = useMemo(() => {
    const total = Math.max(0, Math.ceil(remainingMs / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, [remainingMs]);

  const urgent = lock !== null && remainingMs <= 60_000;

  return (
    <div className="min-h-screen bg-surface text-ink-fg court-grid">
      <div className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-12">
        <Header />

        <div className="mt-8 space-y-6">
          {/* Date */}
          <Section
            icon={<CalendarDays className="h-4 w-4" />}
            step={1}
            title="เลือกวันที่"
            error={errors.date}
          >
            <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-2">
              {days.map((day) => {
                const iso = format(day, "yyyy-MM-dd");
                const selected = iso === form.date;
                const isToday = isSameDay(day, today);
                return (
                  <button
                    key={iso}
                    type="button"
                    onClick={() => update("date", iso)}
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
                      {isToday ? "วันนี้" : format(day, "MMM", { locale: thLocale })}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="mt-1 text-xs text-ink-muted">
              {format(selectedDate, "EEEEที่ d MMMM yyyy", { locale: thLocale })}
            </p>
          </Section>

          {/* Court */}
          <Section
            icon={<MapPin className="h-4 w-4" />}
            step={2}
            title="เลือกคอร์ท"
            error={errors.court}
          >
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              {COURTS.map((court) => {
                const selected = form.court === court;
                return (
                  <button
                    key={court}
                    type="button"
                    onClick={() => update("court", court)}
                    className={cn(
                      "group relative flex flex-col items-center gap-2 rounded-xl border p-5 transition-all",
                      selected
                        ? "border-neon bg-neon-soft neon-glow"
                        : "border-ink-border bg-ink hover:border-neon/50",
                    )}
                  >
                    <div
                      className={cn(
                        "flex h-11 w-11 items-center justify-center rounded-lg text-sm font-black",
                        selected
                          ? "bg-neon text-neon-foreground"
                          : "bg-ink-soft text-ink-fg",
                      )}
                    >
                      {court.replace("คอร์ท ", "")}
                    </div>
                    <span className="text-sm font-semibold">{court}</span>
                    {selected && (
                      <span className="absolute right-2 top-2 text-neon">
                        <CheckCircle2 className="h-4 w-4" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </Section>

          {/* Time */}
          <Section
            icon={<Clock className="h-4 w-4" />}
            step={3}
            title="เลือกช่วงเวลา"
            error={errors.time}
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {TIME_SLOTS.map((time) => {
                const selected = form.time === time;
                const taken = lockedTimes.includes(time) && !selected;
                return (
                  <button
                    key={time}
                    type="button"
                    disabled={taken}
                    onClick={() => update("time", time)}
                    className={cn(
                      "relative rounded-xl border py-3 text-center font-semibold transition-all",
                      selected
                        ? "border-neon bg-neon text-neon-foreground neon-glow"
                        : taken
                          ? "cursor-not-allowed border-ink-border bg-ink/50 text-ink-muted line-through opacity-60"
                          : "border-ink-border bg-ink hover:border-neon/50",
                    )}
                  >
                    {time}
                    {taken && (
                      <span className="absolute right-1.5 top-1.5">
                        <Lock className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <p className="mt-2 text-xs text-ink-muted">
              เมื่อเลือกเวลา ระบบจะล็อกคอร์ทไว้ให้ 5 นาทีเพื่อกรอกและยืนยันข้อมูล
            </p>
          </Section>

          {/* Countdown banner */}
          {lock && form.time && (
            <div
              className={cn(
                "flex items-center justify-between gap-3 rounded-2xl border p-4 transition-colors",
                urgent
                  ? "border-destructive bg-destructive/10"
                  : "border-neon bg-neon-soft neon-glow",
              )}
              role="status"
            >
              <div className="flex items-center gap-3">
                <span
                  className={cn(
                    "flex h-10 w-10 items-center justify-center rounded-xl",
                    urgent
                      ? "bg-destructive text-destructive-foreground"
                      : "bg-neon text-neon-foreground",
                  )}
                >
                  <Timer className="h-5 w-5" />
                </span>
                <div>
                  <p className="text-sm font-bold">
                    ล็อก {form.court} · เวลา {form.time} ไว้แล้ว
                  </p>
                  <p className="text-xs text-ink-muted">
                    กรุณากรอกข้อมูลและยืนยันการจองภายในเวลาที่กำหนด
                  </p>
                </div>
              </div>
              <div
                className={cn(
                  "font-mono text-2xl font-black tabular-nums",
                  urgent ? "text-destructive" : "text-neon neon-text",
                )}
              >
                {countdown}
              </div>
            </div>
          )}

          {/* Form */}
          <Section
            icon={<User className="h-4 w-4" />}
            step={4}
            title="ข้อมูลผู้จอง"
          >
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name" className="text-ink-fg/80">
                  ชื่อ – นามสกุล
                </Label>
                <div className="relative">
                  <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                  <Input
                    id="name"
                    value={form.name}
                    onChange={(e) => update("name", e.target.value)}
                    placeholder="เช่น สมชาย ใจดี"
                    className={cn(
                      "border-ink-border bg-ink pl-9 text-ink-fg placeholder:text-ink-muted focus-visible:border-neon focus-visible:ring-neon/40",
                      errors.name && "border-destructive",
                    )}
                  />
                </div>
                {errors.name && (
                  <p className="text-xs text-destructive">{errors.name}</p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="phone" className="text-ink-fg/80">
                  เบอร์โทรศัพท์
                </Label>
                <div className="relative">
                  <Phone className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted" />
                  <Input
                    id="phone"
                    inputMode="numeric"
                    value={form.phone}
                    onChange={(e) =>
                      update(
                        "phone",
                        e.target.value.replace(/[^0-9]/g, "").slice(0, 10),
                      )
                    }
                    placeholder="0812345678"
                    className={cn(
                      "border-ink-border bg-ink pl-9 text-ink-fg placeholder:text-ink-muted focus-visible:border-neon focus-visible:ring-neon/40",
                      errors.phone && "border-destructive",
                    )}
                  />
                </div>
                {errors.phone && (
                  <p className="text-xs text-destructive">{errors.phone}</p>
                )}
              </div>
            </div>
          </Section>

          {/* Summary + submit */}
          <div className="rounded-2xl border border-ink-border bg-ink p-5">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
              <SummaryItem label="วันที่" value={format(selectedDate, "d MMM yyyy", { locale: thLocale })} />
              <SummaryItem label="คอร์ท" value={form.court ?? "—"} />
              <SummaryItem label="เวลา" value={form.time ?? "—"} />
              <SummaryItem label="ราคา" value="฿300 / ชม." />
            </div>
            <Button
              type="button"
              size="lg"
              onClick={handleSubmit}
              disabled={!isFormValid || submitting}
              className="mt-5 w-full bg-neon text-neon-foreground font-bold hover:bg-neon/90 neon-glow disabled:shadow-none"
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  กำลังยืนยันการจอง...
                </>
              ) : (
                <>
                  <CheckCircle2 className="h-4 w-4" />
                  ยืนยันการจอง
                  {lock && (
                    <span className="font-mono text-sm font-bold tabular-nums opacity-80">
                      ({countdown})
                    </span>
                  )}
                </>
              )}
            </Button>
            {!isFormValid && !submitting && (
              <p className="mt-2 text-center text-xs text-ink-muted">
                * กรุณาเลือกคอร์ท ช่วงเวลา และกรอกข้อมูลให้ครบ
              </p>
            )}
          </div>
        </div>

        <p className="mt-8 text-center text-xs text-ink-muted">
          © {new Date().getFullYear()} Court Booking · ระบบจองคอร์ทแบดมินตัน
        </p>
      </div>

      <BookingDialog
        open={modalOpen}
        onOpenChange={setModalOpen}
        result={result}
        requestPayload={requestPayload}
        responsePayload={responsePayload}
      />
    </div>
  );
}

function Header() {
  return (
    <header className="flex flex-col items-start gap-3">
      <div className="flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-neon text-neon-foreground neon-glow">
          <Rocket className="h-5 w-5" />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-neon neon-text">
            Smash Court
          </p>
          <h1 className="text-2xl font-black leading-tight sm:text-3xl">
            จองคอร์ทแบดมินตัน
          </h1>
        </div>
      </div>
      <p className="text-sm text-ink-muted">
        เลือกวัน คอร์ท และช่วงเวลาที่ต้องการ แล้วยืนยันการจองได้ทันที
      </p>
    </header>
  );
}

function Section({
  icon,
  step,
  title,
  error,
  children,
}: {
  icon: React.ReactNode;
  step: number;
  title: string;
  error?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-ink-border bg-ink/80 p-5 backdrop-blur">
      <div className="mb-4 flex items-center gap-2">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-neon text-xs font-bold text-neon-foreground">
          {step}
        </span>
        <span className="flex items-center gap-1.5 text-sm font-semibold text-ink-fg">
          {icon}
          {title}
        </span>
      </div>
      {children}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </section>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <span className="font-semibold text-ink-fg">{value}</span>
    </div>
  );
}

function BookingDialog({
  open,
  onOpenChange,
  result,
  requestPayload,
  responsePayload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  result: BookingResult | null;
  requestPayload: string;
  responsePayload: string;
}) {
  const b = result?.booking;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg border-ink-border bg-surface text-ink-fg">
        <DialogHeader>
          <div className="mx-auto mb-1 flex h-12 w-12 items-center justify-center rounded-full bg-neon text-neon-foreground neon-glow">
            <CheckCircle2 className="h-6 w-6" />
          </div>
          <DialogTitle className="text-center text-xl font-black">
            ยืนยันการจองสำเร็จ
          </DialogTitle>
          <DialogDescription className="text-center text-ink-muted">
            รายละเอียดการจองของคุณ
          </DialogDescription>
        </DialogHeader>

        {b && (
          <div className="space-y-3">
            <div className="rounded-xl border border-ink-border bg-ink p-4">
              <div className="grid grid-cols-2 gap-3 text-sm">
                <DetailRow label="รหัสการจอง" value={b.id} highlight />
                <DetailRow
                  label="สถานะ"
                  value={
                    <span className="rounded-full bg-neon-soft px-2 py-0.5 text-xs font-semibold text-neon">
                      {b.status}
                    </span>
                  }
                />
                <DetailRow
                  label="วันที่"
                  value={format(parseISO(b.date), "d MMM yyyy", {
                    locale: thLocale,
                  })}
                />
                <DetailRow label="คอร์ท" value={b.court} />
                <DetailRow label="เวลา" value={`${b.time} น.`} />
                <DetailRow label="ราคา" value="฿300" />
                <DetailRow label="ชื่อผู้จอง" value={b.name} />
                <DetailRow label="เบอร์โทร" value={b.phone} />
              </div>
            </div>

            <JsonBlock
              label="Request · mock API payload"
              payload={requestPayload}
            />
            <JsonBlock label="Response · 200 OK" payload={responsePayload} />
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="border-ink-border bg-ink text-ink-fg hover:bg-ink-soft"
          >
            ปิด
          </Button>
          <Button
            onClick={() => onOpenChange(false)}
            className="bg-neon text-neon-foreground font-semibold hover:bg-neon/90 neon-glow"
          >
            เสร็จสิ้น
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide text-ink-muted">
        {label}
      </span>
      <span
        className={cn(
          "font-semibold",
          highlight && "font-mono text-neon neon-text",
        )}
      >
        {value}
      </span>
    </div>
  );
}

function JsonBlock({ label, payload }: { label: string; payload: string }) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-muted">
        {label}
      </p>
      <pre className="max-h-48 overflow-auto rounded-lg border border-ink-border bg-ink p-3 text-[11px] leading-relaxed text-neon">
        <code>{payload || "—"}</code>
      </pre>
    </div>
  );
}
