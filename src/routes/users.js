const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

const VALID_ROLES = ['admin', 'manager', 'staff', 'worker'];

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  next();
}

// GET /api/users
router.get('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      select: { id: true, username: true, email: true, role: true, employeeId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    res.json(users);
  } catch (err) { next(err); }
});

// POST /api/users
router.post('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const { username, password, email, role = 'staff', employeeId } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}.` });
    }
    const hashed = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: {
        username, password: hashed, email: email || null, role,
        employeeId: employeeId ? parseInt(employeeId) : null,
      },
      select: { id: true, username: true, email: true, role: true, employeeId: true, createdAt: true },
    });
    res.status(201).json(user);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Username or email already exists.' });
    next(err);
  }
});

// PUT /api/users/:id
router.put('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { username, email, role, employeeId } = req.body;
    if (role && !VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}.` });
    }
    // Prevent removing the last admin
    if (role && role !== 'admin') {
      const adminCount = await prisma.user.count({ where: { role: 'admin' } });
      const thisUser = await prisma.user.findUnique({ where: { id }, select: { role: true } });
      if (thisUser?.role === 'admin' && adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last admin account.' });
      }
    }
    const user = await prisma.user.update({
      where: { id },
      data: {
        ...(username && { username }),
        ...(email !== undefined && { email: email || null }),
        ...(role && { role }),
        ...(employeeId !== undefined && { employeeId: employeeId ? parseInt(employeeId) : null }),
      },
      select: { id: true, username: true, email: true, role: true, employeeId: true, createdAt: true },
    });
    res.json(user);
  } catch (err) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Username or email already exists.' });
    next(err);
  }
});

// PATCH /api/users/:id/password
router.patch('/:id/password', auth, requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { password } = req.body;
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters.' });
    }
    await prisma.user.update({
      where: { id },
      data: { password: await bcrypt.hash(password, 12) },
    });
    res.json({ message: 'Password reset successfully.' });
  } catch (err) { next(err); }
});

// DELETE /api/users/:id
router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.user.id) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    // Prevent deleting the last admin
    const target = await prisma.user.findUnique({ where: { id }, select: { role: true } });
    if (target?.role === 'admin') {
      const adminCount = await prisma.user.count({ where: { role: 'admin' } });
      if (adminCount <= 1) return res.status(400).json({ error: 'Cannot delete the last admin account.' });
    }
    await prisma.user.delete({ where: { id } });
    res.json({ message: 'User deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
