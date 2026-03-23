const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

// GET /api/fields?siteId=X&all=true
router.get('/', auth, async (req, res, next) => {
  try {
    const { siteId, all } = req.query;
    const where = {
      ...(all !== 'true' && { isActive: true }),
      ...(siteId ? { siteId: parseInt(siteId) } : {}),
    };
    const fields = await prisma.field.findMany({
      where,
      include: {
        site: { select: { siteName: true } },
        clients: { select: { id: true, clientCode: true, clientName: true } },
      },
      orderBy: { fieldName: 'asc' },
    });
    res.json(fields);
  } catch (err) { next(err); }
});

// POST /api/fields
router.post('/', auth, async (req, res, next) => {
  try {
    const { fieldName, siteId, clientIds } = req.body;
    if (!fieldName?.trim()) return res.status(400).json({ error: 'Field name is required.' });
    if (!siteId) return res.status(400).json({ error: 'Site is required.' });
    const ids = Array.isArray(clientIds) ? clientIds.map((id) => ({ id: parseInt(id) })) : [];
    const field = await prisma.field.create({
      data: {
        fieldName: fieldName.trim(),
        siteId: parseInt(siteId),
        ...(ids.length && { clients: { connect: ids } }),
      },
    });
    const fieldCode = `F-${String(field.id).padStart(3, '0')}`;
    const updated = await prisma.field.update({
      where: { id: field.id },
      data: { fieldCode },
      include: { site: { select: { siteName: true } }, clients: { select: { id: true, clientCode: true, clientName: true } } },
    });
    res.status(201).json(updated);
  } catch (err) { next(err); }
});

// PUT /api/fields/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { fieldName, clientIds } = req.body;
    if (!fieldName?.trim()) return res.status(400).json({ error: 'Field name is required.' });
    const ids = Array.isArray(clientIds) ? clientIds.map((id) => ({ id: parseInt(id) })) : [];
    const field = await prisma.field.update({
      where: { id: parseInt(req.params.id) },
      data: {
        fieldName: fieldName.trim(),
        clients: { set: ids },
      },
      include: { site: { select: { siteName: true } }, clients: { select: { id: true, clientCode: true, clientName: true } } },
    });
    res.json(field);
  } catch (err) { next(err); }
});

// PATCH /api/fields/:id/toggle-active
router.patch('/:id/toggle-active', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.field.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Field not found.' });
    const updated = await prisma.field.update({
      where: { id },
      data: { isActive: !existing.isActive },
      include: { site: { select: { siteName: true } }, clients: { select: { id: true, clientCode: true, clientName: true } } },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/fields/:id — hard delete only if no linked transactions
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const field = await prisma.field.findUnique({
      where: { id },
      include: { _count: { select: { workLogs: true, workOrders: true } } },
    });
    if (!field) return res.status(404).json({ error: 'Field not found.' });
    const { workLogs, workOrders } = field._count;
    if (workLogs > 0 || workOrders > 0) {
      return res.status(409).json({
        error: 'Cannot delete — this field has linked transactions.',
        linkedCounts: { workLogs, workOrders },
      });
    }
    await prisma.field.delete({ where: { id } });
    res.json({ message: 'Field deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
