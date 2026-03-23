const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

function calcLineTotal({ gallons, mileage, hours, ratePerGallon, ratePerMile, hourlyRate, ratePerAcre, extraCharge, acres }) {
  const ec  = parseFloat(extraCharge)  || 0;
  const rpg = parseFloat(ratePerGallon) || 0;
  if (ec && rpg) {
    // Per-gallon service with extra charge multiplier: $/gal × acres × extraCharge
    return rpg * (parseFloat(acres) || 0) * ec;
  }
  return (
    (parseFloat(gallons)  || 0) * rpg +
    (parseFloat(mileage)  || 0) * (parseFloat(ratePerMile)   || 0) +
    (parseFloat(hours)    || 0) * (parseFloat(hourlyRate)     || 0) +
    (parseFloat(acres)    || 0) * (parseFloat(ratePerAcre)   || 0)
  );
}

// GET /api/worklogs
router.get('/', auth, async (req, res, next) => {
  try {
    const {
      clientId, workerId, siteId, fieldId,
      clientIds, workerIds, siteIds, fieldIds,   // comma-separated multi-select
      startDate, endDate, billed, invoiceSent, paymentReceived,
      season, search, billingStatus, workOrderId, page = 1, limit = 100,
      sortBy = 'date', sortDir = 'desc',
    } = req.query;

    const ALLOWED_SORT = [
      'date','dateEnd','clientName','season','serviceType',
      'gallons','waylenGallons','mileage','hours','acres',
      'ratePerGallon','lineTotal','suggestedRate','actualRate','totalDuePerAcre','ratePerAcre',
      'billingStatus','invoiceSent','dateSent','paymentReceived','dateReceived','accountsReceivable',
      'pitStartInches','pitEndInches',
    ];
    const orderField = ALLOWED_SORT.includes(sortBy) ? sortBy : 'date';
    const orderDir   = sortDir === 'asc' ? 'asc' : 'desc';

    function parseIds(multi, single) {
      if (multi) { const ids = multi.split(',').map(Number).filter(Boolean); if (ids.length) return ids; }
      if (single) { const n = parseInt(single); if (!isNaN(n)) return [n]; }
      return null;
    }

    const where = {};
    const cIds = parseIds(clientIds, clientId); if (cIds) where.clientId = cIds.length === 1 ? cIds[0] : { in: cIds };
    const wIds = parseIds(workerIds, workerId); if (wIds) where.workerId = wIds.length === 1 ? wIds[0] : { in: wIds };
    const sIds = parseIds(siteIds,   siteId);   if (sIds) where.siteId   = sIds.length === 1 ? sIds[0] : { in: sIds };
    const fIds = parseIds(fieldIds,  fieldId);  if (fIds) where.fieldId  = fIds.length === 1 ? fIds[0] : { in: fIds };
    if (season)    where.season    = season;
    if (billingStatus)  where.billingStatus = billingStatus;
    if (workOrderId)    where.workOrderId   = parseInt(workOrderId);
    if (billed !== undefined && billed !== '')           where.billed           = billed           === 'true';
    if (invoiceSent !== undefined && invoiceSent !== '') where.invoiceSent      = invoiceSent      === 'true';
    if (paymentReceived !== undefined && paymentReceived !== '') where.paymentReceived = paymentReceived === 'true';
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate)   where.date.lte = new Date(new Date(endDate).setHours(23, 59, 59));
    }
    if (search) {
      where.OR = [
        { clientName:  { contains: search, mode: 'insensitive' } },
        { notes:       { contains: search, mode: 'insensitive' } },
        { serviceType: { contains: search, mode: 'insensitive' } },
        { season:      { contains: search, mode: 'insensitive' } },
        { crew:        { contains: search, mode: 'insensitive' } },
        { details:     { contains: search, mode: 'insensitive' } },
        { legacyInvoiceNumber: { contains: search, mode: 'insensitive' } },
        { worker:    { workerName:  { contains: search, mode: 'insensitive' } } },
        { site:      { siteName:    { contains: search, mode: 'insensitive' } } },
        { site:      { siteCode:    { contains: search, mode: 'insensitive' } } },
        { field:     { fieldName:   { contains: search, mode: 'insensitive' } } },
        { field:     { fieldCode:   { contains: search, mode: 'insensitive' } } },
        { invoice:   { invoiceNumber: { contains: search, mode: 'insensitive' } } },
        { workOrder: { orderNumber:   { contains: search, mode: 'insensitive' } } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [logs, total, aggregate] = await Promise.all([
      prisma.workLog.findMany({
        where,
        include: {
          worker:    { select: { workerName: true } },
          client:    { select: { clientName: true } },
          site:      { select: { siteName: true, siteCode: true } },
          field:     { select: { fieldName: true, fieldCode: true, acres: true } },
          invoice:   { select: { invoiceNumber: true } },
          workOrder: { select: { orderNumber: true, status: true } },
        },
        orderBy: [{ [orderField]: orderDir }, { id: 'desc' }],
        skip,
        take: parseInt(limit),
      }),
      prisma.workLog.count({ where }),
      prisma.workLog.aggregate({ where, _sum: { lineTotal: true } }),
    ]);

    res.json({
      logs,
      total,
      filteredTotal: aggregate._sum.lineTotal || 0,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) { next(err); }
});

// GET /api/worklogs/latest  — most recent log for a given client/site/field/serviceType
router.get('/latest', auth, async (req, res, next) => {
  try {
    const { clientId, siteId, fieldId, serviceType } = req.query;
    if (!clientId) return res.status(400).json({ error: 'clientId is required.' });

    const where = { clientId: parseInt(clientId) };
    if (siteId)      where.siteId      = parseInt(siteId);
    if (fieldId)     where.fieldId     = parseInt(fieldId);
    if (serviceType) where.serviceType = { equals: serviceType, mode: 'insensitive' };

    const log = await prisma.workLog.findFirst({
      where,
      orderBy: [{ date: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        date: true,
        season: true,
        crew: true,
        details: true,
        gallons: true,
        acres: true,
        suggestedRate: true,
        actualRate: true,
        pitStartInches: true,
        pitEndInches: true,
        extraCharge: true,
        notes: true,
      },
    });

    if (!log) return res.status(404).json({ error: 'No matching work log found.' });
    res.json(log);
  } catch (err) { next(err); }
});

// GET /api/worklogs/:id
router.get('/:id', auth, async (req, res, next) => {
  try {
    const log = await prisma.workLog.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { worker: true, client: true, site: true, field: true },
    });
    if (!log) return res.status(404).json({ error: 'Work log not found.' });
    res.json(log);
  } catch (err) { next(err); }
});

// POST /api/worklogs
router.post('/', auth, async (req, res, next) => {
  try {
    const {
      date, dateEnd, season, workerId, clientId, siteId, fieldId,
      serviceType, crew, details, gallons, waylenGallons, mileage, hours, acres,
      suggestedRate, actualRate, extraCharge, notes,
      ratePerGallon, ratePerMile, hourlyRate, ratePerAcre,
      invoiceSent, dateSent, paymentReceived, dateReceived,
      pitStartInches, pitEndInches, workOrderId,
    } = req.body;

    if (!date || !workerId || !clientId || !siteId) {
      return res.status(400).json({ error: 'Date, worker, client, and site are required.' });
    }

    const client = await prisma.client.findUnique({ where: { id: parseInt(clientId) } });
    if (!client) return res.status(404).json({ error: 'Client not found.' });

    // Auto-calc actualRate for Manure Application (gallons per acre)
    const parsedGallons = gallons ? parseFloat(gallons) : null;
    const parsedAcres   = acres   ? parseFloat(acres)   : null;
    const resolvedActualRate = (serviceType?.toLowerCase().includes('manure') && parsedGallons && parsedAcres)
      ? parsedGallons / parsedAcres
      : (actualRate ? parseFloat(actualRate) : null);

    const lineTotal = calcLineTotal({ gallons, mileage, hours, ratePerGallon, ratePerMile, hourlyRate, ratePerAcre, extraCharge, acres: parsedAcres });
    const totalDuePerAcre    = (parsedAcres && lineTotal) ? lineTotal / parsedAcres : null;
    const actualCostPerGallon = (parsedGallons && lineTotal) ? lineTotal / parsedGallons : null;
    const accountsReceivable  = !!paymentReceived ? 0 : lineTotal;

    const log = await prisma.workLog.create({
      data: {
        date:    new Date(date),
        dateEnd: dateEnd ? new Date(dateEnd) : null,
        season:  season  || null,
        workerId: parseInt(workerId),
        clientId: parseInt(clientId),
        clientName: client.clientName,
        siteId:   parseInt(siteId),
        fieldId:  fieldId ? parseInt(fieldId) : null,
        serviceType:   serviceType   || null,
        crew:          crew          || null,
        details:       details        || null,
        gallons:       parsedGallons,
        waylenGallons: waylenGallons ? parseFloat(waylenGallons) : null,
        mileage:       mileage       ? parseFloat(mileage)       : null,
        hours:         hours         ? parseFloat(hours)         : null,
        acres:         parsedAcres,
        suggestedRate: suggestedRate ? parseFloat(suggestedRate) : null,
        actualRate:    resolvedActualRate,
        extraCharge:   extraCharge   ? parseFloat(extraCharge)   : null,
        notes:         notes         || null,
        ratePerGallon: ratePerGallon ? parseFloat(ratePerGallon) : null,
        ratePerMile:   ratePerMile   ? parseFloat(ratePerMile)   : null,
        hourlyRate:    hourlyRate    ? parseFloat(hourlyRate)    : null,
        ratePerAcre:   ratePerAcre   ? parseFloat(ratePerAcre)  : null,
        lineTotal,
        totalDuePerAcre,
        actualCostPerGallon,
        invoiceSent:     !!invoiceSent,
        dateSent:        dateSent        ? new Date(dateSent)        : null,
        paymentReceived: !!paymentReceived,
        dateReceived:    dateReceived    ? new Date(dateReceived)    : null,
        accountsReceivable,
        pitStartInches:  pitStartInches  ? parseFloat(pitStartInches) : null,
        pitEndInches:    pitEndInches    ? parseFloat(pitEndInches)   : null,
        workOrderId:     workOrderId     ? parseInt(workOrderId)      : null,
      },
      include: {
        worker: { select: { workerName: true } },
        site:   { select: { siteName: true, siteCode: true } },
        field:  { select: { fieldName: true, fieldCode: true, acres: true } },
      },
    });
    res.status(201).json(log);
  } catch (err) { next(err); }
});

// PUT /api/worklogs/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const b = req.body;

    // Build update object — only include fields that were explicitly sent.
    // Prisma skips `undefined` values, so omitting a key leaves DB unchanged.
    const data = {};

    if (b.date      !== undefined) data.date      = new Date(b.date);
    if (b.dateEnd   !== undefined) data.dateEnd   = b.dateEnd   ? new Date(b.dateEnd)   : null;
    if (b.season    !== undefined) data.season    = b.season    || null;
    if (b.workerId  !== undefined) data.workerId  = parseInt(b.workerId);
    if (b.clientId  !== undefined) {
      data.clientId = parseInt(b.clientId);
      const client = await prisma.client.findUnique({ where: { id: data.clientId } });
      if (client) data.clientName = client.clientName;
    }
    if (b.siteId    !== undefined) data.siteId    = parseInt(b.siteId);
    if (b.fieldId   !== undefined) data.fieldId   = b.fieldId   ? parseInt(b.fieldId)   : null;
    if (b.serviceType    !== undefined) data.serviceType    = b.serviceType    || null;
    if (b.crew           !== undefined) data.crew           = b.crew           || null;
    if (b.details        !== undefined) data.details        = b.details        || null;
    if (b.gallons        !== undefined) data.gallons        = b.gallons        ? parseFloat(b.gallons)        : null;
    if (b.waylenGallons  !== undefined) data.waylenGallons  = b.waylenGallons  ? parseFloat(b.waylenGallons)  : null;
    if (b.mileage        !== undefined) data.mileage        = b.mileage        ? parseFloat(b.mileage)        : null;
    if (b.hours          !== undefined) data.hours          = b.hours          ? parseFloat(b.hours)          : null;
    if (b.acres          !== undefined) data.acres          = b.acres          ? parseFloat(b.acres)          : null;
    if (b.suggestedRate  !== undefined) data.suggestedRate  = b.suggestedRate  ? parseFloat(b.suggestedRate)  : null;
    if (b.actualRate     !== undefined) data.actualRate     = b.actualRate     ? parseFloat(b.actualRate)     : null;
    if (b.extraCharge    !== undefined) data.extraCharge    = b.extraCharge    ? parseFloat(b.extraCharge)    : null;
    if (b.notes          !== undefined) data.notes          = b.notes          || null;
    if (b.ratePerGallon  !== undefined) data.ratePerGallon  = b.ratePerGallon  ? parseFloat(b.ratePerGallon)  : null;
    if (b.ratePerMile    !== undefined) data.ratePerMile    = b.ratePerMile    ? parseFloat(b.ratePerMile)    : null;
    if (b.hourlyRate     !== undefined) data.hourlyRate     = b.hourlyRate     ? parseFloat(b.hourlyRate)     : null;
    if (b.ratePerAcre    !== undefined) data.ratePerAcre    = b.ratePerAcre    ? parseFloat(b.ratePerAcre)    : null;
    if (b.invoiceSent        !== undefined) data.invoiceSent        = !!b.invoiceSent;
    if (b.dateSent           !== undefined) data.dateSent           = b.dateSent       ? new Date(b.dateSent)       : null;
    if (b.paymentReceived    !== undefined) data.paymentReceived    = !!b.paymentReceived;
    if (b.dateReceived       !== undefined) data.dateReceived       = b.dateReceived   ? new Date(b.dateReceived)   : null;
    if (b.pitStartInches     !== undefined) data.pitStartInches     = b.pitStartInches ? parseFloat(b.pitStartInches) : null;
    if (b.pitEndInches       !== undefined) data.pitEndInches       = b.pitEndInches   ? parseFloat(b.pitEndInches)   : null;
    if (b.workOrderId        !== undefined) data.workOrderId        = b.workOrderId    ? parseInt(b.workOrderId)      : null;
    if (b.billingStatus      !== undefined) {
      const validBS = ['Unbilled','ReadyForBilling','Invoiced','Sent','Paid'];
      if (!validBS.includes(b.billingStatus)) {
        return res.status(400).json({ error: `billingStatus must be one of: ${validBS.join(', ')}` });
      }
      data.billingStatus = b.billingStatus;
    }

    // Recalculate lineTotal only when a pricing field was explicitly sent
    const pricingFields = ['gallons','mileage','hours','ratePerGallon','ratePerMile','hourlyRate','ratePerAcre','extraCharge','acres'];
    if (pricingFields.some(f => b[f] !== undefined)) {
      data.lineTotal = calcLineTotal({
        gallons:       data.gallons,
        mileage:       data.mileage,
        hours:         data.hours,
        ratePerGallon: data.ratePerGallon,
        ratePerMile:   data.ratePerMile,
        hourlyRate:    data.hourlyRate,
        ratePerAcre:   data.ratePerAcre,
        extraCharge:   data.extraCharge,
        acres:         data.acres,
      });
    }

    // Recalculate totalDuePerAcre = lineTotal / acres
    if (b.acres !== undefined || pricingFields.some(f => b[f] !== undefined)) {
      const lt = data.lineTotal ?? null;
      const a  = data.acres     ?? null;
      data.totalDuePerAcre = (lt && a) ? lt / a : null;
    }

    // Recalculate actualCostPerGallon = lineTotal / gallons
    if (b.gallons !== undefined || pricingFields.some(f => b[f] !== undefined)) {
      const lt = data.lineTotal ?? null;
      const g  = data.gallons   ?? null;
      data.actualCostPerGallon = (lt && g) ? lt / g : null;
    }

    // Recalculate accountsReceivable: 0 if paid, else lineTotal
    // If the caller explicitly provides accountsReceivable, honour that override.
    if (b.accountsReceivable !== undefined) {
      data.accountsReceivable = parseFloat(b.accountsReceivable) || 0;
    } else if (b.paymentReceived !== undefined || pricingFields.some(f => b[f] !== undefined)) {
      const paid = data.paymentReceived ?? false;
      const lt   = data.lineTotal       ?? null;
      data.accountsReceivable = paid ? 0 : (lt ?? 0);
    }

    // Auto-calc actualRate for Manure Application (gallons per acre)
    if (b.serviceType !== undefined || b.gallons !== undefined || b.acres !== undefined) {
      const svcType = (data.serviceType ?? '').toLowerCase();
      const g = data.gallons ?? null;
      const a = data.acres   ?? null;
      if (svcType.includes('manure') && g && a) {
        data.actualRate = g / a;
      }
    }

    const log = await prisma.workLog.update({
      where: { id: parseInt(req.params.id) },
      data,
      include: {
        worker: { select: { workerName: true } },
        site:   { select: { siteName: true, siteCode: true } },
        field:  { select: { fieldName: true, fieldCode: true, acres: true } },
      },
    });

    // When paymentReceived changes and the log belongs to an invoice, sync the invoice status
    if (data.paymentReceived !== undefined && log.invoiceId) {
      const allLogs   = await prisma.workLog.findMany({ where: { invoiceId: log.invoiceId } });
      const paidTotal = allLogs.filter((l) => l.paymentReceived).reduce((s, l) => s + (l.lineTotal || 0), 0);
      const allPaid   = allLogs.every((l) => l.paymentReceived);
      const anyPaid   = allLogs.some((l)  => l.paymentReceived);
      const invStatus = allPaid ? 'Paid' : anyPaid ? 'PartiallyPaid' : 'Outstanding';
      await prisma.invoice.update({
        where: { id: log.invoiceId },
        data:  { status: invStatus, amountPaid: paidTotal },
      });
    }

    res.json(log);
  } catch (err) { next(err); }
});

// POST /api/worklogs/:id/recalculate-rate  — re-apply current rate to an unbilled work log
router.post('/:id/recalculate-rate', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const log = await prisma.workLog.findUnique({ where: { id } });
    if (!log) return res.status(404).json({ error: 'Work log not found.' });
    if (!['Unbilled', 'ReadyForBilling'].includes(log.billingStatus)) {
      return res.status(400).json({ error: 'Only Unbilled or ReadyForBilling work logs can be recalculated.' });
    }
    if (!log.serviceType) {
      return res.status(400).json({ error: 'Work log has no service type — cannot look up rate.' });
    }
    // Find the rate valid on the work log date
    const rate = await prisma.rate.findFirst({
      where: {
        serviceType: { equals: log.serviceType, mode: 'insensitive' },
        isActive: true,
        effectiveFrom: { lte: log.date },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: log.date } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!rate) return res.status(404).json({ error: `No active rate found for "${log.serviceType}" on ${log.date.toISOString().slice(0,10)}.` });

    const ratePerGallon = rate.ratePerGallon;
    const ratePerMile   = rate.ratePerMile;
    const hourlyRate    = rate.hourlyRate;
    const ratePerAcre   = rate.ratePerAcre;
    const lineTotal     = calcLineTotal({ gallons: log.gallons, mileage: log.mileage, hours: log.hours, ratePerGallon, ratePerMile, hourlyRate, ratePerAcre, extraCharge: log.extraCharge, acres: log.acres });
    const totalDuePerAcre     = (log.acres    && lineTotal) ? lineTotal / log.acres    : null;
    const actualCostPerGallon = (log.gallons  && lineTotal) ? lineTotal / log.gallons  : null;
    const accountsReceivable  = log.paymentReceived ? 0 : lineTotal;

    const updated = await prisma.workLog.update({
      where: { id },
      data: { ratePerGallon, ratePerMile, hourlyRate, ratePerAcre, lineTotal, totalDuePerAcre, actualCostPerGallon, accountsReceivable },
      include: {
        worker: { select: { workerName: true } },
        site:   { select: { siteName: true, siteCode: true } },
        field:  { select: { fieldName: true, fieldCode: true, acres: true } },
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/worklogs/:id
router.delete('/:id', auth, async (req, res, next) => {
  try {
    await prisma.workLog.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: 'Work log deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
