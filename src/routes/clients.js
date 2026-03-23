const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

// GET /api/clients?search=X&all=true
router.get('/', auth, async (req, res, next) => {
  try {
    const { search, all } = req.query;
    const where = {
      ...(all !== 'true' && { isActive: true }),
      ...(search ? {
        OR: [
          { clientName: { contains: search, mode: 'insensitive' } },
          { city:       { contains: search, mode: 'insensitive' } },
          { email:      { contains: search, mode: 'insensitive' } },
        ],
      } : {}),
    };
    const clients = await prisma.client.findMany({
      where,
      include: { _count: { select: { sites: true, workLogs: true, invoices: true } } },
      orderBy: { clientName: 'asc' },
    });
    res.json(clients);
  } catch (err) { next(err); }
});

// GET /api/clients/:id
router.get('/:id', auth, async (req, res, next) => {
  try {
    const client = await prisma.client.findUnique({
      where: { id: parseInt(req.params.id) },
      include: {
        sites: { include: { fields: true, _count: { select: { workLogs: true } } } },
        _count: { select: { workLogs: true, invoices: true } },
      },
    });
    if (!client) return res.status(404).json({ error: 'Client not found.' });
    res.json(client);
  } catch (err) { next(err); }
});

// POST /api/clients
router.post('/', auth, async (req, res, next) => {
  try {
    const { clientName, address, city, state, zipCode, phoneNumber, email } = req.body;
    if (!clientName?.trim()) return res.status(400).json({ error: 'Client name is required.' });
    // Duplicate guard — reject exact name matches (case-insensitive)
    const dup = await prisma.client.findFirst({
      where: { clientName: { equals: clientName.trim(), mode: 'insensitive' } },
    });
    if (dup) return res.status(409).json({
      error: `A client named “${dup.clientName}” already exists (${dup.clientCode || 'ID ' + dup.id}). Edit that record instead.`,
    });
    const client = await prisma.client.create({
      data: { clientName: clientName.trim(), address, city, state, zipCode, phoneNumber, email },
    });
    const clientCode = `C-${String(client.id).padStart(3, '0')}`;
    const updated = await prisma.client.update({ where: { id: client.id }, data: { clientCode } });
    res.status(201).json(updated);
  } catch (err) { next(err); }
});

// PUT /api/clients/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { clientName, address, city, state, zipCode, phoneNumber, email } = req.body;
    if (!clientName?.trim()) return res.status(400).json({ error: 'Client name is required.' });
    const client = await prisma.client.update({
      where: { id: parseInt(req.params.id) },
      data: { clientName: clientName.trim(), address, city, state, zipCode, phoneNumber, email },
    });
    res.json(client);
  } catch (err) { next(err); }
});

// PATCH /api/clients/:id/toggle-active
router.patch('/:id/toggle-active', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.client.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Client not found.' });
    const updated = await prisma.client.update({
      where: { id },
      data: { isActive: !existing.isActive },
      include: { _count: { select: { sites: true, workLogs: true, invoices: true } } },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/clients/:id  — hard delete only if no linked transactions
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const client = await prisma.client.findUnique({
      where: { id },
      include: { _count: { select: { workLogs: true, invoices: true, workOrders: true } } },
    });
    if (!client) return res.status(404).json({ error: 'Client not found.' });
    const { workLogs, invoices, workOrders } = client._count;
    if (workLogs > 0 || invoices > 0 || workOrders > 0) {
      return res.status(409).json({
        error: 'Cannot delete — this client has linked transactions.',
        linkedCounts: { workLogs, invoices, workOrders },
      });
    }
    await prisma.client.delete({ where: { id } });
    res.json({ message: 'Client deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
