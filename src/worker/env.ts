export interface EmailBinding {
  send(message: {
    to: string;
    from: string | { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
  }): Promise<{ messageId: string }>;
}

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  EMAIL?: EmailBinding;
  EMAIL_FROM?: string;
  APP_PUBLIC_URL?: string;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  OPENAI_API_KEY?: string;
  GOOGLE_MAPS_API_KEY?: string;
}

export interface UserRow {
  id: string;
  email: string;
  name: string | null;
  default_currency: string;
  status: string;
  email_verified_at: string | null;
  created_at: string;
}

export interface AdminRow {
  id: string;
  username: string;
  status: string;
  must_change_password: number;
  created_at: string;
}

/** The owner of a request's trips and the party billable usage is attributed to. */
export type Principal = { type: 'user'; id: string } | { type: 'guest'; id: string };

export type AppContext = {
  Bindings: Env;
  Variables: {
    requestId: string;
    user: UserRow | null;
    guestId: string | null;
    admin: AdminRow | null;
    adminSessionId: string | null;
  };
};
