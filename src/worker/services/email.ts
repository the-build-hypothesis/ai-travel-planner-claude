// Transactional email via the Cloudflare Email Service Worker binding (env.EMAIL).
import type { Env } from "../env";
import { uuid } from "../lib/crypto";

export class EmailConfigError extends Error {
  code = "EMAIL_NOT_CONFIGURED";
}
export class EmailDeliveryError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

export function publicUrl(env: Env, fallbackOrigin: string): string {
  const raw = (env.APP_PUBLIC_URL || "").trim() || fallbackOrigin;
  return raw.replace(/\/+$/, "");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function layout(title: string, bodyHtml: string, cta?: { label: string; url: string }, footer?: string): string {
  const button = cta
    ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:28px 0"><tr><td style="border-radius:10px;background:#0f766e">
        <a href="${esc(cta.url)}" style="display:inline-block;padding:14px 26px;font-weight:600;color:#ffffff;text-decoration:none;font-size:15px">${esc(cta.label)}</a>
       </td></tr></table>
       <p style="font-size:13px;color:#64748b;margin:0 0 4px">Or paste this link into your browser:</p>
       <p style="font-size:13px;word-break:break-all;margin:0"><a href="${esc(cta.url)}" style="color:#0f766e">${esc(cta.url)}</a></p>`
    : "";
  return `<!doctype html><html><body style="margin:0;background:#f1f5f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0"><tr><td align="center" style="padding:32px 16px">
    <table role="presentation" width="100%" style="max-width:560px;background:#ffffff;border-radius:16px;overflow:hidden" cellspacing="0" cellpadding="0">
      <tr><td style="background:linear-gradient(135deg,#0f766e,#0e7490);padding:22px 32px;color:#ffffff;font-size:18px;font-weight:700">✈︎ AI Travel Planner</td></tr>
      <tr><td style="padding:32px">
        <h1 style="font-size:22px;margin:0 0 16px">${esc(title)}</h1>
        ${bodyHtml}
        ${button}
        ${footer ? `<p style="font-size:13px;color:#64748b;margin-top:28px">${footer}</p>` : ""}
      </td></tr>
    </table>
    <p style="font-size:12px;color:#94a3b8;margin-top:16px">You received this email because of activity on your AI Travel Planner account.</p>
  </td></tr></table></body></html>`;
}

export function verificationEmail(url: string, hoursValid: number): EmailContent {
  return {
    subject: "Verify your email for AI Travel Planner",
    html: layout(
      "Confirm your email address",
      `<p style="font-size:15px;line-height:1.6;margin:0">Welcome aboard! Confirm this address to finish setting up your account and keep your trips synced across devices.</p>`,
      { label: "Verify email", url },
      `This link expires in ${hoursValid} hours and can be used once. If you didn't create an account, you can ignore this email.`,
    ),
    text: `Confirm your email address for AI Travel Planner:\n\n${url}\n\nThis link expires in ${hoursValid} hours and can be used once. If you didn't create an account, ignore this email.`,
  };
}

export function accountExistsEmail(loginUrl: string, resetUrl: string): EmailContent {
  return {
    subject: "Sign-up attempt for your AI Travel Planner account",
    html: layout(
      "You already have an account",
      `<p style="font-size:15px;line-height:1.6;margin:0">Someone (hopefully you) tried to create a new account with this email address, but an account already exists. You can sign in, or reset your password if you've forgotten it.</p>
       <p style="font-size:15px;line-height:1.6"><a href="${esc(resetUrl)}" style="color:#0f766e">Reset your password</a></p>`,
      { label: "Sign in", url: loginUrl },
      "If this wasn't you, no action is needed — your account is unchanged.",
    ),
    text: `Someone tried to create a new AI Travel Planner account with this email, but one already exists.\n\nSign in: ${loginUrl}\nReset password: ${resetUrl}\n\nIf this wasn't you, no action is needed.`,
  };
}

export function passwordResetEmail(url: string, minutesValid: number): EmailContent {
  return {
    subject: "Reset your AI Travel Planner password",
    html: layout(
      "Reset your password",
      `<p style="font-size:15px;line-height:1.6;margin:0">We received a request to reset the password for your account. Choose a new password using the button below.</p>`,
      { label: "Choose a new password", url },
      `This link expires in ${minutesValid} minutes and works once. Resetting your password signs you out everywhere. If you didn't request this, you can safely ignore this email.`,
    ),
    text: `Reset your AI Travel Planner password:\n\n${url}\n\nThis link expires in ${minutesValid} minutes and works once. If you didn't request this, ignore this email.`,
  };
}

/**
 * Sends a message. Throws EmailConfigError when the binding/sender is missing,
 * EmailDeliveryError when the service rejects or fails the send.
 * Failures are recorded in app_errors (without recipient address or tokens).
 */
export async function sendEmail(env: Env, to: string, content: EmailContent, kind: string): Promise<string> {
  if (!env.EMAIL || !env.EMAIL_FROM) {
    await logEmailError(env, kind, "EMAIL_NOT_CONFIGURED", "Email binding or EMAIL_FROM is not configured");
    throw new EmailConfigError("Email delivery is not configured.");
  }
  try {
    const result = await env.EMAIL.send({
      to,
      from: { email: env.EMAIL_FROM, name: "AI Travel Planner" },
      subject: content.subject,
      html: content.html,
      text: content.text,
    });
    return result?.messageId ?? "";
  } catch (e) {
    const code = (e as { code?: string })?.code || "E_UNKNOWN";
    const msg = e instanceof Error ? e.message : String(e);
    await logEmailError(env, kind, code, msg.slice(0, 300));
    throw new EmailDeliveryError(code, "We couldn't send the email right now.");
  }
}

async function logEmailError(env: Env, kind: string, code: string, message: string) {
  try {
    await env.DB.prepare(
      `INSERT INTO app_errors (id, created_at, method, path, status, code, message) VALUES (?, ?, 'EMAIL', ?, NULL, ?, ?)`,
    )
      .bind(uuid(), Date.now(), `email:${kind}`, code, message)
      .run();
  } catch {
    /* never let logging break the request */
  }
}
