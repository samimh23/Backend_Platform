import type { Email } from './mailer.js';

/** Escapes text put into HTML (names come from users). */
export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** 12500 → "12.500 DT" (same format as the POS and the website). */
export const dt = (millimes: number) => {
  const abs = Math.abs(millimes);
  return `${millimes < 0 ? '-' : ''}${Math.floor(abs / 1000)}.${String(abs % 1000).padStart(3, '0')} DT`;
};

/** A simple, mail-client-safe layout: one column, inline styles, a button. */
function layout(title: string, body: string, footer: string) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;background:#f5f5f4;font-family:Arial,Helvetica,sans-serif;color:#1c1917">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:28px">
<tr><td style="font-size:20px;font-weight:bold;padding-bottom:16px">Kahwti</td></tr>
<tr><td style="font-size:15px;line-height:1.55">${body}</td></tr>
<tr><td style="font-size:12px;color:#78716c;padding-top:24px;border-top:1px solid #e7e5e4">${footer}</td></tr>
</table></td></tr></table></body></html>`;
}

const button = (href: string, label: string) =>
  `<p style="margin:24px 0"><a href="${esc(href)}" style="background:#1c1917;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;display:inline-block;font-weight:bold">${esc(label)}</a></p>`;

export function resetPasswordEmail(p: { to: string; name: string; link: string; minutes: number }): Email {
  const subject = 'Réinitialiser votre mot de passe Kahwti';
  return {
    to: p.to,
    toName: p.name,
    subject,
    html: layout(
      subject,
      `<p>Bonjour ${esc(p.name)},</p>
<p>Vous avez demandé à changer votre mot de passe. Cliquez sur le bouton pour en choisir un nouveau :</p>
${button(p.link, 'Choisir un nouveau mot de passe')}
<p style="color:#57534e">Ce lien est valable ${p.minutes} minutes et ne sert qu’une fois.</p>`,
      'Vous n’avez rien demandé ? Ignorez cet email : votre mot de passe ne change pas.',
    ),
    text: `Bonjour ${p.name},\n\nPour choisir un nouveau mot de passe Kahwti, ouvrez ce lien (valable ${p.minutes} minutes, une seule fois) :\n${p.link}\n\nVous n'avez rien demandé ? Ignorez cet email.`,
  };
}

export interface DailySummaryData {
  ownerName: string;
  to: string;
  cafeName: string;
  /** "mardi 18 novembre" */
  dayLabel: string;
  revenue: number;
  tickets: number;
  averageTicket: number;
  /** Top 3: name × qty. */
  topProducts: { name: string; qty: number }[];
  cancelled: number;
  refunds: { count: number; amount: number };
  discounts: number;
  /** Closings with a gap between counted and expected cash. */
  cashGaps: { drawer: string; difference: number }[];
  lowStock: string[];
  dashboardUrl: string;
  settingsUrl: string;
}

const row = (label: string, value: string, alert = false) =>
  `<tr><td style="padding:6px 0;color:#57534e">${esc(label)}</td><td align="right" style="padding:6px 0;font-weight:bold;${alert ? 'color:#b91c1c' : ''}">${esc(value)}</td></tr>`;

/** Each morning: yesterday at the café, and what needs a look. */
export function dailySummaryEmail(d: DailySummaryData): Email {
  const subject = `${d.cafeName} · ${d.dayLabel} : ${dt(d.revenue)}, ${d.tickets} ticket${d.tickets > 1 ? 's' : ''}`;
  const watch: string[] = [];
  if (d.cancelled > 0) watch.push(`${d.cancelled} ticket${d.cancelled > 1 ? 's' : ''} annulé${d.cancelled > 1 ? 's' : ''}`);
  if (d.refunds.count > 0) watch.push(`${d.refunds.count} remboursement${d.refunds.count > 1 ? 's' : ''} (${dt(d.refunds.amount)})`);
  for (const g of d.cashGaps) watch.push(`Écart de caisse ${g.drawer} : ${dt(g.difference)}`);
  if (d.lowStock.length) watch.push(`Stock bas : ${d.lowStock.slice(0, 5).join(', ')}${d.lowStock.length > 5 ? '…' : ''}`);

  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0">
${row('Chiffre d’affaires', dt(d.revenue))}
${row('Tickets', String(d.tickets))}
${row('Panier moyen', dt(d.averageTicket))}
${d.discounts > 0 ? row('Remises & offerts', dt(d.discounts)) : ''}
</table>`;
  const top = d.topProducts.length
    ? `<p style="margin:0 0 4px;color:#57534e">Les plus vendus</p><p style="margin:0 0 16px">${d.topProducts.map((p) => `${esc(p.name)} × ${p.qty}`).join(' · ')}</p>`
    : '';
  const alerts = watch.length
    ? `<p style="margin:16px 0 4px;font-weight:bold;color:#b91c1c">À vérifier</p><ul style="margin:0;padding-left:20px">${watch.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`
    : `<p style="margin:16px 0;color:#15803d">Rien à signaler.</p>`;

  return {
    to: d.to,
    toName: d.ownerName,
    subject,
    html: layout(
      subject,
      `<p>Bonjour ${esc(d.ownerName)}, voici ${esc(d.cafeName)} ${esc(d.dayLabel)}.</p>${table}${top}${alerts}${button(d.dashboardUrl, 'Ouvrir le tableau de bord')}`,
      `Vous recevez ce résumé chaque matin. <a href="${esc(d.settingsUrl)}" style="color:#78716c">Ne plus le recevoir</a>`,
    ),
    text: [
      `Bonjour ${d.ownerName}, voici ${d.cafeName} ${d.dayLabel}.`,
      '',
      `Chiffre d'affaires : ${dt(d.revenue)}`,
      `Tickets : ${d.tickets} · Panier moyen : ${dt(d.averageTicket)}`,
      ...(d.topProducts.length ? [`Les plus vendus : ${d.topProducts.map((p) => `${p.name} x ${p.qty}`).join(', ')}`] : []),
      '',
      ...(watch.length ? ['À vérifier :', ...watch.map((w) => `- ${w}`)] : ['Rien à signaler.']),
      '',
      `Tableau de bord : ${d.dashboardUrl}`,
      `Ne plus recevoir ce résumé : ${d.settingsUrl}`,
    ].join('\n'),
  };
}
