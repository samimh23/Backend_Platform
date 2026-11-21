import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface Email {
  to: string;
  toName?: string;
  subject: string;
  html: string;
  /** Plain-text version (shown by mail apps that don't do HTML, and helps deliverability). */
  text: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

/** Sends through Brevo's transactional email API (https://developers.brevo.com). */
export class BrevoMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: { email: string; name: string },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(e: Email): Promise<void> {
    const res = await this.fetchFn('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: this.from,
        to: [{ email: e.to, ...(e.toName && { name: e.toName }) }],
        subject: e.subject,
        htmlContent: e.html,
        textContent: e.text,
      }),
    });
    if (!res.ok) {
      // Never log the API key; Brevo's error says what's wrong (sender not verified, quota…).
      throw new Error(`Brevo refused the email (${res.status}): ${(await res.text()).slice(0, 300)}`);
    }
  }
}

/**
 * Development without a Brevo key: each email is written as an .html file in [dir]
 * (open it in a browser to see it, links included). Nothing is sent.
 */
export class FileMailer implements Mailer {
  constructor(
    private readonly dir: string,
    private readonly log: (msg: string) => void = console.log,
  ) {}

  async send(e: Email): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const safe = e.subject.replace(/[^a-z0-9]+/gi, '-').slice(0, 40);
    const file = join(this.dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}.html`);
    await writeFile(file, `<!-- To: ${e.to} -->\n<!-- Subject: ${e.subject} -->\n${e.html}`, 'utf8');
    this.log(`[mail] not sent (no BREVO_API_KEY) — saved to ${file}`);
  }
}

/** Tests: keeps what would be sent. */
export class MemoryMailer implements Mailer {
  sent: Email[] = [];
  failWith?: Error;
  async send(e: Email): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.sent.push(e);
  }
}
