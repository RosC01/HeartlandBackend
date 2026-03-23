const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const crypto  = require('crypto');
const { auth, adminOnly } = require('../middleware/auth');

const prisma = new PrismaClient();

// ── Encryption helpers ────────────────────────────────────────────────────────
// Uses AES-256-GCM with a key derived from JWT_SECRET so no extra env var is needed.
const ALGO = 'aes-256-gcm';
function getKey() {
  return crypto.createHash('sha256').update(process.env.JWT_SECRET || 'fallback').digest();
}

function encrypt(plain) {
  const iv  = crypto.randomBytes(12);
  const key = getKey();
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc  = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag  = cipher.getAuthTag();
  return 'enc:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

function decrypt(stored) {
  if (!stored || !stored.startsWith('enc:')) return stored;
  const buf  = Buffer.from(stored.slice(4), 'base64');
  const iv   = buf.slice(0, 12);
  const tag  = buf.slice(12, 28);
  const enc  = buf.slice(28);
  const key  = getKey();
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc) + decipher.final('utf8');
}

// Keys that must be encrypted at rest
const SENSITIVE_KEYS = new Set(['smtp_pass']);
// Keys that are never returned to the client in plain text
const REDACT_KEYS    = new Set(['smtp_pass']);

function sanitizeValue(key, rawValue) {
  if (!rawValue) return rawValue;
  if (SENSITIVE_KEYS.has(key) && !rawValue.startsWith('enc:')) return encrypt(rawValue);
  return rawValue;
}

// ── GET /api/settings ─────────────────────────────────────────────────────────
// Returns all settings; sensitive values are redacted (replaced with '***').
router.get('/', auth, adminOnly, async (req, res, next) => {
  try {
    const rows = await prisma.appSetting.findMany();
    const out  = {};
    for (const row of rows) {
      out[row.key] = REDACT_KEYS.has(row.key)
        ? (row.value ? '***' : '')   // never send password to client
        : row.value;
    }
    // Inject server env defaults so the frontend can use them for fallbacks
    out._defaults = {
      name:      process.env.COMPANY_NAME          || '',
      fromName:  process.env.COMPANY_FROM_NAME     || process.env.COMPANY_NAME || '',
      contacts:  process.env.COMPANY_FROM_CONTACTS || '',
      address:   process.env.COMPANY_ADDRESS       || '',
      csz:       process.env.COMPANY_CITY_STATE_ZIP || '',
      phone:     process.env.COMPANY_PHONE         || '',
      email:     process.env.COMPANY_EMAIL         || '',
      payTerms:  process.env.PAYMENT_TERMS         || '',
    };
    res.json(out);
  } catch (err) { next(err); }
});

// ── PUT /api/settings ─────────────────────────────────────────────────────────
// Accepts a flat object of key→value. Missing keys are left unchanged.
// Value of '***' means "don't change" (client echoed back the redacted placeholder).
router.put('/', auth, adminOnly, async (req, res, next) => {
  try {
    const body = req.body || {};
    const ops  = [];
    for (const [key, rawValue] of Object.entries(body)) {
      if (rawValue === '***') continue;           // unchanged redacted field
      if (rawValue === '' || rawValue == null) {
        // Delete setting if cleared
        ops.push(prisma.appSetting.deleteMany({ where: { key } }));
      } else {
        const value = sanitizeValue(key, String(rawValue));
        ops.push(
          prisma.appSetting.upsert({
            where:  { key },
            update: { value },
            create: { key, value },
          })
        );
      }
    }
    await Promise.all(ops);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/settings/test-email ─────────────────────────────────────────────
// Sends a test email using the current (DB or env) SMTP config.
router.post('/test-email', auth, adminOnly, async (req, res, next) => {
  try {
    const { sendTestEmail } = require('../services/emailService');
    const to = req.body.to;
    if (!to) return res.status(400).json({ error: 'Provide a "to" address.' });
    await sendTestEmail(to);
    res.json({ message: `Test email sent to ${to}.` });
  } catch (err) {
    if (err.message?.includes('not configured')) return res.status(400).json({ error: err.message });
    next(err);
  }
});

// ── Helper exported for other modules ────────────────────────────────────────
// Returns the decrypted value of a setting from DB, falling back to the env var.
async function getSetting(key, envFallback) {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key } });
    if (row?.value) return decrypt(row.value);
  } catch { /* ignore DB errors during startup */ }
  return envFallback || '';
}

module.exports = router;
module.exports.getSetting = getSetting;
module.exports.decrypt    = decrypt;
