export interface Env {
  DB: D1Database;
  ASSETS?: Fetcher;
  EMAIL?: SendEmail;
  // Administrator-managed runtime configuration (never set by this repo).
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_MAPS_API_KEY?: string;
  EMAIL_FROM?: string;
  APP_PUBLIC_URL?: string;
}

export interface Actor {
  kind: "user" | "guest";
  userId: string | null;
  guestId: string | null;
}

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  emailVerified: boolean;
}

export interface SessionAdmin {
  id: string;
  username: string;
  mustChangePassword: boolean;
}

export type AppBindings = {
  Bindings: Env;
  Variables: {
    user: SessionUser | null;
    sessionHash: string | null;
    guestId: string | null;
    admin: SessionAdmin | null;
    adminSessionHash: string | null;
  };
};
