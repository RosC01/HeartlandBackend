const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

function rateStatus(r) {
  const now = new Date();
  if (r.effectiveFrom > now) return 'future';
  if (r.effectiveTo && r.effectiveTo < now) return 'expired';
  return 'active';
}

// GET /api/rates?all=true
router.get('/', auth, async (req, res, next) => {
  try {
    const { all } = req.query;
    const where = all === 'true' ? {} : { isActive: true };
    const rates = await prisma.rate.findMany({
      where,
      orderBy: [{ serviceType: 'asc' }, { effectiveFrom: 'desc' }],
    });
    res.json(rates.map((r) => ({ ...r, status: rateStatus(r) })));
  } catch (err) { next(err); }
});

// POST /api/rates
router.post('/', auth, async (req, res, next) => {
  try {
    const { serviceType, details, ratePerGallon, ratePerMile, hourlyRate, ratePerAcre, effectiveFrom, effectiveTo } = req.body;
    if (!serviceType?.trim()) return res.status(400).json({ error: 'Service type is required.' });
    const rate = await prisma.rate.create({
      data: {
        serviceType:  serviceType.trim(),
        details:       details?.trim() || null,
        ratePerGallon: ratePerGallon ? parseFloat(ratePerGallon) : null,
        ratePerMile:   ratePerMile   ? parseFloat(ratePerMile)   : null,
        hourlyRate:    hourlyRate    ? parseFloat(hourlyRate)     : null,
        ratePerAcre:   ratePerAcre   ? parseFloat(ratePerAcre)   : null,
        effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
        effectiveTo:   effectiveTo   ? new Date(effectiveTo)   : null,
      },
    });
    res.status(201).json({ ...rate, status: rateStatus(rate) });
  } catch (err) { next(err); }
});

// PUT /api/rates/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { serviceType, details, ratePerGallon, ratePerMile, hourlyRate, ratePerAcre, effectiveFrom, effectiveTo } = req.body;
    if (!serviceType?.trim()) return res.status(400).json({ error: 'Service type is required.' });
    const rate = await prisma.rate.update({
      where: { id: parseInt(req.params.id) },
      data: {
        serviceType:  serviceType.trim(),
        details:       details?.trim() || null,
        ratePerGallon: ratePerGallon ? parseFloat(ratePerGallon) : null,
        ratePerMile:   ratePerMile   ? parseFloat(ratePerMile)   : null,
        hourlyRate:    hourlyRate    ? parseFloat(hourlyRate)     : null,
        ratePerAcre:   ratePerAcre   ? parseFloat(ratePerAcre)   : null,
        effectiveFrom: effectiveFrom ? new Date(effectiveFrom) : new Date(),
        effectiveTo:   effectiveTo   ? new Date(effectiveTo)   : null,
      },
    });
    res.json({ ...rate, status: rateStatus(rate) });
  } catch (err) { next(err); }
});

// PATCH /api/rates/:id/toggle-active
router.patch('/:id/toggle-active', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.rate.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Rate not found.' });
    const updated = await prisma.rate.update({
      where: { id },
      data: { isActive: !existing.isActive },
    });
    res.json({ ...updated, status: rateStatus(updated) });
  } catch (err) { next(err); }
});

// DELETE /api/rates/:id
router.delete('/:id', auth, async (req, res, next) => {
  try {
    await prisma.rate.delete({ where: { id: parseInt(req.params.id) } });
    res.json({ message: 'Rate deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
