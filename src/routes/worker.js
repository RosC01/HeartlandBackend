/**
 * Worker Portal API  —  /api/worker/*
 *
 * Accessible only to authenticated users with role === 'worker'.
 * A worker User must have employeeId set so the system knows which
 * Employee record belongs to them.
 */
const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

// ── Middleware: worker role only ──────────────────────────────────────────────
function workerOnly(req, res, next) {
  if (req.user?.role !== 'worker') {
    return res.status(403).json({ error: 'Worker access only.' });
  }
  next();
}

// Resolve the Employee record linked to the logged-in user.
// Returns 400 if no employee is linked.
async function resolveEmployee(req, res) {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { employeeId: true },
  });
  if (!user?.employeeId) {
    res.status(400).json({
      error: 'Your account is not linked to an employee record. Ask an admin to link your account on the Users page.',
    });
    return null;
  }
  return user.employeeId;
}

// GET /api/worker/me  —  returns logged-in worker's employee profile
router.get('/me', auth, workerOnly, async (req, res, next) => {
  try {
    const employeeId = await resolveEmployee(req, res);
    if (!employeeId) return;

    const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
    if (!employee) return res.status(404).json({ error: 'Employee record not found.' });
    res.json(employee);
  } catch (err) { next(err); }
});

// GET /api/worker/orders  —  returns work orders assigned to this worker
// Includes: Created, Assigned, InProgress (not Completed unless ?all=true)
router.get('/orders', auth, workerOnly, async (req, res, next) => {
  try {
    const employeeId = await resolveEmployee(req, res);
    if (!employeeId) return;

    const showAll = req.query.all === 'true';
    const where = {
      workerId: employeeId,
      ...(showAll ? {} : { status: { in: ['Created', 'Assigned', 'InProgress'] } }),
    };

    const orders = await prisma.workOrder.findMany({
      where,
      include: {
        client: { select: { clientName: true, address: true, city: true, state: true } },
        site:   { select: { siteName: true } },
        field:  { select: { fieldName: true, acres: true } },
        _count: { select: { workLogs: true } },
      },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }, { createdAt: 'asc' }],
    });
    res.json(orders);
  } catch (err) { next(err); }
});

// PATCH /api/worker/orders/:id/start  —  set status to InProgress
router.patch('/orders/:id/start', auth, workerOnly, async (req, res, next) => {
  try {
    const employeeId = await resolveEmployee(req, res);
    if (!employeeId) return;

    const id = parseInt(req.params.id);
    const order = await prisma.workOrder.findUnique({ where: { id }, select: { workerId: true, status: true } });
    if (!order) return res.status(404).json({ error: 'Work order not found.' });
    if (order.workerId !== employeeId) return res.status(403).json({ error: 'This job is not assigned to you.' });
    if (order.status === 'Completed') return res.status(400).json({ error: 'Job is already completed.' });

    const updated = await prisma.workOrder.update({
      where: { id },
      data:  { status: 'InProgress' },
      include: {
        client: { select: { clientName: true } },
        site:   { select: { siteName: true } },
        field:  { select: { fieldName: true, acres: true } },
      },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// POST /api/worker/orders/:id/complete  —  submit work log + mark order Completed
router.post('/orders/:id/complete', auth, workerOnly, async (req, res, next) => {
  try {
    const employeeId = await resolveEmployee(req, res);
    if (!employeeId) return;

    const id = parseInt(req.params.id);
    const order = await prisma.workOrder.findUnique({
      where: { id },
      include: {
        client: { select: { clientName: true } },
        site:   { select: { siteName: true } },
        field:  { select: { fieldName: true, acres: true } },
      },
    });
    if (!order) return res.status(404).json({ error: 'Work order not found.' });
    if (order.workerId !== employeeId) return res.status(403).json({ error: 'This job is not assigned to you.' });

    const {
      date, dateEnd, season, serviceType, crew, details,
      gallons, waylenGallons, mileage, hours, acres,
      ratePerGallon, ratePerMile, hourlyRate, extraCharge,
      pitStartInches, pitEndInches, notes,
    } = req.body;

    if (!date) return res.status(400).json({ error: 'Date of work is required.' });

    // Use order's clientId / siteId / fieldId as defaults
    const clientId  = order.clientId;
    const siteId    = order.siteId;
    const fieldId   = order.fieldId || null;

    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { clientName: true } });

    const parsedAcres   = acres   ? parseFloat(acres)   : (order.field?.acres ?? null);
    const parsedGallons = gallons ? parseFloat(gallons) : null;
    const ec = parseFloat(extraCharge) || 0;

    let lineTotal = 0;
    if (ec) {
      lineTotal = (parseFloat(ratePerGallon) || 0) * (parsedAcres || 0) * ec;
    } else {
      lineTotal =
        (parsedGallons || 0)              * (parseFloat(ratePerGallon) || 0) +
        (parseFloat(mileage) || 0)        * (parseFloat(ratePerMile)   || 0) +
        (parseFloat(hours)   || 0)        * (parseFloat(hourlyRate)    || 0);
    }

    const totalDuePerAcre     = parsedAcres && lineTotal ? lineTotal / parsedAcres : null;
    const actualCostPerGallon = parsedGallons && lineTotal ? lineTotal / parsedGallons : null;
    const resolvedActualRate  = (serviceType?.toLowerCase().includes('manure') && parsedGallons && parsedAcres)
      ? parsedGallons / parsedAcres : null;

    const log = await prisma.workLog.create({
      data: {
        date:             new Date(date),
        dateEnd:          dateEnd         ? new Date(dateEnd)           : null,
        season:           season          || order.season               || null,
        workerId:         employeeId,
        clientId,
        clientName:       client?.clientName || '',
        siteId,
        fieldId,
        serviceType:      serviceType     || order.serviceType          || null,
        crew:             crew            || null,
        details:          details         || null,
        gallons:          parsedGallons,
        waylenGallons:    waylenGallons   ? parseFloat(waylenGallons)   : null,
        mileage:          mileage         ? parseFloat(mileage)         : null,
        hours:            hours           ? parseFloat(hours)           : null,
        acres:            parsedAcres,
        ratePerGallon:    ratePerGallon   ? parseFloat(ratePerGallon)   : null,
        ratePerMile:      ratePerMile     ? parseFloat(ratePerMile)     : null,
        hourlyRate:       hourlyRate      ? parseFloat(hourlyRate)      : null,
        extraCharge:      ec              || null,
        lineTotal,
        totalDuePerAcre,
        actualCostPerGallon,
        actualRate:       resolvedActualRate,
        pitStartInches:   pitStartInches  ? parseFloat(pitStartInches)  : null,
        pitEndInches:     pitEndInches    ? parseFloat(pitEndInches)    : null,
        notes:            notes           || null,
        workOrderId:      id,
        accountsReceivable: lineTotal,
        billingStatus:    'ReadyForBilling',
        billed:           false,
      },
    });

    // Advance work order to Completed
    await prisma.workOrder.update({
      where: { id },
      data:  { status: 'Completed' },
    });

    res.status(201).json({ log, message: 'Job marked complete. Work log submitted for billing.' });
  } catch (err) { next(err); }
});

module.exports = router;
