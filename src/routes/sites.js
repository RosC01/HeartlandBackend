const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

// GET /api/sites?clientId=X&all=true
router.get('/', auth, async (req, res, next) => {
  try {
    const { clientId, all } = req.query;
    const where = {
      ...(all !== 'true' && { isActive: true }),
      ...(clientId ? { clients: { some: { id: parseInt(clientId) } } } : {}),
    };
    const sites = await prisma.site.findMany({
      where,
      include: {
        clients: { select: { id: true, clientCode: true, clientName: true } },
        _count: { select: { fields: true, workLogs: true } },
      },
      orderBy: { siteName: 'asc' },
    });
    res.json(sites);
  } catch (err) { next(err); }
});

// GET /api/sites/:id
router.get('/:id', auth, async (req, res, next) => {
  try {
    const site = await prisma.site.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { fields: true, clients: { select: { id: true, clientName: true } } },
    });
    if (!site) return res.status(404).json({ error: 'Site not found.' });
    res.json(site);
  } catch (err) { next(err); }
});

// POST /api/sites
router.post('/', auth, async (req, res, next) => {
  try {
    const { siteName, clientIds } = req.body;
    if (!siteName?.trim()) return res.status(400).json({ error: 'Site name is required.' });
    // Duplicate guard — reject exact name matches (case-insensitive)
    const dup = await prisma.site.findFirst({
      where: { siteName: { equals: siteName.trim(), mode: 'insensitive' } },
      include: { clients: { select: { id: true, clientCode: true, clientName: true } } },
    });
    if (dup) return res.status(409).json({
      error: `A site named \u201c${dup.siteName}\u201d already exists (${dup.siteCode || 'S-' + String(dup.id).padStart(3, '0')}). Edit that record instead of adding a duplicate.`,
      existing: dup,
    });
    const ids = Array.isArray(clientIds) ? clientIds.map((id) => ({ id: parseInt(id) })) : [];
    const site = await prisma.site.create({
      data: {
        siteName: siteName.trim(),
        ...(ids.length && { clients: { connect: ids } }),
      },
      include: { clients: { select: { id: true, clientCode: true, clientName: true } } },
    });
    const siteCode = `S-${String(site.id).padStart(3, '0')}`;
    const updated = await prisma.site.update({
      where: { id: site.id }, data: { siteCode },
      include: { clients: { select: { id: true, clientCode: true, clientName: true } } },
    });
    res.status(201).json(updated);
  } catch (err) { next(err); }
});

// PUT /api/sites/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { siteName, clientIds } = req.body;
    if (!siteName?.trim()) return res.status(400).json({ error: 'Site name is required.' });
    const ids = Array.isArray(clientIds) ? clientIds.map((id) => ({ id: parseInt(id) })) : [];
    const site = await prisma.site.update({
      where: { id: parseInt(req.params.id) },
      data: {
        siteName: siteName.trim(),
        clients: { set: ids },
      },
      include: { clients: { select: { id: true, clientCode: true, clientName: true } } },
    });
    res.json(site);
  } catch (err) { next(err); }
});

// PATCH /api/sites/:id/toggle-active
router.patch('/:id/toggle-active', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.site.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Site not found.' });
    const updated = await prisma.site.update({
      where: { id },
      data: { isActive: !existing.isActive },
      include: { clients: { select: { id: true, clientCode: true, clientName: true } }, _count: { select: { fields: true, workLogs: true } } },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/sites/:id — hard delete only if no linked transactions
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const site = await prisma.site.findUnique({
      where: { id },
      include: { _count: { select: { workLogs: true, workOrders: true } } },
    });
    if (!site) return res.status(404).json({ error: 'Site not found.' });
    const { workLogs, workOrders } = site._count;
    if (workLogs > 0 || workOrders > 0) {
      return res.status(409).json({
        error: 'Cannot delete — this site has linked transactions.',
        linkedCounts: { workLogs, workOrders },
      });
    }
    await prisma.site.delete({ where: { id } });
    res.json({ message: 'Site deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
