const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

const STATUSES = ['Created', 'Assigned', 'InProgress', 'Completed', 'Cancelled'];

// Shared line-total calculator (mirrors the one in worklogs.js)
function calcLineTotal({ gallons, mileage, hours, ratePerGallon, ratePerMile, hourlyRate, extraCharge, acres }) {
  const ec = parseFloat(extraCharge) || 0;
  if (ec) {
    // extraCharge mode: ratePerGallon × acres × extraCharge
    return (parseFloat(ratePerGallon) || 0) * (parseFloat(acres) || 0) * ec;
  }
  return (
    (parseFloat(gallons) || 0) * (parseFloat(ratePerGallon) || 0) +
    (parseFloat(mileage) || 0) * (parseFloat(ratePerMile)   || 0) +
    (parseFloat(hours)   || 0) * (parseFloat(hourlyRate)    || 0)
  );
}

async function nextOrderNumber() {
  const year = new Date().getFullYear();
  const last = await prisma.workOrder.findFirst({
    where: { orderNumber: { startsWith: `WO-${year}-` } },
    orderBy: { orderNumber: 'desc' },
  });
  const seq = last ? parseInt(last.orderNumber.split('-')[2]) + 1 : 1;
  return `WO-${year}-${String(seq).padStart(4, '0')}`;
}

// GET /api/workorders
router.get('/', auth, async (req, res, next) => {
  try {
    const { status, clientId, clientIds, season, workerId, serviceType, search } = req.query;
    const where = {};
    // By default exclude Cancelled; pass status=Cancelled explicitly to see them
    if (status) {
      where.status = status;
    } else {
      where.status = { not: 'Cancelled' };
    }
    if (clientIds) {
      const ids = clientIds.split(',').map(Number).filter(Boolean);
      if (ids.length)  where.clientId = { in: ids };
    } else if (clientId) {
      where.clientId = parseInt(clientId);
    }
    if (season)       where.season      = season;
    if (workerId)     where.workerId    = parseInt(workerId);
    if (serviceType)  where.serviceType = serviceType;
    if (search) {
      where.OR = [
        { orderNumber:  { contains: search, mode: 'insensitive' } },
        { serviceType:  { contains: search, mode: 'insensitive' } },
        { notes:        { contains: search, mode: 'insensitive' } },
        { client:  { clientName:  { contains: search, mode: 'insensitive' } } },
        { site:    { siteName:    { contains: search, mode: 'insensitive' } } },
        { worker:  { workerName:  { contains: search, mode: 'insensitive' } } },
      ];
    }

    const workOrders = await prisma.workOrder.findMany({
      where,
      include: {
        client:   { select: { clientName: true, clientCode: true } },
        site:     { select: { siteName: true } },
        field:    { select: { fieldName: true } },
        worker:   { select: { workerName: true } },
        _count:   { select: { workLogs: true } },
        workLogs: {
          where:  { invoiceId: { not: null } },
          select: { invoiceId: true, invoice: { select: { id: true, invoiceNumber: true, status: true } } },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    // Attach deduplicated invoices and strip raw workLogs relation from payload
    const result = workOrders.map(({ workLogs, ...rest }) => {
      const seen = new Set();
      const invoices = [];
      for (const log of workLogs) {
        if (log.invoice && !seen.has(log.invoiceId)) {
          seen.add(log.invoiceId);
          invoices.push(log.invoice);
        }
      }
      return { ...rest, invoices };
    });
    res.json(result);
  } catch (err) { next(err); }
});

// GET /api/workorders/:id
router.get('/:id', auth, async (req, res, next) => {
  try {
    const workOrder = await prisma.workOrder.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        client: true,
        site:   true,
        field:  true,
        worker: true,
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
    if (!workOrder) return res.status(404).json({ error: 'Work order not found.' });
    res.json(workOrder);
  } catch (err) { next(err); }
});

// POST /api/workorders
router.post('/', auth, async (req, res, next) => {
  try {
    const { clientId, siteId, fieldId, workerId, serviceType, season, notes, dueDate } = req.body;
    if (!clientId) return res.status(400).json({ error: 'Client is required.' });

    const orderNumber = await nextOrderNumber();
    // Auto-advance to Assigned if a worker is provided
    const initialStatus = workerId ? 'Assigned' : 'Created';

    const workOrder = await prisma.workOrder.create({
      data: {
        orderNumber,
        status:      initialStatus,
        clientId:    parseInt(clientId),
        siteId:      siteId   ? parseInt(siteId)   : null,
        fieldId:     fieldId  ? parseInt(fieldId)  : null,
        workerId:    workerId ? parseInt(workerId) : null,
        serviceType: serviceType || null,
        season:      season      || null,
        notes:       notes       || null,
        dueDate:     dueDate     ? new Date(dueDate) : null,
      },
      include: {
        client: { select: { clientName: true, clientCode: true } },
        site:   { select: { siteName: true } },
        field:  { select: { fieldName: true } },
        worker: { select: { workerName: true } },
        _count: { select: { workLogs: true } },
      },
    });
    res.status(201).json(workOrder);
  } catch (err) { next(err); }
});

// PUT /api/workorders/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { clientId, siteId, fieldId, workerId, serviceType, season, notes, dueDate, status } = req.body;
    const data = {};
    if (clientId    !== undefined) data.clientId    = parseInt(clientId);
    if (siteId      !== undefined) data.siteId      = siteId      ? parseInt(siteId)      : null;
    if (fieldId     !== undefined) data.fieldId     = fieldId     ? parseInt(fieldId)     : null;
    if (workerId    !== undefined) data.workerId    = workerId    ? parseInt(workerId)    : null;
    if (serviceType !== undefined) data.serviceType = serviceType || null;
    if (season      !== undefined) data.season      = season      || null;
    if (notes       !== undefined) data.notes       = notes       || null;
    if (dueDate     !== undefined) data.dueDate     = dueDate     ? new Date(dueDate)     : null;
    if (status      !== undefined) {
      if (!STATUSES.includes(status)) {
        return res.status(400).json({ error: `Status must be one of: ${STATUSES.join(', ')}` });
      }
      if (status === 'Completed') {
        return res.status(400).json({ error: 'Work orders can only be marked Completed by submitting the Application Record form.' });
      }
      data.status = status;
    }

    const workOrder = await prisma.workOrder.update({
      where: { id },
      data,
      include: {
        client: { select: { clientName: true, clientCode: true } },
        site:   { select: { siteName: true } },
        field:  { select: { fieldName: true } },
        worker: { select: { workerName: true } },
        _count: { select: { workLogs: true } },
      },
    });
    res.json(workOrder);
  } catch (err) { next(err); }
});

// PATCH /api/workorders/:id/status   — advance or set status
router.patch('/:id/status', auth, async (req, res, next) => {
  try {
    const { status } = req.body;
    const SETTABLE = ['Created', 'Assigned', 'InProgress', 'Completed'];
    if (!SETTABLE.includes(status)) {
      return res.status(400).json({ error: `Status must be one of: ${SETTABLE.join(', ')}` });
    }
    if (status === 'Completed') {
      return res.status(400).json({ error: 'Work orders can only be marked Completed by submitting the Application Record form.' });
    }
    const workOrder = await prisma.workOrder.update({
      where: { id: parseInt(req.params.id) },
      data:  { status },
      include: {
        client: { select: { clientName: true } },
        _count: { select: { workLogs: true } },
      },
    });
    res.json(workOrder);
  } catch (err) { next(err); }
});

// POST /api/workorders/:id/application-record  — submit the custom application form
// Creates a WorkLog (billingStatus='Unbilled') and marks the order Completed.
router.post('/:id/application-record', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const order = await prisma.workOrder.findUnique({
      where: { id },
      include: { client: true, field: true },
    });
    if (!order) return res.status(404).json({ error: 'Work order not found.' });
    if (!order.workerId) {
      return res.status(400).json({ error: 'A worker must be assigned to this order before submitting the application record.' });
    }

    const {
      date, dateEnd, season,
      applicatorNames, temperature, windDirection,
      soilConditions, previousCrop, distanceHauled,
      totalGallons, acres, recommendedGallonsPerAcre, actualGallonsPerAcre,
      pitStartInches, pitEndInches, notes, extraCharge,
    } = req.body;

    if (!date) return res.status(400).json({ error: 'Date is required.' });

    const parsedAcres   = acres       ? parseFloat(acres)       : (order.field?.acres ?? null);
    const parsedGallons = totalGallons ? parseFloat(totalGallons) : null;

    // Look up the applicable rate for this service type
    const serviceTypeLookup = order.serviceType || 'Manure Application';
    const rate = await prisma.rate.findFirst({
      where: {
        serviceType: { equals: serviceTypeLookup, mode: 'insensitive' },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: new Date() } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });

    const ratePerGallon = rate?.ratePerGallon ?? null;
    const ratePerMile   = rate?.ratePerMile   ?? null;
    const hourlyRate    = rate?.hourlyRate     ?? null;

    // Calculate line total using the same logic as worklogs.js
    const parsedExtra = extraCharge ? parseFloat(extraCharge) : null;
    const lineTotal = calcLineTotal({
      gallons:      parsedGallons,
      mileage:      null,
      hours:        null,
      ratePerGallon,
      ratePerMile,
      hourlyRate,
      extraCharge:  parsedExtra,
      acres:        parsedAcres,
    });
    const totalDuePerAcre     = parsedAcres  && lineTotal ? lineTotal / parsedAcres   : null;
    const actualCostPerGallon = parsedGallons && lineTotal ? lineTotal / parsedGallons : null;

    const detailParts = [
      temperature    && `Temperature: ${temperature}`,
      windDirection  && `Wind: ${windDirection}`,
      soilConditions && `Soil Conditions: ${soilConditions}`,
      previousCrop   && `Previous Crop: ${previousCrop}`,
      distanceHauled && `Distance Hauled: ${distanceHauled}`,
    ].filter(Boolean);

    const log = await prisma.workLog.create({
      data: {
        date:          new Date(date),
        dateEnd:       dateEnd ? new Date(dateEnd) : null,
        season:        season || order.season || null,
        workerId:      order.workerId,
        clientId:      order.clientId,
        clientName:    order.client?.clientName || '',
        siteId:        order.siteId,
        fieldId:       order.fieldId || null,
        serviceType:   order.serviceType || 'Manure Application',
        crew:          applicatorNames || null,
        details:       detailParts.length ? detailParts.join('\n') : null,
        gallons:       parsedGallons,
        acres:         parsedAcres,
        suggestedRate: recommendedGallonsPerAcre ? parseFloat(recommendedGallonsPerAcre) : null,
        actualRate:    actualGallonsPerAcre       ? parseFloat(actualGallonsPerAcre)       : null,
        ratePerGallon: ratePerGallon,
        ratePerMile:   ratePerMile,
        hourlyRate:    hourlyRate,
        extraCharge:   parsedExtra,
        pitStartInches:     pitStartInches ? parseFloat(pitStartInches) : null,
        pitEndInches:       pitEndInches   ? parseFloat(pitEndInches)   : null,
        notes:              notes || null,
        workOrderId:        id,
        accountsReceivable: lineTotal,
        billingStatus:      'Unbilled',
        billed:             false,
        lineTotal,
        totalDuePerAcre,
        actualCostPerGallon,
      },
    });

    await prisma.workOrder.update({
      where: { id },
      data:  { status: 'Completed' },
    });

    res.status(201).json({ log, message: 'Application record submitted successfully.' });
  } catch (err) { next(err); }
});

// DELETE /api/workorders/:id  — soft-delete by setting status to Cancelled
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const workOrder = await prisma.workOrder.update({
      where: { id },
      data:  { status: 'Cancelled' },
    });
    res.json({ message: 'Work order cancelled.', workOrder });
  } catch (err) { next(err); }
});

// POST /api/workorders/:id/restore  — restore a cancelled work order
router.post('/:id/restore', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const workOrder = await prisma.workOrder.update({
      where: { id },
      data:  { status: 'Created' },
      include: {
        client: { select: { clientName: true, clientCode: true } },
        site:   { select: { siteName: true } },
        field:  { select: { fieldName: true } },
        worker: { select: { workerName: true } },
        _count: { select: { workLogs: true } },
      },
    });
    res.json(workOrder);
  } catch (err) { next(err); }
});

module.exports = router;
