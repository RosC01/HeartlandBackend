require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes       = require('./routes/auth');
const clientRoutes     = require('./routes/clients');
const siteRoutes       = require('./routes/sites');
const fieldRoutes      = require('./routes/fields');
const employeeRoutes   = require('./routes/employees');
const worklogRoutes    = require('./routes/worklogs');
const workOrderRoutes  = require('./routes/workorders');
const invoiceRoutes    = require('./routes/invoices');
const rateRoutes       = require('./routes/rates');
const analyticsRoutes  = require('./routes/analytics');
const userRoutes       = require('./routes/users');
const workerRoutes     = require('./routes/worker');
const importExportRoutes = require('./routes/importExport');
const settingsRoutes     = require('./routes/settings');
const { errorHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests from any localhost port and same-origin (no origin header)
    if (!origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
      return callback(null, true);
    }
    const allowed = (process.env.FRONTEND_URL || '').split(',').map(s => s.trim());
    if (allowed.includes(origin)) return callback(null, true);
    callback(new Error(`CORS blocked: ${origin}`));
  },
  credentials: true,
}));
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ extended: true, limit: '20mb' }));
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Routes
app.use('/api/auth',        authRoutes);
app.use('/api/clients',     clientRoutes);
app.use('/api/sites',       siteRoutes);
app.use('/api/fields',      fieldRoutes);
app.use('/api/employees',   employeeRoutes);
app.use('/api/worklogs',    worklogRoutes);
app.use('/api/workorders',  workOrderRoutes);
app.use('/api/invoices',    invoiceRoutes);
app.use('/api/rates',       rateRoutes);
app.use('/api/analytics',   analyticsRoutes);
app.use('/api/users',       userRoutes);
app.use('/api/worker',      workerRoutes);
app.use('/api/settings',    settingsRoutes);
app.use('/api',             importExportRoutes);

app.get('/api/health', (_req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`🚀 Heartland API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;
