const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

// GET /api/analytics/summary
router.get('/summary', auth, async (req, res, next) => {
  try {
    const now          = new Date();
    const currentYear  = now.getFullYear();
    const year         = parseInt(req.query.year) || currentYear;
    const isCurrentYear = year === currentYear;

    const startOfYear  = new Date(year, 0, 1);
    const endOfYear    = new Date(year, 11, 31, 23, 59, 59, 999);
    const startOfMonth = new Date(currentYear, now.getMonth(), 1);

    // Period: current month when viewing current year, full selected year otherwise
    const periodWhere = isCurrentYear
      ? { date: { gte: startOfMonth } }
      : { date: { gte: startOfYear, lte: endOfYear } };

    const [
      periodRevenue,
      unbilledTotal,
      activeClients,
      periodJobs,
      totalInvoiced,
      unpaidAmount,
    ] = await Promise.all([
      // All work for the period (unbilled + billed — represents earned revenue)
      prisma.workLog.aggregate({
        where: periodWhere,
        _sum: { lineTotal: true },
      }),
      // Work not yet invoiced (billingStatus is canonical source of truth)
      prisma.workLog.aggregate({
        where: { billingStatus: { in: ['Unbilled', 'ReadyForBilling'] } },
        _sum: { lineTotal: true },
      }),
      // Distinct clients with work in selected year
      prisma.workLog.findMany({
        where: { date: { gte: startOfYear, lte: endOfYear } },
        select: { clientId: true },
        distinct: ['clientId'],
      }),
      // Job count for period
      prisma.workLog.count({ where: periodWhere }),
      // Invoices created in selected year
      prisma.invoice.aggregate({
        where: { createdAt: { gte: startOfYear, lte: endOfYear } },
        _sum: { totalAmount: true },
      }),
      // Outstanding balance — always current state, no year filter
      prisma.invoice.aggregate({
        where: { status: { in: ['Outstanding', 'Sent', 'PartiallyPaid'] } },
        _sum: { totalAmount: true },
      }),
    ]);

    res.json({
      periodRevenue:    periodRevenue._sum.lineTotal   || 0,
      unbilledTotal:    unbilledTotal._sum.lineTotal   || 0,
      activeClients:    activeClients.length,
      periodJobs,
      totalInvoicedYTD: totalInvoiced._sum.totalAmount || 0,
      unpaidAmount:     unpaidAmount._sum.totalAmount  || 0,
      isCurrentYear,
      year,
    });
  } catch (err) { next(err); }
});

// GET /api/analytics/revenue-by-month
router.get('/revenue-by-month', auth, async (req, res, next) => {
  try {
    const year        = parseInt(req.query.year) || new Date().getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const endOfYear   = new Date(year, 11, 31, 23, 59, 59, 999);

    const logs = await prisma.workLog.findMany({
      where: { date: { gte: startOfYear, lte: endOfYear } },
      select: { date: true, lineTotal: true },
    });

    const grouped = {};
    for (const log of logs) {
      const key = `${log.date.getFullYear()}-${String(log.date.getMonth() + 1).padStart(2, '0')}`;
      grouped[key] = (grouped[key] || 0) + (log.lineTotal || 0);
    }

    const result = [];
    for (let m = 0; m < 12; m++) {
      const key = `${year}-${String(m + 1).padStart(2, '0')}`;
      result.push({
        month: key,
        label: new Date(year, m, 1).toLocaleString('default', { month: 'short' }),
        revenue: Math.round((grouped[key] || 0) * 100) / 100,
      });
    }
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/analytics/revenue-by-client
router.get('/revenue-by-client', auth, async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const where = { billed: true };
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate)   where.date.lte = new Date(new Date(endDate).setHours(23, 59, 59));
    }

    const logs = await prisma.workLog.findMany({
      where,
      select: { clientId: true, clientName: true, lineTotal: true },
    });

    const grouped = {};
    for (const log of logs) {
      if (!grouped[log.clientId]) grouped[log.clientId] = { clientName: log.clientName, revenue: 0 };
      grouped[log.clientId].revenue += log.lineTotal || 0;
    }

    const result = Object.values(grouped)
      .map((c) => ({ ...c, revenue: Math.round(c.revenue * 100) / 100 }))
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 10);

    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/analytics/revenue-by-service
router.get('/revenue-by-service', auth, async (req, res, next) => {
  try {
    const year        = parseInt(req.query.year) || new Date().getFullYear();
    const startOfYear = new Date(year, 0, 1);
    const endOfYear   = new Date(year, 11, 31, 23, 59, 59, 999);

    const logs = await prisma.workLog.findMany({
      where: { date: { gte: startOfYear, lte: endOfYear }, serviceType: { not: null } },
      select: { serviceType: true, lineTotal: true },
    });

    const grouped = {};
    for (const log of logs) {
      const key = log.serviceType || 'Other';
      grouped[key] = (grouped[key] || 0) + (log.lineTotal || 0);
    }

    const result = Object.entries(grouped)
      .map(([name, value]) => ({ name, value: Math.round(value * 100) / 100 }))
      .sort((a, b) => b.value - a.value);

    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/analytics/billed-vs-unbilled
router.get('/billed-vs-unbilled', auth, async (req, res, next) => {
  try {
    const [billed, unbilled] = await Promise.all([
      prisma.workLog.aggregate({ where: { billed: true  }, _sum: { lineTotal: true }, _count: true }),
      prisma.workLog.aggregate({ where: { billed: false }, _sum: { lineTotal: true }, _count: true }),
    ]);
    res.json({
      billed:   { amount: billed._sum.lineTotal   || 0, count: billed._count   },
      unbilled: { amount: unbilled._sum.lineTotal || 0, count: unbilled._count },
    });
  } catch (err) { next(err); }
});

module.exports = router;
