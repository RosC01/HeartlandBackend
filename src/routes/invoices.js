const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');
const { generateInvoicePDF } = require('../services/pdfService');
const { sendInvoiceEmail }   = require('../services/emailService');

const prisma = new PrismaClient();

// Returns the company profile marked isDefault from settings, or null.
async function getDefaultCompanyProfile() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: 'company_profiles' } });
    if (!row?.value) return null;
    const profiles = JSON.parse(row.value);
    return profiles.find((p) => p.isDefault) || null;
  } catch { return null; }
}

async function nextInvoiceNumber() {
  const year = new Date().getFullYear();
  const last = await prisma.invoice.findFirst({
    where: { invoiceNumber: { startsWith: `HLFS-${year}-` } },
    orderBy: { invoiceNumber: 'desc' },
  });
  const seq = last ? parseInt(last.invoiceNumber.split('-')[2]) + 1 : 1;
  return `HLFS-${year}-${String(seq).padStart(4, '0')}`;
}

// GET /api/invoices/pending  — worklogs marked Invoiced/Sent but not yet linked to any Invoice record
// Must be registered BEFORE /:id to avoid route collision
router.get('/pending', auth, async (req, res, next) => {
  try {
    const logs = await prisma.workLog.findMany({
      where: {
        invoiceId: null,
        billingStatus: { in: ['Invoiced', 'Sent'] },
      },
      include: {
        client:    { select: { clientName: true } },
        site:      { select: { siteName: true } },
        worker:    { select: { workerName: true } },
        workOrder: { select: { orderNumber: true } },
      },
      orderBy: [{ clientId: 'asc' }, { date: 'desc' }],
    });

    // Group by (clientId, legacyInvoiceNumber) — each original invoice is its own row
    const map = new Map();
    for (const log of logs) {
      const legacyNum = log.legacyInvoiceNumber || '';
      const key = `${log.clientId}|${legacyNum}`;
      if (!map.has(key)) {
        map.set(key, {
          groupKey:            key,
          clientId:            log.clientId,
          clientName:          log.clientName || log.client?.clientName || 'Unknown',
          legacyInvoiceNumber: legacyNum || null,
          logs:                [],
          totalAmount:         0,
          amountPaid:          0,
          minDate:             log.date,
          maxDate:             log.date,
        });
      }
      const g = map.get(key);
      g.logs.push(log);
      g.totalAmount += log.lineTotal || 0;
      if (log.paymentReceived) g.amountPaid += log.lineTotal || 0;
      if (new Date(log.date) < new Date(g.minDate)) g.minDate = log.date;
      if (new Date(log.date) > new Date(g.maxDate)) g.maxDate = log.date;
    }

    res.json([...map.values()]);
  } catch (err) { next(err); }
});

// GET /api/invoices
router.get('/', auth, async (req, res, next) => {
  try {
    const { clientId, clientIds, status, startDate, endDate, search } = req.query;
    const where = {};
    if (clientIds) {
      const ids = clientIds.split(',').map(Number).filter(Boolean);
      if (ids.length) where.clientId = { in: ids };
    } else if (clientId) {
      where.clientId = parseInt(clientId);
    }
    if (status)   where.status = status;
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt.gte = new Date(startDate);
      if (endDate)   where.createdAt.lte = new Date(new Date(endDate).setHours(23, 59, 59));
    }
    if (search) {
      where.OR = [
        { invoiceNumber:       { contains: search, mode: 'insensitive' } },
        { client: { clientName: { contains: search, mode: 'insensitive' } } },
        { companyData:         { contains: search, mode: 'insensitive' } },
      ];
    }
    const [invoices, aggregate] = await Promise.all([
      prisma.invoice.findMany({
        where,
        include: {
          client: { select: { clientName: true, email: true } },
          _count: { select: { workLogs: true } },
        },
        orderBy: { createdAt: 'desc' },
      }),
      prisma.invoice.aggregate({
        where,
        _sum: { totalAmount: true },
      }),
    ]);
    res.json({ invoices, filteredTotal: aggregate._sum.totalAmount ?? 0 });
  } catch (err) { next(err); }
});

// GET /api/invoices/:id
router.get('/:id', auth, async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        client: true,
        workLogs: {
          include: {
            worker:    { select: { workerName: true } },
            site:      { select: { siteName: true } },
            field:     { select: { fieldName: true } },
            workOrder: { select: { orderNumber: true } },
          },
          orderBy: { date: 'asc' },
        },
        payments: { orderBy: { recordedAt: 'asc' } },
      },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    res.json(invoice);
  } catch (err) { next(err); }
});

// POST /api/invoices/generate
router.post('/generate', auth, async (req, res, next) => {
  try {
    const { clientId, clientIds, startDate, endDate, notes, companyData } = req.body;

    // Support both single clientId and array of clientIds
    const ids = clientIds?.length ? clientIds.map(Number) : clientId ? [parseInt(clientId)] : [];
    if (ids.length === 0 || !startDate || !endDate) {
      return res.status(400).json({ error: 'At least one client, start date, and end date are required.' });
    }
    const resolvedCompany = (companyData && typeof companyData === 'object')
      ? companyData
      : await getDefaultCompanyProfile();
    const companyDataStr = resolvedCompany ? JSON.stringify(resolvedCompany) : null;

    const createdInvoices = [];

    for (const cid of ids) {
      const unbilled = await prisma.workLog.findMany({
        where: {
          clientId: cid,
          billingStatus: { in: ['Unbilled', 'ReadyForBilling'] },
          date: {
            gte: new Date(startDate),
            lte: new Date(new Date(endDate).setHours(23, 59, 59)),
          },
        },
      });

      if (unbilled.length === 0) continue;  // skip clients with no unbilled logs in range

      const totalAmount = unbilled.reduce((sum, l) => sum + (l.lineTotal || 0), 0);
      const amountPaid  = unbilled.filter(l => l.paymentReceived).reduce((sum, l) => sum + (l.lineTotal || 0), 0);
      const invoiceStatus = amountPaid >= totalAmount && totalAmount > 0 ? 'Paid'
                          : amountPaid > 0 ? 'PartiallyPaid'
                          : 'Outstanding';
      const legacyNums = [...new Set(unbilled.map(l => l.legacyInvoiceNumber).filter(Boolean))];
      const legacyRef  = legacyNums.length ? legacyNums.join(', ') : null;
      const invoiceNumber = await nextInvoiceNumber();

      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber,
          legacyInvoiceNumber: legacyRef,
          clientId: cid,
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          totalAmount,
          amountPaid,
          status: invoiceStatus,
          notes: notes || null,
          companyData: companyDataStr,
          workLogs: { connect: unbilled.map((l) => ({ id: l.id })) },
        },
        include: { client: { select: { clientName: true } } },
      });

      const paidIds   = unbilled.filter(l => l.paymentReceived).map(l => l.id);
      const unpaidIds = unbilled.filter(l => !l.paymentReceived).map(l => l.id);
      if (paidIds.length) {
        await prisma.workLog.updateMany({
          where: { id: { in: paidIds } },
          data: { billed: true, invoiceId: invoice.id, billingStatus: 'Sent' },
        });
      }
      if (unpaidIds.length) {
        await prisma.workLog.updateMany({
          where: { id: { in: unpaidIds } },
          data: { billed: true, invoiceId: invoice.id, billingStatus: 'Invoiced' },
        });
      }

      createdInvoices.push({
        id:           invoice.id,
        invoiceNumber,
        clientName:   invoice.client.clientName,
        totalAmount,
        workLogCount: unbilled.length,
      });
    }

    if (createdInvoices.length === 0) {
      return res.status(400).json({ error: 'No unbilled work logs found for the selected client(s) and date range.' });
    }

    res.status(201).json(createdInvoices);
  } catch (err) { next(err); }
});

// POST /api/invoices/generate-from-ids  — selected work log IDs, one invoice per group.
// When called from the Pending tab with a legacyInvoiceNumber, that number is reused
// as the formal invoice number so the original reference is preserved.
router.post('/generate-from-ids', auth, async (req, res, next) => {
  try {
    const { workLogIds, notes, legacyInvoiceNumber, companyData } = req.body;
    const resolvedCompany = (companyData && typeof companyData === 'object')
      ? companyData
      : await getDefaultCompanyProfile();
    const companyDataStr = resolvedCompany ? JSON.stringify(resolvedCompany) : null;
    if (!Array.isArray(workLogIds) || workLogIds.length === 0) {
      return res.status(400).json({ error: 'At least one work log ID is required.' });
    }

    // Include already-billed logs so pending items (billed but invoiceId=null) are handled.
    const logs = await prisma.workLog.findMany({
      where: { id: { in: workLogIds.map((id) => parseInt(id)) } },
    });
    if (logs.length === 0) {
      return res.status(400).json({ error: 'No work logs found for the provided IDs.' });
    }

    // Group by (clientId, legacyInvoiceNumber) for strict 1:1 conversion
    const byGroup = {};
    for (const log of logs) {
      const legacyNum = log.legacyInvoiceNumber || '';
      const key = `${log.clientId}|${legacyNum}`;
      if (!byGroup[key]) byGroup[key] = { clientId: log.clientId, legacyNum, logs: [] };
      byGroup[key].logs.push(log);
    }

    const createdInvoices = [];
    const groupEntries = Object.entries(byGroup);
    for (const [, group] of groupEntries) {
      const clientLogs   = group.logs;
      const clientId     = group.clientId;
      const groupLegacy  = group.legacyNum || null;  // the legacy # shared by all logs in this group
      const totalAmount = clientLogs.reduce((sum, l) => sum + (l.lineTotal || 0), 0);
      const amountPaid  = clientLogs.filter(l => l.paymentReceived).reduce((sum, l) => sum + (l.lineTotal || 0), 0);
      const invoiceStatus = amountPaid >= totalAmount && totalAmount > 0 ? 'Paid'
                          : amountPaid > 0 ? 'PartiallyPaid'
                          : 'Outstanding';
      const legacyNums = [...new Set(clientLogs.map(l => l.legacyInvoiceNumber).filter(Boolean))];
      const legacyRef  = legacyNums.length ? legacyNums.join(', ') : null;
      const dates = clientLogs.map((l) => new Date(l.date)).sort((a, b) => a - b);

      // Use the group's own legacy number as the formal invoice number when possible
      // (preserves the original reference); fall back to auto-sequence.
      const reuseCandidate = groupLegacy || legacyInvoiceNumber;
      let invoiceNumber;
      if (reuseCandidate) {
        const conflict = await prisma.invoice.findUnique({ where: { invoiceNumber: String(reuseCandidate) } });
        invoiceNumber = conflict ? await nextInvoiceNumber() : String(reuseCandidate);
      } else {
        invoiceNumber = await nextInvoiceNumber();
      }

      const invoice = await prisma.invoice.create({
        data: {
          invoiceNumber,
          legacyInvoiceNumber: legacyRef,
          clientId:   parseInt(clientId),
          startDate:  dates[0],
          endDate:    dates[dates.length - 1],
          totalAmount,
          amountPaid,
          status:     invoiceStatus,
          notes:      notes || null,
          companyData: companyDataStr,
          workLogs:   { connect: clientLogs.map((l) => ({ id: l.id })) },
        },
        include: { client: { select: { clientName: true } } },
      });

      // Paid logs → 'Sent'; unpaid logs → 'Invoiced'
      const paidIds   = clientLogs.filter(l => l.paymentReceived).map(l => l.id);
      const unpaidIds = clientLogs.filter(l => !l.paymentReceived).map(l => l.id);
      if (paidIds.length) {
        await prisma.workLog.updateMany({
          where: { id: { in: paidIds } },
          data:  { billed: true, invoiceId: invoice.id, billingStatus: 'Sent' },
        });
      }
      if (unpaidIds.length) {
        await prisma.workLog.updateMany({
          where: { id: { in: unpaidIds } },
          data:  { billed: true, invoiceId: invoice.id, billingStatus: 'Invoiced' },
        });
      }

      createdInvoices.push({
        id:           invoice.id,
        invoiceNumber,
        clientName:   invoice.client.clientName,
        workLogCount: clientLogs.length,
        totalAmount,
      });
    }

    res.status(201).json({ invoices: createdInvoices });
  } catch (err) { next(err); }
});

// GET /api/invoices/:id/pdf
router.get('/:id/pdf', auth, async (req, res, next) => {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        client: true,
        workLogs: {
          include: {
            worker: { select: { workerName: true } },
            site:   { select: { siteName: true } },
            field:  { select: { fieldName: true } },
          },
          orderBy: { date: 'asc' },
        },
      },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Invoice-${invoice.invoiceNumber}.pdf"`);

    let coOverride = {};
    if (invoice.companyData) { try { coOverride = JSON.parse(invoice.companyData); } catch {} }
    const doc = generateInvoicePDF(invoice, coOverride);
    doc.pipe(res);
    doc.end();
  } catch (err) { next(err); }
});

// PATCH /api/invoices/:id/status
router.patch('/:id/status', auth, async (req, res, next) => {
  try {
    const VALID = ['Outstanding', 'Sent', 'PartiallyPaid', 'Paid', 'Closed',
                   'paid', 'unpaid'];  // legacy compat
    const { status } = req.body;
    if (!VALID.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: Outstanding, Sent, PartiallyPaid, Paid, Closed` });
    }
    // Normalise legacy values
    const normalised = status === 'paid' ? 'Paid' : status === 'unpaid' ? 'Outstanding' : status;
    const data = { status: normalised };

    // When marking as Sent, record timestamp and cascade billingStatus on linked WorkLogs
    if (normalised === 'Sent') {
      data.sentAt = new Date();
      const inv = await prisma.invoice.findUnique({ where: { id: parseInt(req.params.id) }, select: { id: true } });
      if (inv) {
        await prisma.workLog.updateMany({
          where: { invoiceId: inv.id },
          data:  { billingStatus: 'Sent', invoiceSent: true, dateSent: new Date() },
        });
      }
    }

    // When marking as Paid, cascade billingStatus:'Paid' to all linked WorkLogs
    if (normalised === 'Paid') {
      await prisma.workLog.updateMany({
        where: { invoiceId: parseInt(req.params.id) },
        data:  { billingStatus: 'Paid', paymentReceived: true, dateReceived: new Date() },
      });
    }

    // When reverting a Paid invoice back to Outstanding/PartiallyPaid, un-pay the logs
    if (normalised === 'Outstanding' || normalised === 'PartiallyPaid') {
      await prisma.workLog.updateMany({
        where: { invoiceId: parseInt(req.params.id), billingStatus: 'Paid' },
        data:  { billingStatus: 'Sent', paymentReceived: false, dateReceived: null },
      });
    }

    const invoice = await prisma.invoice.update({
      where: { id: parseInt(req.params.id) },
      data,
    });
    res.json(invoice);
  } catch (err) { next(err); }
});

// PATCH /api/invoices/:id/company-data — update billing profile on an existing invoice
router.patch('/:id/company-data', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { companyData } = req.body;
    const companyDataStr = companyData && typeof companyData === 'object' ? JSON.stringify(companyData) : null;
    const invoice = await prisma.invoice.update({
      where: { id },
      data:  { companyData: companyDataStr },
    });
    res.json({ ok: true, companyData: invoice.companyData });
  } catch (err) { next(err); }
});

// POST /api/invoices/:id/payment  — record (partial) payment
router.post('/:id/payment', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { amountPaid } = req.body;
    if (amountPaid == null || isNaN(parseFloat(amountPaid))) {
      return res.status(400).json({ error: 'amountPaid is required.' });
    }
    const paid = parseFloat(amountPaid);
    const { note } = req.body;
    const existing = await prisma.invoice.findUnique({ where: { id }, select: { totalAmount: true, amountPaid: true } });
    if (!existing) return res.status(404).json({ error: 'Invoice not found.' });

    const totalPaid = (existing.amountPaid || 0) + paid;
    const newStatus = totalPaid >= existing.totalAmount ? 'Paid' : 'PartiallyPaid';

    const [invoice] = await prisma.$transaction([
      prisma.invoice.update({
        where: { id },
        data:  { amountPaid: totalPaid, status: newStatus },
        include: { payments: { orderBy: { recordedAt: 'asc' } } },
      }),
      prisma.payment.create({
        data: { invoiceId: id, amount: paid, note: note || null },
      }),
    ]);

    // If fully paid, mark WorkLogs as paymentReceived and billingStatus Paid
    if (newStatus === 'Paid') {
      await prisma.workLog.updateMany({
        where: { invoiceId: id },
        data:  { paymentReceived: true, dateReceived: new Date(), accountsReceivable: 0, billingStatus: 'Paid' },
      });
    }
    res.json(invoice);
  } catch (err) { next(err); }
});

// POST /api/invoices/:id/send-email
// Generate PDF, email it to the client, then mark the invoice as Sent.
router.post('/:id/send-email', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { subject, emailBody } = req.body || {};

    // Fetch full invoice with client details and work logs
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      include: {
        client: true,
        workLogs: {
          include: {
            worker: { select: { workerName: true } },
            site:   { select: { siteName: true } },
            field:  { select: { fieldName: true } },
          },
          orderBy: { date: 'asc' },
        },
      },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });

    const clientEmail = invoice.client?.email;
    if (!clientEmail) {
      return res.status(400).json({
        error: `No email address on file for ${invoice.client?.clientName || 'this client'}. Add one on the Clients page first.`,
      });
    }

    // Build PDF as an in-memory Buffer
    const pdfBuffer = await new Promise((resolve, reject) => {
      let coOverride = {};
      if (invoice.companyData) { try { coOverride = JSON.parse(invoice.companyData); } catch {} }
      const doc    = generateInvoicePDF(invoice, coOverride);
      const chunks = [];
      doc.on('data',  (c) => chunks.push(c));
      doc.on('end',   () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
      doc.end();
    });

    // Send the email
    await sendInvoiceEmail({ to: clientEmail, invoice, pdfBuffer, subject, emailBody });

    // Mark invoice as Sent + timestamp
    await prisma.invoice.update({
      where: { id },
      data:  { status: 'Sent', sentAt: new Date() },
    });

    // Cascade Sent status to all linked work logs
    await prisma.workLog.updateMany({
      where: { invoiceId: id },
      data:  { billingStatus: 'Sent', invoiceSent: true, dateSent: new Date() },
    });

    res.json({ message: `Invoice emailed to ${clientEmail}.`, sentTo: clientEmail });
  } catch (err) {
    // Surface configuration errors as 400 so the UI can show them cleanly
    if (err.message?.includes('not configured') || err.message?.includes('No email')) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// DELETE /api/invoices/:id
// Fully resets attached work logs to Unbilled so they reappear in the
// By Date Range tab ready to be re-invoiced from scratch.
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    // Fetch the invoice first so we can tell the client if it was legacy
    const invoice = await prisma.invoice.findUnique({
      where: { id },
      select: { legacyInvoiceNumber: true },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found.' });
    const isLegacy = !!invoice.legacyInvoiceNumber;

    // Reset all billing flags so logs return to a fully Unbilled state.
    // legacyInvoiceNumber is kept for historical traceability only.
    await prisma.workLog.updateMany({
      where: { invoiceId: id },
      data: {
        invoiceId:       null,
        billed:          false,
        billingStatus:   'Unbilled',
        invoiceSent:     false,
        dateSent:        null,
        paymentReceived: false,
        dateReceived:    null,
        accountsReceivable: 0,
      },
    });
    await prisma.invoice.delete({ where: { id } });
    res.json({ message: 'Invoice deleted. Work logs reset to Unbilled.', isLegacy });
  } catch (err) { next(err); }
});

module.exports = router;
