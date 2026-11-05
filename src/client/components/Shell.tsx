import { useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { Compass, LogOut, Map, Menu, User as UserIcon, X } from 'lucide-react';
import { useAuth } from '../auth';
import { Button, IconButton, Logo, useToast } from '../ui';

const navClass = ({ isActive }: { isActive: boolean }) => `flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-sand text-ink' : 'text-ink-soft hover:text-ink hover:bg-sand/60'}`;

export function UserMenu({ compact }: { compact?: boolean }) {
  const { user, loading, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  if (loading) return <div className="h-9 w-24" aria-hidden />;
  if (!user) {
    return (
      <div className="flex items-center gap-2">
        <Link to="/login" className="rounded-lg px-3 py-2 text-sm font-medium text-ink-soft hover:text-ink">Log in</Link>
        {!compact && <Link to="/register" className="rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white hover:bg-teal">Sign up</Link>}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1">
      <NavLink to="/account" className={navClass}>
        <UserIcon className="size-4" aria-hidden />
        <span className="hidden max-w-36 truncate sm:inline">{user.name ?? user.email}</span>
      </NavLink>
      <IconButton
        label="Log out"
        onClick={async () => {
          await logout();
          toast('You have been logged out.');
          navigate('/');
        }}
      >
        <LogOut className="size-4" />
      </IconButton>
    </div>
  );
}

export function Shell() {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-h-full flex-col">
      <header className="sticky top-0 z-[1000] border-b border-line/70 bg-paper/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6">
          <div className="flex items-center gap-6">
            <Link to="/" aria-label="AI Travel Planner home"><Logo /></Link>
            <nav aria-label="Main" className="hidden items-center gap-1 md:flex">
              <NavLink to="/trips" className={navClass}><Map className="size-4" aria-hidden />My trips</NavLink>
              <NavLink to="/explore" className={navClass}><Compass className="size-4" aria-hidden />Explore</NavLink>
            </nav>
          </div>
          <div className="hidden md:block"><UserMenu /></div>
          <IconButton label={open ? 'Close menu' : 'Open menu'} className="md:hidden" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <X className="size-5" /> : <Menu className="size-5" />}
          </IconButton>
        </div>
        {open && (
          <nav aria-label="Mobile" className="space-y-1 border-t border-line px-4 py-3 md:hidden" onClick={() => setOpen(false)}>
            <NavLink to="/trips" className={navClass}><Map className="size-4" aria-hidden />My trips</NavLink>
            <NavLink to="/explore" className={navClass}><Compass className="size-4" aria-hidden />Explore</NavLink>
            <UserMenu />
          </nav>
        )}
      </header>
      <main className="flex-1"><Outlet /></main>
      <footer className="border-t border-line/70 px-6 py-6 text-center text-[13px] text-muted">
        AI suggestions and costs are estimates. Check details with official sources before you book.
      </footer>
    </div>
  );
}

export { Button };
