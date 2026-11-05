import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';

export interface User {
  id: string;
  email: string;
  name: string | null;
  default_currency: string;
  email_verified: boolean;
  created_at: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  guestTrips: number;
  refresh: () => Promise<void>;
  setUser: (user: User | null) => void;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({ user: null, loading: true, guestTrips: 0, refresh: async () => undefined, setUser: () => undefined, logout: async () => undefined });
export const useAuth = () => useContext(AuthContext);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [guestTrips, setGuestTrips] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await api<{ user: User | null; guestTrips: number }>('/auth/me');
      setUser(me.user);
      setGuestTrips(me.guestTrips);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    setUser(null);
    setGuestTrips(0);
  }, []);

  return <AuthContext.Provider value={{ user, loading, guestTrips, refresh, setUser, logout }}>{children}</AuthContext.Provider>;
}
