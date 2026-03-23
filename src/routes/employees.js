const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

// GET /api/employees?all=true
router.get('/', auth, async (req, res, next) => {
  try {
    const { all } = req.query;
    const where = all === 'true' ? {} : { active: true };
    const employees = await prisma.employee.findMany({
      where,
      include: { _count: { select: { workLogs: true } } },
      orderBy: { workerName: 'asc' },
    });
    res.json(employees);
  } catch (err) { next(err); }
});

// GET /api/employees/:id
router.get('/:id', auth, async (req, res, next) => {
  try {
    const employee = await prisma.employee.findUnique({
      where: { id: parseInt(req.params.id) },
      include: { _count: { select: { workLogs: true } } },
    });
    if (!employee) return res.status(404).json({ error: 'Employee not found.' });
    res.json(employee);
  } catch (err) { next(err); }
});

// POST /api/employees
router.post('/', auth, async (req, res, next) => {
  try {
    const { workerName, title, phone, email, active = true } = req.body;
    if (!workerName?.trim()) return res.status(400).json({ error: 'Worker name is required.' });
    const employee = await prisma.employee.create({
      data: { workerName: workerName.trim(), title, phone, email, active: Boolean(active) },
    });
    const employeeCode = `E-${String(employee.id).padStart(3, '0')}`;
    const updated = await prisma.employee.update({ where: { id: employee.id }, data: { employeeCode } });
    res.status(201).json(updated);
  } catch (err) { next(err); }
});

// PUT /api/employees/:id
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { workerName, title, phone, email, active } = req.body;
    if (!workerName?.trim()) return res.status(400).json({ error: 'Worker name is required.' });
    const employee = await prisma.employee.update({
      where: { id: parseInt(req.params.id) },
      data: { workerName: workerName.trim(), title, phone, email, active: Boolean(active) },
    });
    res.json(employee);
  } catch (err) { next(err); }
});

// PATCH /api/employees/:id/toggle-active
router.patch('/:id/toggle-active', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.employee.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Employee not found.' });
    const updated = await prisma.employee.update({
      where: { id },
      data: { active: !existing.active },
      include: { _count: { select: { workLogs: true } } },
    });
    res.json(updated);
  } catch (err) { next(err); }
});

// DELETE /api/employees/:id — hard delete only if no linked transactions
router.delete('/:id', auth, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const employee = await prisma.employee.findUnique({
      where: { id },
      include: { _count: { select: { workLogs: true, workOrders: true } } },
    });
    if (!employee) return res.status(404).json({ error: 'Employee not found.' });
    const { workLogs, workOrders } = employee._count;
    if (workLogs > 0 || workOrders > 0) {
      return res.status(409).json({
        error: 'Cannot delete — this employee has linked transactions.',
        linkedCounts: { workLogs, workOrders },
      });
    }
    await prisma.employee.delete({ where: { id } });
    res.json({ message: 'Employee deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
