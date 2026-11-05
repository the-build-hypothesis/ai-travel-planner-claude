// A real, disposable inbox for testing email delivery end to end. It receives only throwaway
// test messages for throwaway test accounts, and these links are single-use and short-lived.
import { randomBytes } from 'node:crypto';

const API = 'https://api.guerrillamail.com/ajax.php';

export interface Inbox {
  address: string;
  /** Waits for a message whose subject matches, returning the link in its body. */
  waitForLink(subject: RegExp, linkPath: string, timeoutMs?: number): Promise<string>;
}

async function call(params: Record<string, string>): Promise<any> {
  const res = await fetch(`${API}?${new URLSearchParams(params)}`, { headers: { 'User-Agent': 'atp-e2e-test' } });
  if (!res.ok) throw new Error(`Inbox API returned HTTP ${res.status}`);
  return res.json();
}

export async function createInbox(): Promise<Inbox> {
  const first = await call({ f: 'get_email_address' });
  const sid = first.sid_token as string;
  const named = await call({ f: 'set_email_user', email_user: `atp-e2e-${randomBytes(5).toString('hex')}`, sid_token: sid });
  const address = named.email_addr as string;
  if (!address) throw new Error('The inbox service returned no address');
  const seen = new Set<string>();

  return {
    address,
    async waitForLink(subject, linkPath, timeoutMs = 150_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const data = await call({ f: 'check_email', seq: '0', sid_token: sid });
        for (const message of (data.list ?? []) as { mail_id: string; mail_subject: string }[]) {
          if (seen.has(message.mail_id) || !subject.test(message.mail_subject)) continue;
          seen.add(message.mail_id);
          const full = await call({ f: 'fetch_email', email_id: message.mail_id, sid_token: sid });
          const body = String(full.mail_body ?? '').replace(/&amp;/g, '&');
          const link = new RegExp(`https?://[^\\s"'<>]*${linkPath}\\?token=[A-Za-z0-9_%-]+`).exec(body)?.[0];
          if (!link) throw new Error(`Message "${message.mail_subject}" contained no ${linkPath} link`);
          return link;
        }
        await new Promise((r) => setTimeout(r, 5000));
      }
      throw new Error(`No email matching ${subject} arrived within ${timeoutMs} ms`);
    },
  };
}
