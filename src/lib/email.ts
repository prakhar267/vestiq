import type { Env } from '../types';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  from?: string;
}

/** Single outbound-email boundary so readiness and every email journey agree. */
export async function sendEmail(env: Env, message: EmailMessage): Promise<void> {
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: message.from ?? 'Vestiq <alerts@vestiq.in>',
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}`);
}
