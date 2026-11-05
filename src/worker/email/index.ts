import type { Env } from '../env';
import { logError } from '../lib/errors';

export type EmailOutcome = { sent: true; messageId: string } | { sent: false; reason: 'not_configured' | 'delivery_failed' };

export function emailConfigured(env: Env): boolean {
  return Boolean(env.EMAIL && env.EMAIL_FROM);
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]!);

function layout(heading: string, body: string, cta?: { label: string; url: string }, footer?: string): string {
  const button = cta
    ? `<p style="margin:28px 0"><a href="${escapeHtml(cta.url)}" style="background:#c8502c;color:#fff;padding:13px 22px;border-radius:10px;text-decoration:none;font-weight:600;display:inline-block">${escapeHtml(cta.label)}</a></p>
       <p style="font-size:13px;color:#6b7280;word-break:break-all">Or paste this link into your browser:<br>${escapeHtml(cta.url)}</p>`
    : '';
  return `<!doctype html><html><body style="margin:0;background:#f7f3ec;padding:32px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#17323a">
  <table role="presentation" width="100%" style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px"><tr><td style="padding:32px">
    <p style="margin:0 0 20px;font-weight:700;color:#c8502c">AI Travel Planner</p>
    <h1 style="margin:0 0 14px;font-size:22px">${escapeHtml(heading)}</h1>
    <p style="margin:0;font-size:15px;line-height:1.55">${escapeHtml(body)}</p>
    ${button}
    ${footer ? `<p style="margin:24px 0 0;font-size:13px;color:#6b7280">${escapeHtml(footer)}</p>` : ''}
  </td></tr></table></body></html>`;
}

interface Template {
  subject: string;
  html: string;
  text: string;
}

export const templates = {
  verify(url: string): Template {
    const body = 'Confirm your email address to finish setting up your account. This link expires in 24 hours.';
    const footer = "If you didn't create an account, you can safely ignore this email.";
    return {
      subject: 'Confirm your email for AI Travel Planner',
      html: layout('Confirm your email', body, { label: 'Confirm email', url }, footer),
      text: `${body}\n\n${url}\n\n${footer}`,
    };
  },
  reset(url: string): Template {
    const body = 'Someone asked to reset the password for your account. This link works once and expires in 30 minutes.';
    const footer = "If this wasn't you, you can ignore this email and your password will stay the same.";
    return {
      subject: 'Reset your AI Travel Planner password',
      html: layout('Reset your password', body, { label: 'Choose a new password', url }, footer),
      text: `${body}\n\n${url}\n\n${footer}`,
    };
  },
  alreadyRegistered(loginUrl: string, resetUrl: string): Template {
    const body = 'Someone tried to create an account with this email address, but you already have one. You can log in, or reset your password if you have forgotten it.';
    const footer = "If this wasn't you, no action is needed and your account has not been changed.";
    return {
      subject: 'You already have an AI Travel Planner account',
      html: layout('You already have an account', body, { label: 'Log in', url: loginUrl }, footer),
      text: `${body}\n\nLog in: ${loginUrl}\nReset password: ${resetUrl}\n\n${footer}`,
    };
  },
  passwordChanged(): Template {
    const body = 'The password for your AI Travel Planner account was just changed. If this was you, no action is needed.';
    const footer = "If this wasn't you, use Forgot Password on the login page right away.";
    return { subject: 'Your password was changed', html: layout('Your password was changed', body, undefined, footer), text: `${body}\n\n${footer}` };
  },
};

/** Sends one message and reports honestly. Failures are logged without the recipient or provider detail. */
export async function sendEmail(env: Env, to: string, template: Template, requestId?: string): Promise<EmailOutcome> {
  if (!env.EMAIL || !env.EMAIL_FROM) {
    await logError(env.DB, { source: 'email', code: 'not_configured', message: 'The EMAIL binding or EMAIL_FROM is not configured', requestId });
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const result = await env.EMAIL.send({ to, from: env.EMAIL_FROM, subject: template.subject, html: template.html, text: template.text });
    return { sent: true, messageId: result?.messageId ?? '' };
  } catch (err) {
    const code = (err as { code?: string }).code ?? 'unknown';
    await logError(env.DB, { source: 'email', code, message: `Email delivery failed: ${template.subject}`, requestId });
    console.error('email delivery failed', code);
    return { sent: false, reason: 'delivery_failed' };
  }
}
