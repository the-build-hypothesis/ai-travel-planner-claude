import { createContext, useCallback, useContext, useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-deep shadow-sm',
  secondary: 'bg-surface text-ink border border-line hover:bg-sand',
  ghost: 'text-ink-soft hover:bg-sand hover:text-ink',
  danger: 'bg-danger text-white hover:bg-[#8f1e18]',
};

export function Button({ variant = 'primary', size = 'md', loading, children, className = '', disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }) {
  const sizes = { sm: 'px-3 py-1.5 text-[13px] gap-1.5', md: 'px-4 py-2.5 text-sm gap-2', lg: 'px-6 py-3.5 text-base gap-2' };
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center rounded-xl font-semibold transition-colors disabled:opacity-55 disabled:cursor-not-allowed cursor-pointer ${sizes[size]} ${VARIANTS[variant]} ${className}`}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function IconButton({ label, children, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} {...rest} className={`inline-grid place-items-center size-9 rounded-lg text-muted hover:bg-sand hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${className}`}>
      {children}
    </button>
  );
}

const inputClass = 'w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-[15px] text-ink placeholder:text-muted/80 focus:border-teal focus:outline-none focus:ring-2 focus:ring-teal/20 aria-[invalid=true]:border-danger';

interface FieldProps {
  label: string;
  error?: string;
  hint?: ReactNode;
}

export function Field({ label, error, hint, id, ...rest }: FieldProps & InputHTMLAttributes<HTMLInputElement>) {
  const fieldId = id ?? `f-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div>
      <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium text-ink">{label}</label>
      <input id={fieldId} aria-invalid={Boolean(error)} aria-describedby={error ? `${fieldId}-err` : undefined} {...rest} className={inputClass} />
      {hint && !error && <p className="mt-1.5 text-[13px] text-muted">{hint}</p>}
      {error && <p id={`${fieldId}-err`} className="mt-1.5 text-[13px] text-danger">{error}</p>}
    </div>
  );
}

export function TextArea({ label, error, hint, id, ...rest }: FieldProps & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const fieldId = id ?? `f-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div>
      <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium text-ink">{label}</label>
      <textarea id={fieldId} aria-invalid={Boolean(error)} {...rest} className={inputClass} />
      {hint && !error && <p className="mt-1.5 text-[13px] text-muted">{hint}</p>}
      {error && <p className="mt-1.5 text-[13px] text-danger">{error}</p>}
    </div>
  );
}

export function Select({ label, error, id, children, ...rest }: FieldProps & SelectHTMLAttributes<HTMLSelectElement>) {
  const fieldId = id ?? `f-${label.toLowerCase().replace(/\W+/g, '-')}`;
  return (
    <div>
      <label htmlFor={fieldId} className="mb-1.5 block text-sm font-medium text-ink">{label}</label>
      <select id={fieldId} aria-invalid={Boolean(error)} {...rest} className={inputClass}>{children}</select>
      {error && <p className="mt-1.5 text-[13px] text-danger">{error}</p>}
    </div>
  );
}

export function Alert({ tone = 'error', children }: { tone?: 'error' | 'success' | 'info'; children: ReactNode }) {
  const tones = {
    error: 'bg-danger-soft text-danger',
    success: 'bg-verified-soft text-verified',
    info: 'bg-teal-soft text-teal',
  };
  const Icon = tone === 'success' ? CheckCircle2 : AlertCircle;
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={`flex items-start gap-2.5 rounded-xl px-3.5 py-3 text-sm ${tones[tone]}`}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2.5 py-16 text-muted">
      <Loader2 className="size-5 animate-spin" aria-hidden />
      <span className="text-sm">{label}…</span>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mx-auto max-w-md px-6 py-14 text-center">
      {icon && <div className="mx-auto mb-4 grid size-14 place-items-center rounded-2xl bg-sand text-teal">{icon}</div>}
      <h3 className="text-xl font-semibold">{title}</h3>
      {children && <div className="mt-2 text-[15px] leading-relaxed text-ink-soft">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`m-auto w-[calc(100%-2rem)] ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-2xl border-0 bg-surface p-0 text-ink shadow-lift`}
    >
      <div className="flex items-center justify-between gap-4 border-b border-line px-5 py-4">
        <h2 className="text-lg font-semibold">{title}</h2>
        <IconButton label="Close" onClick={onClose}><X className="size-4.5" /></IconButton>
      </div>
      <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}

/** Confirmation dialog. With `confirmText`, the exact text must be typed to enable the action. */
export function ConfirmDialog({ title, body, actionLabel, onConfirm, onClose, confirmText, danger = true }: { title: string; body: ReactNode; actionLabel: string; onConfirm: () => Promise<void> | void; onClose: () => void; confirmText?: string; danger?: boolean }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = confirmText !== undefined && typed.trim().toLowerCase() !== confirmText.toLowerCase();
  return (
    <Modal title={title} onClose={onClose}>
      <div className="space-y-4">
        <div className="text-[15px] leading-relaxed text-ink-soft">{body}</div>
        {confirmText !== undefined && <Field label={`Type ${confirmText} to confirm`} id="confirm-text" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
        {error && <Alert>{error}</Alert>}
        <div className="flex justify-end gap-2.5">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={blocked}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                setError((err as Error).message);
                setBusy(false);
              }
            }}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

interface Toast {
  id: number;
  message: string;
  tone: 'success' | 'error';
  action?: { label: string; run: () => void };
}

const ToastContext = createContext<(message: string, tone?: 'success' | 'error', action?: Toast['action']) => void>(() => undefined);
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const push = useCallback((message: string, tone: 'success' | 'error' = 'success', action?: Toast['action']) => {
    const id = ++counter.current;
    setToasts((t) => [...t, { id, message, tone, action }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), action ? 8000 : 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-20 z-[2000] flex flex-col items-center gap-2 px-4 lg:bottom-6">
        {toasts.map((t) => (
          <div key={t.id} className={`rise pointer-events-auto flex max-w-md items-center gap-3 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lift ${t.tone === 'error' ? 'bg-danger' : 'bg-ink'}`}>
            <span>{t.message}</span>
            {t.action && (
              <button type="button" className="cursor-pointer font-semibold underline underline-offset-2" onClick={() => { t.action!.run(); setToasts((all) => all.filter((x) => x.id !== t.id)); }}>
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const list = window.matchMedia(query);
    const handler = () => setMatches(list.matches);
    list.addEventListener('change', handler);
    handler();
    return () => list.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

/** Layered landscape used wherever a real photo is not available. The seed keeps a trip's art stable. */
const SCENES = [
  ['#f6c99b', '#e88d67', '#b5533c', '#6e2f35'],
  ['#bfe3e0', '#6fb7bd', '#2f7f8d', '#0f4c5c'],
  ['#f8dcc4', '#e4a7a0', '#9c6b98', '#4b3f72'],
  ['#dfe8c9', '#a4c49a', '#5f9173', '#2c5d55'],
  ['#fbe3a8', '#f2b463', '#d9743f', '#7d3c32'],
];

export function SceneArt({ seed, className = '' }: { seed: string; className?: string }) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const [sky, far, mid, near] = SCENES[hash % SCENES.length];
  const sunX = 60 + (hash % 280);
  const gradId = `sky-${hash}`;
  return (
    <svg viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" className={className} aria-hidden>
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#fffaf2" />
          <stop offset="1" stopColor={sky} />
        </linearGradient>
      </defs>
      <rect width="400" height="200" fill={`url(#${gradId})`} />
      <circle cx={sunX} cy="72" r="26" fill="#fff" opacity="0.72" />
      <path d="M0 130 C60 90 110 120 170 100 S290 70 400 112 V200 H0Z" fill={far} />
      <path d="M0 158 C80 118 150 160 230 132 S340 118 400 146 V200 H0Z" fill={mid} />
      <path d="M0 182 C90 150 170 188 260 164 S360 160 400 176 V200 H0Z" fill={near} />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2.5">
      <svg viewBox="0 0 32 32" className="size-8" aria-hidden>
        <rect width="32" height="32" rx="9" fill="var(--color-accent)" />
        <path d="M16 6a7.5 7.5 0 0 0-7.5 7.5C8.5 19 16 26 16 26s7.5-7 7.5-12.5A7.5 7.5 0 0 0 16 6Z" fill="#fff" />
        <circle cx="16" cy="13.5" r="2.8" fill="var(--color-accent)" />
      </svg>
      <span className="font-display text-[19px] font-semibold tracking-tight">AI Travel Planner</span>
    </span>
  );
}
