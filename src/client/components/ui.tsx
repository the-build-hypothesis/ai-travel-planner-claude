import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, X } from "lucide-react";

export function cx(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(" ");
}

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline";
const variants: Record<Variant, string> = {
  primary: "bg-brand-700 text-white hover:bg-brand-800 shadow-sm disabled:bg-brand-700/60",
  secondary: "bg-white text-slate-800 ring-1 ring-slate-200 hover:bg-slate-50 hover:ring-slate-300 shadow-sm",
  outline: "bg-transparent text-brand-800 ring-1 ring-brand-300 hover:bg-brand-50",
  ghost: "bg-transparent text-slate-600 hover:bg-slate-100 hover:text-slate-900",
  danger: "bg-red-600 text-white hover:bg-red-700 shadow-sm disabled:bg-red-600/60",
};

export function Button({
  variant = "primary",
  size = "md",
  loading,
  icon,
  className,
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg"; loading?: boolean; icon?: ReactNode }) {
  const sizes = { sm: "h-8 px-3 text-sm gap-1.5 rounded-lg", md: "h-10 px-4 text-sm gap-2 rounded-xl", lg: "h-12 px-6 text-base gap-2 rounded-xl" };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex items-center justify-center font-medium transition-colors disabled:cursor-not-allowed whitespace-nowrap",
        variants[variant],
        sizes[size],
        className,
      )}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: ReactNode; children: ReactNode; htmlFor: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-slate-700">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

const inputBase =
  "block w-full rounded-xl border-0 bg-white px-3.5 py-2.5 text-slate-900 ring-1 ring-inset ring-slate-200 placeholder:text-slate-400 focus:ring-2 focus:ring-inset focus:ring-brand-500 focus:outline-none text-sm transition-shadow";

export function Input({ label, error, hint, className, id, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: string; hint?: ReactNode }) {
  const auto = useId();
  const inputId = id ?? auto;
  const input = <input id={inputId} aria-invalid={Boolean(error)} {...rest} className={cx(inputBase, error && "ring-red-400", className)} />;
  if (!label) return input;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={inputId}>
      {input}
    </Field>
  );
}

export function Textarea({ label, error, className, id, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: string; error?: string }) {
  const auto = useId();
  const inputId = id ?? auto;
  const el = <textarea id={inputId} {...rest} className={cx(inputBase, "resize-none", className)} />;
  if (!label) return el;
  return (
    <Field label={label} error={error} htmlFor={inputId}>
      {el}
    </Field>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-2xl bg-white ring-1 ring-slate-200/80 shadow-soft", className)}>{children}</div>;
}

type Tone = "slate" | "brand" | "amber" | "red" | "green" | "blue" | "violet";
const tones: Record<Tone, string> = {
  slate: "bg-slate-100 text-slate-700 ring-slate-200",
  brand: "bg-brand-50 text-brand-800 ring-brand-200",
  amber: "bg-amber-50 text-amber-800 ring-amber-200",
  red: "bg-red-50 text-red-700 ring-red-200",
  green: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  blue: "bg-sky-50 text-sky-700 ring-sky-200",
  violet: "bg-violet-50 text-violet-700 ring-violet-200",
};
export function Badge({ tone = "slate", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx("animate-spin text-brand-600", className ?? "size-5")} aria-label="Loading" />;
}

export function PageLoader({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="flex min-h-[40vh] flex-col items-center justify-center gap-3 text-slate-500" role="status">
      <Spinner className="size-7" />
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function Alert({ tone = "red", title, children, className }: { tone?: "red" | "amber" | "green" | "blue"; title?: string; children?: ReactNode; className?: string }) {
  const map = {
    red: ["bg-red-50 ring-red-200 text-red-800", AlertTriangle],
    amber: ["bg-amber-50 ring-amber-200 text-amber-900", AlertTriangle],
    green: ["bg-emerald-50 ring-emerald-200 text-emerald-800", CheckCircle2],
    blue: ["bg-sky-50 ring-sky-200 text-sky-900", Info],
  } as const;
  const [cls, Icon] = map[tone];
  return (
    <div className={cx("flex gap-3 rounded-xl p-3.5 ring-1 ring-inset text-sm", cls, className)} role={tone === "red" ? "alert" : "status"}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="space-y-0.5">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-300 bg-white/60 px-6 py-12 text-center">
      {icon && <div className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-brand-700">{icon}</div>}
      <h3 className="text-base font-semibold text-slate-900">{title}</h3>
      {children && <div className="mt-1 max-w-sm text-sm text-slate-500">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, size = "md" }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; size?: "sm" | "md" | "lg" | "xl" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    setTimeout(() => ref.current?.querySelector<HTMLElement>("input,textarea,button,select")?.focus(), 30);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  const widths = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" };
  return (
    <div className="fixed inset-0 z-[1000] flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} className={cx("animate-fade-up relative w-full rounded-t-2xl bg-white shadow-lift sm:rounded-2xl max-h-[92vh] flex flex-col", widths[size])}>
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h2 className="text-base font-semibold text-slate-900">{title}</h2>
          <button onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close">
            <X className="size-5" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 scrollbar-thin">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

/** Confirmation dialog for destructive operations; optionally requires typing a phrase. */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  children,
  confirmLabel = "Confirm",
  requireText,
  busy,
  error,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: (typed: string) => void;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  requireText?: string;
  busy?: boolean;
  error?: string | null;
}) {
  const [typed, setTyped] = useState("");
  useEffect(() => {
    if (open) setTyped("");
  }, [open]);
  const ok = !requireText || typed.trim().toLowerCase() === requireText.toLowerCase();
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => onConfirm(typed)} disabled={!ok} loading={busy}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-slate-600">
        {children}
        {requireText && (
          <Input label={`Type “${requireText}” to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    </Modal>
  );
}

// ───────────── Toasts ─────────────
interface Toast {
  id: number;
  tone: "success" | "error" | "info";
  message: string;
}
const ToastCtx = createContext<(message: string, tone?: Toast["tone"]) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast["tone"] = "success") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[1100] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "animate-fade-up pointer-events-auto flex max-w-md items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lift",
              t.tone === "error" ? "bg-red-600 text-white" : t.tone === "info" ? "bg-slate-900 text-white" : "bg-brand-800 text-white",
            )}
          >
            {t.tone === "error" ? <AlertTriangle className="size-4" /> : <CheckCircle2 className="size-4" />}
            {t.message}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Select({ label, className, id, children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement> & { label?: string }) {
  const auto = useId();
  const sid = id ?? auto;
  const el = (
    <select id={sid} {...rest} className={cx(/(^|\s)w-/.test(className ?? "") ? inputBase.replace("w-full", "") : inputBase, "pr-8", className)}>
      {children}
    </select>
  );
  if (!label) return el;
  return (
    <Field label={label} htmlFor={sid}>
      {el}
    </Field>
  );
}

export function Logo({ className, light }: { className?: string; light?: boolean }) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-semibold tracking-tight", light ? "text-white" : "text-slate-900", className)}>
      <svg viewBox="0 0 64 64" className="size-8" aria-hidden>
        <defs>
          <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#14b8a6" />
            <stop offset="1" stopColor="#0e7490" />
          </linearGradient>
        </defs>
        <rect width="64" height="64" rx="16" fill="url(#lg)" />
        <path d="M18 40l28-14-9 22-5-8-14 0z" fill="#fff" />
      </svg>
      <span className="text-[15px]">AI Travel Planner</span>
    </span>
  );
}
