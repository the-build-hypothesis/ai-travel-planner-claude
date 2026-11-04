import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api } from "./api";

export interface User {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
}

interface SessionState {
  loading: boolean;
  user: User | null;
  guest: boolean;
  features: { places: boolean; email: boolean };
  refresh: () => Promise<void>;
  setUser: (u: User | null) => void;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [user, setUser] = useState<User | null>(null);
  const [guest, setGuest] = useState(false);
  const [features, setFeatures] = useState({ places: false, email: false });
  const refresh = useCallback(async () => {
    try {
      const r = await api<{ user: User | null; guest: boolean; features: { places: boolean; email: boolean } }>("/api/me");
      setUser(r.user);
      setGuest(r.guest);
      setFeatures(r.features);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return <Ctx.Provider value={{ loading, user, guest, features, refresh, setUser }}>{children}</Ctx.Provider>;
}

export function useSession(): SessionState {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside provider");
  return v;
}
