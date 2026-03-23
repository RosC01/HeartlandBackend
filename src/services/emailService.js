const nodemailer = require('nodemailer');
const { getSetting } = require('../routes/settings');

/**
 * Resolves SMTP config: DB settings take precedence over .env vars.
 * Throws a descriptive error if SMTP is not configured.
 */
async function resolveSmtpConfig() {
  const host   = await getSetting('smtp_host',   process.env.SMTP_HOST);
  const port   = await getSetting('smtp_port',   process.env.SMTP_PORT   || '587');
  const secure = await getSetting('smtp_secure', process.env.SMTP_SECURE || 'false');
  const user   = await getSetting('smtp_user',   process.env.SMTP_USER);
  const pass   = await getSetting('smtp_pass',   process.env.SMTP_PASS);
  const from   = await getSetting('smtp_from',   process.env.SMTP_FROM || user);

  if (!host || !user || !pass) {
    throw new Error(
      'Email is not configured. Go to Settings → Email & SMTP to enter your mail server details.'
    );
  }
  return { host, port: parseInt(port), secure: secure === 'true', user, pass, from };
}

async function createTransporter() {
  const cfg = await resolveSmtpConfig();
  return { transporter: nodemailer.createTransport({
    host:   cfg.host,
    port:   cfg.port,
    secure: cfg.secure,
    auth:   { user: cfg.user, pass: cfg.pass },
  }), from: cfg.from, user: cfg.user };
}

/**
 * Sends an invoice email with the PDF attached.
 * @param {object} opts
 * @param {string}  opts.to
 * @param {object}  opts.invoice
 * @param {Buffer}  opts.pdfBuffer
 * @param {string}  [opts.subject]   - custom subject override
 * @param {string}  [opts.emailBody] - custom plain-text body override
 */
async function sendInvoiceEmail({ to, invoice, pdfBuffer, subject: subjectOverride, emailBody: bodyOverride }) {
  const { transporter, from } = await createTransporter();

  const companyName  = process.env.COMPANY_FROM_NAME || process.env.COMPANY_NAME || 'Heartland Field Services';
  const companyEmail = process.env.COMPANY_EMAIL || from;

  const fmt = (n) =>
    `$${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const total   = invoice.totalAmount || 0;
  const paid    = invoice.amountPaid  || 0;
  const balance = total - paid;

  const subject = subjectOverride || `Invoice ${invoice.invoiceNumber} — ${companyName}`;

  const lines = bodyOverride || [
    `Dear ${invoice.client.clientName},`,
    '',
    `Please find your invoice attached (${invoice.invoiceNumber}).`,
    '',
    `  Invoice total : ${fmt(total)}`,
    paid > 0 ? `  Amount paid  : ${fmt(paid)}` : null,
    paid > 0 ? `  Balance due  : ${fmt(balance)}` : null,
    '',
    invoice.notes ? `Notes: ${invoice.notes}` : null,
    '',
    `If you have any questions please contact us at ${companyEmail}.`,
    '',
    `Thank you,`,
    companyName,
  ].filter((l) => l !== null).join('\n');

  await transporter.sendMail({
    from:        `"${companyName}" <${from}>`,
    to,
    subject,
    text:        lines,
    attachments: [
      {
        filename:    `Invoice-${invoice.invoiceNumber}.pdf`,
        content:     pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  });
}

/**
 * Sends a plain test email to verify SMTP config works.
 */
async function sendTestEmail(to) {
  const { transporter, from } = await createTransporter();
  const companyName = process.env.COMPANY_FROM_NAME || process.env.COMPANY_NAME || 'Heartland Field Services';
  await transporter.sendMail({
    from:    `"${companyName}" <${from}>`,
    to,
    subject: `Test email from ${companyName}`,
    text:    `This is a test email to confirm your SMTP configuration is working correctly.\n\nSent by Heartland Field Services.`,
  });
}

module.exports = { sendInvoiceEmail, sendTestEmail };

