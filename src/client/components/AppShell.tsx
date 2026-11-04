import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { ChevronDown, LogOut, Map, Plus, Settings, User as UserIcon } from "lucide-react";
import { api, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Logo, cx, useToast } from "./ui";

export function AppShell({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const loc = useLocation();
  const fullBleed = loc.pathname.startsWith("/trips/");
  return (
    <div className={cx("flex flex-col", fullBleed ? "h-dvh" : "min-h-dvh")}>
      <header className="sticky top-0 z-[500] border-b border-slate-200/70 bg-white/85 backdrop-blur supports-[backdrop-filter]:bg-white/70">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4 sm:px-6">
          <Link to="/" className="shrink-0" aria-label="AI Travel Planner home">
            <Logo />
          </Link>
          <nav className="ml-4 hidden items-center gap-1 sm:flex" aria-label="Main">
            <NavLink
              to="/trips"
              className={({ isActive }) => cx("rounded-lg px-3 py-1.5 text-sm font-medium", isActive ? "bg-brand-50 text-brand-800" : "text-slate-600 hover:text-slate-900")}
            >
              My trips
            </NavLink>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Link to="/" className="hidden sm:block">
              <Button size="sm" icon={<Plus className="size-4" />}>
                New trip
              </Button>
            </Link>
            <Link to="/trips" className="sm:hidden">
              <Button size="sm" variant="ghost" icon={<Map className="size-4" />} aria-label="My trips" />
            </Link>
            {user ? (
              <UserMenu />
            ) : (
              <>
                <Link to="/login">
                  <Button size="sm" variant="ghost">
                    Sign in
                  </Button>
                </Link>
                <Link to="/register" className="hidden sm:block">
                  <Button size="sm" variant="secondary">
                    Create account
                  </Button>
                </Link>
              </>
            )}
          </div>
        </div>
        <VerifyBanner />
      </header>
      <main className={cx("flex-1", fullBleed && "min-h-0")}>{children}</main>
    </div>
  );
}

function VerifyBanner() {
  const { user } = useSession();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState(false);
  if (!user || user.emailVerified || hidden) return null;
  return (
    <div className="border-t border-amber-200 bg-amber-50 text-amber-900">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-sm sm:px-6">
        <span>
          Please verify <strong>{user.email}</strong> — check your inbox for the link.
        </span>
        <button
          className="font-semibold underline underline-offset-2 disabled:opacity-60"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ message?: string }>("/api/auth/resend-verification", { body: {} });
              toast(r.message ?? "Verification email sent.");
            } catch (e) {
              toast(errorMessage(e), "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Sending…" : "Resend email"}
        </button>
        <button className="ml-auto text-amber-700 hover:text-amber-900" onClick={() => setHidden(true)} aria-label="Dismiss">
          Dismiss
        </button>
      </div>
    </div>
  );
}

function UserMenu() {
  const { user, setUser, refresh } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const nav = useNavigate();
  const toast = useToast();
  useEffect(() => {
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  if (!user) return null;
  const initials = (user.displayName || user.email).slice(0, 1).toUpperCase();
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 rounded-full p-0.5 pr-2 hover:bg-slate-100"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-gradient-to-br from-brand-500 to-cyan-700 text-sm font-semibold text-white">{initials}</span>
        <ChevronDown className="size-4 text-slate-500" />
      </button>
      {open && (
        <div role="menu" className="animate-fade-up absolute right-0 mt-2 w-60 overflow-hidden rounded-xl bg-white py-1 shadow-lift ring-1 ring-slate-200">
          <div className="border-b border-slate-100 px-4 py-2.5">
            <p className="truncate text-sm font-medium text-slate-900">{user.displayName || "Traveler"}</p>
            <p className="truncate text-xs text-slate-500">{user.email}</p>
          </div>
          <Link role="menuitem" to="/trips" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
            <Map className="size-4" /> My trips
          </Link>
          <Link role="menuitem" to="/account" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
            <Settings className="size-4" /> Account settings
          </Link>
          <button
            role="menuitem"
            className="flex w-full items-center gap-2 px-4 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
            onClick={async () => {
              try {
                await api("/api/auth/logout", { body: {} });
                setUser(null);
                await refresh();
                toast("Signed out.", "info");
                nav("/");
              } catch (e) {
                toast(errorMessage(e), "error");
              }
            }}
          >
            <LogOut className="size-4" /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function UserIconBadge() {
  return <UserIcon className="size-4" />;
}
