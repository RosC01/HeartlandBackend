const router = require('express').Router();
const { PrismaClient } = require('@prisma/client');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { parse: parseCSV } = require('csv-parse/sync');
const path = require('path');
const fs = require('fs');
const { auth } = require('../middleware/auth');

const prisma = new PrismaClient();

const upload = multer({
  dest: path.join(__dirname, '../../uploads/'),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const allowed = ['.csv', '.xlsx', '.xls'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Only CSV and Excel files are allowed.'));
  },
});

// ── Helpers ─────────────────────────────────────────────────────────────────
const MONTH_MAP = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

function parseDateField(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  const s = String(v).trim();
  if (!s) return null;
  // Try native first (handles ISO, MM/DD/YYYY, etc.)
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d;
  // Handle "dd-Mon-yy", "dd-Mon-yyyy", "dd/Mon/yy" (e.g. 01-Jan-26)
  const m = s.match(/^(\d{1,2})[-\/]([A-Za-z]{3})[-\/](\d{2,4})$/);
  if (m) {
    const day = parseInt(m[1], 10);
    const mon = MONTH_MAP[m[2].toLowerCase()];
    let year = parseInt(m[3], 10);
    if (year < 100) year += year < 50 ? 2000 : 1900;
    if (mon !== undefined) return new Date(year, mon, day);
  }
  return null;
}

function parseBool(v) {
  return ['true', 'yes', '1', 'x'].includes(String(v || '').toLowerCase().trim());
}

function parseRate(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,\s]/g, ''));
  return isNaN(n) ? null : n;
}

// strips $ , whitespace AND thousand-separator commas — for pure numeric fields like gallons
function parseNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[,\s]/g, ''));
  return isNaN(n) ? null : n;
}

async function parseUploadedFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.csv') {
    const content = fs.readFileSync(file.path, 'utf8');
    return parseCSV(content, { columns: true, skip_empty_lines: true, trim: true });
  }
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file.path);
  const ws = workbook.getWorksheet(1);
  const rows = [];
  const headers = [];
  if (ws) {
    ws.eachRow((row, rowNum) => {
      if (rowNum === 1) {
        row.eachCell((cell) => headers.push(String(cell.value || '').trim()));
      } else {
        const obj = {};
        row.eachCell((cell, colNum) => {
          if (headers[colNum - 1]) obj[headers[colNum - 1]] = cell.value ?? '';
        });
        headers.forEach((h) => { if (!(h in obj)) obj[h] = ''; });
        rows.push(obj);
      }
    });
  }
  return rows;
}

async function sendExcel(res, filename, sheetName, columns, rows) {
  const workbook = new ExcelJS.Workbook();
  const ws = workbook.addWorksheet(sheetName);
  ws.columns = columns;
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(r));
  const buf = await workbook.xlsx.writeBuffer();
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

function col(header, key, width = 16) { return { header, key, width }; }

// POST /api/import/worklogs
router.post('/import/worklogs', auth, upload.single('file'), async (req, res, next) => {
  const filePath = req.file?.path;
  try {
    if (!filePath) return res.status(400).json({ error: 'No file uploaded.' });

    const rows = await parseUploadedFile(req.file);
    if (rows.length === 0) return res.status(400).json({ error: 'File is empty or unreadable.' });

    const errors = [];
    const toCreate = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      const date       = row['date']       || row['Date']       || row['DateStart'] || row['Date Start'];
      const workerName = row['workerName'] || row['WorkerName'] || row['worker']    || row['Worker'];
      const clientName = row['clientName'] || row['ClientName'] || row['client']    || row['Client'] || row['Customer'];
      const siteName   = row['siteName']   || row['SiteName']   || row['site']      || row['Site'];

      if (!date || !workerName || !clientName || !siteName) {
        errors.push(`Row ${rowNum}: Missing required fields (date, worker, client/Customer, site).`);
        continue;
      }

      const [worker, client, site] = await Promise.all([
        prisma.employee.findFirst({ where: { workerName: { equals: String(workerName).trim(), mode: 'insensitive' } } }),
        prisma.client.findFirst({   where: { clientName: { equals: String(clientName).trim(), mode: 'insensitive' } } }),
        prisma.site.findFirst({     where: { siteName:   { equals: String(siteName).trim(),   mode: 'insensitive' } } }),
      ]);

      if (!worker) { errors.push(`Row ${rowNum}: Worker "${workerName}" not found.`); continue; }
      if (!client) { errors.push(`Row ${rowNum}: Client "${clientName}" not found.`); continue; }
      if (!site)   { errors.push(`Row ${rowNum}: Site "${siteName}" not found.`);     continue; }

      const fieldNameVal = row['fieldName'] || row['FieldName'] || row['field'] || row['Field'];
      let field = null;
      if (fieldNameVal) {
        field = await prisma.field.findFirst({ where: { fieldName: { equals: String(fieldNameVal), mode: 'insensitive' } } });
      }

      const gallons        = parseFloat(row['gallons']        || row['Gallons'])        || null;
      const mileage        = parseFloat(row['mileage']        || row['Mileage'])        || null;
      const hours          = parseFloat(row['hours']          || row['Hours'])          || null;
      const ratePerGallon  = parseFloat(row['ratePerGallon']  || row['RatePerGallon'])  || null;
      const ratePerMile    = parseFloat(row['ratePerMile']    || row['RatePerMile'])    || null;
      const hourlyRate     = parseFloat(row['hourlyRate']     || row['HourlyRate'])     || null;
      const waylenGallons  = parseFloat(row['waylenGallons']  || row['WaylenGallons']  || row['Waylen Gallons'])  || null;
      const acres          = parseFloat(row['acres']          || row['Acres'])          || null;
      const suggestedRate  = parseFloat(row['suggestedRate']  || row['SuggestedRate']  || row['Suggested Rate'])  || null;
      const actualRate     = parseFloat(row['actualRate']     || row['ActualRate']     || row['Actual Rate'])     || null;
      const pitStartInches = parseFloat(row['pitStartInches'] || row['PitStartInches'] || row['Pit Start Inches']) || null;
      const pitEndInches   = parseFloat(row['pitEndInches']   || row['PitEndInches']   || row['Pit End Inches'])   || null;

      const _ec = parseFloat(row['extraCharge'] || row['ExtraCharge'] || row['Extra Charge']) || 0;
      const lineTotal = _ec
        ? (ratePerGallon || 0) * (acres || 0) * _ec
        : (gallons || 0) * (ratePerGallon || 0) +
          (mileage || 0) * (ratePerMile   || 0) +
          (hours   || 0) * (hourlyRate    || 0);
      const totalDuePerAcre = (acres && actualRate) ? acres * actualRate : null;

      toCreate.push({
        date:               new Date(date),
        dateEnd:            parseDateField(row['dateEnd']         || row['DateEnd']         || row['Date End']),
        workerId:           worker.id,
        clientId:           client.id,
        clientName:         client.clientName,
        siteId:             site.id,
        fieldId:            field?.id ?? null,
        serviceType:        row['serviceType']        || row['ServiceType']        || null,
        season:             row['season']             || row['Season']             || null,
        crew:               row['crew']               || row['Crew']               || null,
        gallons, mileage, hours,
        ratePerGallon, ratePerMile, hourlyRate,
        waylenGallons, acres, suggestedRate, actualRate,
        extraCharge:        _ec || null,
        pitStartInches, pitEndInches,
        notes:              row['notes']              || row['Notes']              || null,
        lineTotal,
        totalDuePerAcre,
        billed:             false,
        invoiceSent:        parseBool(row['invoiceSent']        || row['InvoiceSent']        || row['Invoice Sent']),
        dateSent:           parseDateField(row['dateSent']      || row['DateSent']      || row['Date Sent']),
        paymentReceived:    parseBool(row['paymentReceived']    || row['PaymentReceived']    || row['Payment Received']),
        dateReceived:       parseDateField(row['dateReceived']  || row['DateReceived']  || row['Date Received']),
        accountsReceivable: parseBool(row['accountsReceivable'] || row['AccountsReceivable'] || row['Accounts Receivable']),
      });
    }

    let created = 0;
    if (toCreate.length > 0) {
      const result = await prisma.workLog.createMany({ data: toCreate });
      created = result.count;
    }

    res.json({ imported: created, skipped: errors.length, errors: errors.slice(0, 20) });
  } catch (err) {
    next(err);
  } finally {
    if (filePath) fs.unlink(filePath, () => {});
  }
});

// ── IMPORT: Clients ──────────────────────────────────────────────────────────
router.post('/import/clients', auth, upload.single('file'), async (req, res, next) => {
  const filePath = req.file?.path;
  try {
    if (!filePath) return res.status(400).json({ error: 'No file uploaded.' });
    const rows = await parseUploadedFile(req.file);
    if (rows.length === 0) return res.status(400).json({ error: 'File is empty or unreadable.' });

    const errors = [];
    const toCreate = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      const clientName = row['ClientName'] || row['clientName'] || row['Client'] || row['client'];
      if (!clientName) { errors.push(`Row ${rowNum}: Missing ClientName.`); continue; }
      toCreate.push({
        clientName:  String(clientName).trim(),
        address:     row['Address']     || row['address']     || null,
        city:        row['City']        || row['city']        || null,
        state:       row['State']       || row['state']       || null,
        zipCode:     row['ZipCode']     || row['zipCode']     || row['Zip']         || null,
        phoneNumber: row['Phone']       || row['phone']       || row['PhoneNumber'] || null,
        email:       row['Email']       || row['email']       || null,
      });
    }
    let created = 0;
    if (toCreate.length > 0) {
      const result = await prisma.client.createMany({ data: toCreate, skipDuplicates: true });
      created = result.count;
    }
    res.json({ imported: created, skipped: errors.length, errors: errors.slice(0, 20) });
  } catch (err) { next(err); } finally { if (filePath) fs.unlink(filePath, () => {}); }
});

// ── IMPORT: Sites ─────────────────────────────────────────────────────────────
router.post('/import/sites', auth, upload.single('file'), async (req, res, next) => {
  const filePath = req.file?.path;
  try {
    if (!filePath) return res.status(400).json({ error: 'No file uploaded.' });
    const rows = await parseUploadedFile(req.file);
    if (rows.length === 0) return res.status(400).json({ error: 'File is empty or unreadable.' });

    const errors = [];
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      const siteName   = row['SiteName']   || row['siteName']   || row['Site']   || row['site'];
      const clientName = row['ClientName'] || row['clientName'] || row['Client'] || row['client'];
      if (!siteName) { errors.push(`Row ${rowNum}: Missing SiteName.`); continue; }
      let clientConnect = [];
      if (clientName) {
        const client = await prisma.client.findFirst({ where: { clientName: { equals: String(clientName).trim(), mode: 'insensitive' } } });
        if (!client) { errors.push(`Row ${rowNum}: Client "${clientName}" not found.`); continue; }
        clientConnect = [{ id: client.id }];
      }
      // Upsert: find existing site by name, otherwise create; then connect client
      let site = await prisma.site.findFirst({ where: { siteName: { equals: String(siteName).trim(), mode: 'insensitive' } } });
      if (!site) {
        site = await prisma.site.create({
          data: {
            siteName: String(siteName).trim(),
            ...(clientConnect.length && { clients: { connect: clientConnect } }),
          },
        });
        const siteCode = `S-${String(site.id).padStart(3, '0')}`;
        await prisma.site.update({ where: { id: site.id }, data: { siteCode } });
        created++;
      } else if (clientConnect.length) {
        await prisma.site.update({ where: { id: site.id }, data: { clients: { connect: clientConnect } } });
      }
    }
    res.json({ imported: created, skipped: errors.length, errors: errors.slice(0, 20) });
  } catch (err) { next(err); } finally { if (filePath) fs.unlink(filePath, () => {}); }
});

// ── IMPORT: Fields ────────────────────────────────────────────────────────────
router.post('/import/fields', auth, upload.single('file'), async (req, res, next) => {
  const filePath = req.file?.path;
  try {
    if (!filePath) return res.status(400).json({ error: 'No file uploaded.' });
    const rows = await parseUploadedFile(req.file);
    if (rows.length === 0) return res.status(400).json({ error: 'File is empty or unreadable.' });

    const errors = [];
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      const fieldName  = row['FieldName']  || row['fieldName']  || row['Field']  || row['field'];
      const siteName   = row['SiteName']   || row['siteName']   || row['Site']   || row['site'];
      const clientName = row['ClientName'] || row['clientName'] || row['Client'] || row['client'];
      if (!fieldName || !siteName) { errors.push(`Row ${rowNum}: Missing FieldName or SiteName.`); continue; }
      const site = await prisma.site.findFirst({ where: { siteName: { equals: String(siteName).trim(), mode: 'insensitive' } } });
      if (!site) { errors.push(`Row ${rowNum}: Site "${siteName}" not found.`); continue; }
      let clientConnect = [];
      if (clientName) {
        const client = await prisma.client.findFirst({ where: { clientName: { equals: String(clientName).trim(), mode: 'insensitive' } } });
        if (client) clientConnect = [{ id: client.id }];
      }
      // Upsert: find existing field by name+site, otherwise create; then connect client
      let field = await prisma.field.findFirst({ where: { fieldName: { equals: String(fieldName).trim(), mode: 'insensitive' }, siteId: site.id } });
      if (!field) {
        field = await prisma.field.create({
          data: {
            fieldName: String(fieldName).trim(),
            siteId: site.id,
            acres: parseFloat(row['Acres'] || row['acres']) || null,
            ...(clientConnect.length && { clients: { connect: clientConnect } }),
          },
        });
        const fieldCode = `F-${String(field.id).padStart(3, '0')}`;
        await prisma.field.update({ where: { id: field.id }, data: { fieldCode } });
        created++;
      } else if (clientConnect.length) {
        await prisma.field.update({ where: { id: field.id }, data: { clients: { connect: clientConnect } } });
      }
    }
    res.json({ imported: created, skipped: errors.length, errors: errors.slice(0, 20) });
  } catch (err) { next(err); } finally { if (filePath) fs.unlink(filePath, () => {}); }
});

// ── IMPORT: Employees ─────────────────────────────────────────────────────────
router.post('/import/employees', auth, upload.single('file'), async (req, res, next) => {
  const filePath = req.file?.path;
  try {
    if (!filePath) return res.status(400).json({ error: 'No file uploaded.' });
    const rows = await parseUploadedFile(req.file);
    if (rows.length === 0) return res.status(400).json({ error: 'File is empty or unreadable.' });

    const errors = [];
    let created = 0;
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;
      const workerName = row['WorkerName'] || row['workerName'] || row['Worker'] || row['worker'] || row['Name'] || row['name'];
      if (!workerName) { errors.push(`Row ${rowNum}: Missing WorkerName.`); continue; }
      const activeVal = row['Active'] || row['active'];
      const data = {
        workerName: String(workerName).trim(),
        title:      row['Title']  || row['title']  || null,
        phone:      row['Phone']  || row['phone']  || row['PhoneNumber'] || null,
        email:      row['Email']  || row['email']  || null,
        type:       row['Type']   || row['type']   || null,
        active:     activeVal !== undefined ? parseBool(activeVal) : true,
      };
      const existing = await prisma.employee.findFirst({ where: { workerName: { equals: data.workerName, mode: 'insensitive' } } });
      if (existing) {
        await prisma.employee.update({ where: { id: existing.id }, data });
      } else {
        const emp = await prisma.employee.create({ data });
        const employeeCode = `E-${String(emp.id).padStart(3, '0')}`;
        await prisma.employee.update({ where: { id: emp.id }, data: { employeeCode } });
      }
      created++;
    }
    res.json({ imported: created, skipped: errors.length, errors: errors.slice(0, 20) });
  } catch (err) { next(err); } finally { if (filePath) fs.unlink(filePath, () => {}); }
});

// ── EXPORT: Worklogs ──────────────────────────────────────────────────────────
router.get('/export/worklogs', auth, async (req, res, next) => {
  try {
    const { clientId, startDate, endDate, billed, season, invoiceSent, paymentReceived } = req.query;
    const where = {};
    if (clientId) where.clientId = parseInt(clientId);
    if (billed    !== undefined && billed    !== '') where.billed    = billed    === 'true';
    if (invoiceSent  !== undefined && invoiceSent  !== '') where.invoiceSent  = invoiceSent  === 'true';
    if (paymentReceived !== undefined && paymentReceived !== '') where.paymentReceived = paymentReceived === 'true';
    if (season) where.season = season;
    if (startDate || endDate) {
      where.date = {};
      if (startDate) where.date.gte = new Date(startDate);
      if (endDate)   where.date.lte = new Date(new Date(endDate).setHours(23, 59, 59));
    }

    const logs = await prisma.workLog.findMany({
      where,
      include: {
        worker:  { select: { workerName: true } },
        site:    { select: { siteName: true } },
        field:   { select: { fieldName: true } },
        invoice: { select: { invoiceNumber: true } },
      },
      orderBy: { date: 'desc' },
    });

    const fmt = (d) => d ? new Date(d).toLocaleDateString() : '';
    const yn  = (b)  => b ? 'Yes' : 'No';

    const rows = logs.map((l) => ({
      Season:             l.season             ?? '',
      Customer:           l.clientName         ?? '',
      Site:               l.site?.siteName     ?? '',
      Field:              l.field?.fieldName   ?? '',
      Worker:             l.worker?.workerName ?? '',
      ServiceType:        l.serviceType        ?? '',
      DateStart:          fmt(l.date),
      DateEnd:            fmt(l.dateEnd),
      MileageDetails:     l.details            ?? '',
      Mileage:            l.mileage            ?? '',
      Gallons:            l.gallons            ?? '',
      WaylenGallons:      l.waylenGallons      ?? '',
      Crew:               l.crew               ?? '',
      Acres:              l.acres              ?? '',
      SuggestedRate:      l.suggestedRate      ?? '',
      ActualRate:         l.actualRate         ?? '',
      DollarPerGallon:    l.ratePerGallon      ?? '',
      Hours:              l.hours              ?? '',
      HourlyRate:         l.hourlyRate         ?? '',
      Total:              l.lineTotal?.toFixed(2)           ?? '0.00',
      DuePerAcre:         l.totalDuePerAcre?.toFixed(4)     ?? '',
      ActualCostPerGallon: l.actualCostPerGallon?.toFixed(6) ?? '',
      ExtraCharge:        l.extraCharge?.toFixed(2)         ?? '',
      InvoiceSent:        yn(l.invoiceSent),
      DateSent:           fmt(l.dateSent),
      InvoiceNumber:      l.invoice?.invoiceNumber ?? '',
      PaymentReceived:    yn(l.paymentReceived),
      DateReceived:       fmt(l.dateReceived),
      AccountsReceivable: l.accountsReceivable?.toFixed(2) ?? '0.00',
      PitStartInches:     l.pitStartInches     ?? '',
      PitEndInches:       l.pitEndInches       ?? '',
      Billed:             yn(l.billed),
      Notes:              l.notes              ?? '',
    }));

    await sendExcel(res, 'worklogs-export.xlsx', 'Work Logs', [
      col('Season',              'Season',             10),
      col('Customer',            'Customer',           24),
      col('Site',                'Site',               18),
      col('Field',               'Field',              18),
      col('Worker',              'Worker',             18),
      col('Service Type',        'ServiceType',        18),
      col('Date Start',          'DateStart',          14),
      col('Date End',            'DateEnd',            14),
      col('Mileage / Details',   'MileageDetails',     16),
      col('Mileage',             'Mileage',            10),
      col('Gallons',             'Gallons',            10),
      col('Waylen Gallons',      'WaylenGallons',      14),
      col('Crew',                'Crew',               14),
      col('Acres',               'Acres',              10),
      col('Suggested Rate',      'SuggestedRate',      14),
      col('Actual Rate',         'ActualRate',         14),
      col('$/Gal',               'DollarPerGallon',    10),
      col('Hours',               'Hours',              10),
      col('Hourly Rate',         'HourlyRate',         12),
      col('Total',               'Total',              12),
      col('Due $/Acre',          'DuePerAcre',         12),
      col('Actual $/Gal',        'ActualCostPerGallon', 14),
      col('Extra Charge',        'ExtraCharge',        12),
      col('Invoice Sent',        'InvoiceSent',        12),
      col('Date Sent',           'DateSent',           14),
      col('Invoice #',           'InvoiceNumber',      14),
      col('Payment Received',    'PaymentReceived',    16),
      col('Date Received',       'DateReceived',       14),
      col('Accounts Receivable', 'AccountsReceivable', 18),
      col('Pit Start Inches',    'PitStartInches',     14),
      col('Pit End Inches',      'PitEndInches',       14),
      col('Billed',              'Billed',             10),
      col('Notes',               'Notes',              30),
    ], rows);
  } catch (err) { next(err); }
});

// ── EXPORT: Clients ───────────────────────────────────────────────────────────
router.get('/export/clients', auth, async (req, res, next) => {
  try {
    const clients = await prisma.client.findMany({ orderBy: { clientName: 'asc' } });
    const rows = clients.map((c) => ({
      ClientName: c.clientName,
      Address:    c.address     || '',
      City:       c.city        || '',
      State:      c.state       || '',
      ZipCode:    c.zipCode     || '',
      Phone:      c.phoneNumber || '',
      Email:      c.email       || '',
    }));
    await sendExcel(res, 'clients-export.xlsx', 'Clients', [
      col('ClientName', 'ClientName', 28),
      col('Address',    'Address',    24),
      col('City',       'City',       16),
      col('State',      'State',       8),
      col('ZipCode',    'ZipCode',    10),
      col('Phone',      'Phone',      16),
      col('Email',      'Email',      26),
    ], rows);
  } catch (err) { next(err); }
});

// ── EXPORT: Sites ─────────────────────────────────────────────────────────────
router.get('/export/sites', auth, async (req, res, next) => {
  try {
    const sites = await prisma.site.findMany({
      include: { clients: { select: { clientName: true } } },
      orderBy: { siteName: 'asc' },
    });
    // Expand: one row per client (so the import can re-link them)
    const rows = [];
    for (const s of sites) {
      if (s.clients.length === 0) {
        rows.push({ SiteName: s.siteName, ClientName: '' });
      } else {
        for (const c of s.clients) rows.push({ SiteName: s.siteName, ClientName: c.clientName });
      }
    }
    await sendExcel(res, 'sites-export.xlsx', 'Sites', [
      col('SiteName',   'SiteName',   24),
      col('ClientName', 'ClientName', 28),
    ], rows);
  } catch (err) { next(err); }
});

// ── EXPORT: Fields ────────────────────────────────────────────────────────────
router.get('/export/fields', auth, async (req, res, next) => {
  try {
    const fields = await prisma.field.findMany({
      include: {
        site: { select: { siteName: true } },
        clients: { select: { clientName: true } },
      },
      orderBy: { fieldName: 'asc' },
    });
    // Expand: one row per client so export round-trips cleanly with import
    const rows = [];
    for (const f of fields) {
      if (f.clients.length === 0) {
        rows.push({ FieldName: f.fieldName, SiteName: f.site?.siteName || '', ClientName: '', Acres: f.acres ?? '' });
      } else {
        for (const c of f.clients) rows.push({ FieldName: f.fieldName, SiteName: f.site?.siteName || '', ClientName: c.clientName, Acres: f.acres ?? '' });
      }
    }
    await sendExcel(res, 'fields-export.xlsx', 'Fields', [
      col('FieldName',  'FieldName',  24),
      col('SiteName',   'SiteName',   24),
      col('ClientName', 'ClientName', 28),
      col('Acres',      'Acres',      10),
    ], rows);
  } catch (err) { next(err); }
});

// ── EXPORT: Employees ─────────────────────────────────────────────────────────
router.get('/export/employees', auth, async (req, res, next) => {
  try {
    const employees = await prisma.employee.findMany({ orderBy: { workerName: 'asc' } });
    const rows = employees.map((e) => ({
      WorkerName: e.workerName,
      Title:      e.title  || '',
      Phone:      e.phone  || '',
      Email:      e.email  || '',
      Type:       e.type   || '',
      Active:     e.active ? 'Yes' : 'No',
    }));
    await sendExcel(res, 'employees-export.xlsx', 'Employees', [
      col('WorkerName', 'WorkerName', 22),
      col('Title',      'Title',      18),
      col('Phone',      'Phone',      16),
      col('Email',      'Email',      26),
      col('Type',       'Type',       14),
      col('Active',     'Active',      8),
    ], rows);
  } catch (err) { next(err); }
});

// ── EXPORT: Invoices ──────────────────────────────────────────────────────────
router.get('/export/rates', auth, async (req, res, next) => {
  try {
    const rates = await prisma.rate.findMany({
      orderBy: [{ serviceType: 'asc' }, { effectiveFrom: 'desc' }],
    });
    const rows = rates.map((r) => ({
      ServiceType:   r.serviceType,
      Details:       r.details       ?? '',
      RatePerGallon: r.ratePerGallon != null ? r.ratePerGallon.toFixed(4) : '',
      RatePerMile:   r.ratePerMile   != null ? r.ratePerMile.toFixed(4)   : '',
      HourlyRate:    r.hourlyRate    != null ? r.hourlyRate.toFixed(2)     : '',
      EffectiveFrom: r.effectiveFrom.toLocaleDateString(),
      EffectiveTo:   r.effectiveTo   ? r.effectiveTo.toLocaleDateString()  : '',
    }));
    await sendExcel(res, 'rates-export.xlsx', 'Rates', [
      col('ServiceType',   'ServiceType',   26),
      col('Details',       'Details',       22),
      col('RatePerGallon', 'RatePerGallon', 14),
      col('RatePerMile',   'RatePerMile',   12),
      col('HourlyRate',    'HourlyRate',    12),
      col('EffectiveFrom', 'EffectiveFrom', 14),
      col('EffectiveTo',   'EffectiveTo',   14),
    ], rows);
  } catch (err) { next(err); }
});

router.get('/export/invoices', auth, async (req, res, next) => {
  try {
    const invoices = await prisma.invoice.findMany({
      include: { client: { select: { clientName: true } } },
      orderBy: { createdAt: 'desc' },
    });
    const rows = invoices.map((inv) => ({
      InvoiceNumber: inv.invoiceNumber,
      Client:        inv.client?.clientName || '',
      StartDate:     inv.startDate.toLocaleDateString(),
      EndDate:       inv.endDate.toLocaleDateString(),
      TotalAmount:   inv.totalAmount.toFixed(2),
      Status:        inv.status,
      CreatedDate:   inv.createdAt.toLocaleDateString(),
    }));
    await sendExcel(res, 'invoices-export.xlsx', 'Invoices', [
      col('InvoiceNumber', 'InvoiceNumber', 18),
      col('Client',        'Client',        26),
      col('StartDate',     'StartDate',     14),
      col('EndDate',       'EndDate',       14),
      col('TotalAmount',   'TotalAmount',   14),
      col('Status',        'Status',        10),
      col('CreatedDate',   'CreatedDate',   14),
    ], rows);
  } catch (err) { next(err); }
});

// ══════════════════════════════════════════════════════════════════════════════
// JSON Row Import Routes  (called by the ImportWizard — no file upload)
// ══════════════════════════════════════════════════════════════════════════════
function rowResult(rowNum, label, status, error) {
  return { row: rowNum, label: label || `Row ${rowNum}`, status, ...(error ? { error } : {}) };
}

function safeStr(v) { if (v == null || v === '') return null; if (typeof v === 'object') return String(Object.values(v)[0] ?? '').trim() || null; return String(v).trim() || null; }

// POST /api/import/clients/rows
router.post('/import/clients/rows', auth, async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array is required' });

    const results = [];
    let imported = 0, failed = 0, skipped = 0;
    const seenKeys = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rn = i + 2;
      const clientName  = safeStr(row.clientName);
      const address     = safeStr(row.address);
      const city        = safeStr(row.city);
      const state       = safeStr(row.state);
      const zipCode     = safeStr(row.zipCode);
      const phoneNumber = safeStr(row.phoneNumber);
      const email       = safeStr(row.email);
      if (!clientName) {
        results.push(rowResult(rn, row.clientName, 'failed', 'ClientName is required'));
        failed++; continue;
      }
      const key = clientName.toLowerCase();
      if (seenKeys.has(key)) {
        results.push(rowResult(rn, clientName, 'skipped', 'Duplicate — same client name already in this batch'));
        skipped++; continue;
      }
      seenKeys.add(key);
      try {
        const data = { clientName, address, city, state, zipCode, phoneNumber, email };
        const existing = await prisma.client.findFirst({ where: { clientName: { equals: clientName, mode: 'insensitive' } } });
        if (existing) {
          await prisma.client.update({ where: { id: existing.id }, data });
        } else {
          const client = await prisma.client.create({ data });
          const clientCode = `C-${String(client.id).padStart(3, '0')}`;
          await prisma.client.update({ where: { id: client.id }, data: { clientCode } });
        }
        results.push(rowResult(rn, clientName, 'imported'));
        imported++;
      } catch (e) {
        results.push(rowResult(rn, clientName, 'failed', e.message));
        failed++;
      }
    }
    res.json({ summary: { total: rows.length, imported, skipped, failed }, results });
  } catch (err) { next(err); }
});

// POST /api/import/sites/rows
router.post('/import/sites/rows', auth, async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array is required' });

    const results = [];
    let imported = 0, failed = 0, skipped = 0;
    const seenKeys = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rn = i + 2;
      const { siteName, clientName } = row;
      if (!String(siteName || '').trim()) {
        results.push(rowResult(rn, siteName, 'failed', 'siteName is required'));
        failed++; continue;
      }
      const key = `${String(siteName).trim().toLowerCase()}|${String(clientName || '').trim().toLowerCase()}`;
      if (seenKeys.has(key)) {
        results.push(rowResult(rn, siteName, 'skipped', 'Duplicate — same site/client combination already in this batch'));
        skipped++; continue;
      }
      seenKeys.add(key);
      let clientConnect = [];
      if (String(clientName || '').trim()) {
        const client = await prisma.client.findFirst({
          where: { clientName: { equals: String(clientName).trim(), mode: 'insensitive' } },
        });
        if (!client) {
          results.push(rowResult(rn, siteName, 'failed', `Client "${clientName}" not found`));
          failed++; continue;
        }
        clientConnect = [{ id: client.id }];
      }
      try {
        // Upsert: find existing site by name; create if missing; connect client
        let site = await prisma.site.findFirst({
          where: { siteName: { equals: String(siteName).trim(), mode: 'insensitive' } },
        });
        if (!site) {
          site = await prisma.site.create({
            data: {
              siteName: String(siteName).trim(),
              ...(clientConnect.length && { clients: { connect: clientConnect } }),
            },
          });
          const siteCode = `S-${String(site.id).padStart(3, '0')}`;
          await prisma.site.update({ where: { id: site.id }, data: { siteCode } });
          results.push(rowResult(rn, siteName, 'imported'));
          imported++;
        } else {
          if (clientConnect.length) {
            await prisma.site.update({ where: { id: site.id }, data: { clients: { connect: clientConnect } } });
          }
          results.push(rowResult(rn, siteName, 'updated'));
          imported++;
        }
      } catch (e) {
        results.push(rowResult(rn, siteName, 'failed', e.message));
        failed++;
      }
    }
    res.json({ summary: { total: rows.length, imported, skipped, failed }, results });
  } catch (err) { next(err); }
});

// POST /api/import/fields/rows
router.post('/import/fields/rows', auth, async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array is required' });

    const results = [];
    let imported = 0, failed = 0, skipped = 0;
    const seenKeys = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rn = i + 2;
      const { fieldName, siteName, acres, clientName } = row;
      if (!String(fieldName || '').trim() || !String(siteName || '').trim()) {
        results.push(rowResult(rn, fieldName, 'failed', 'fieldName and siteName are required'));
        failed++; continue;
      }
      const key = `${String(fieldName).trim().toLowerCase()}|${String(siteName).trim().toLowerCase()}|${String(clientName || '').trim().toLowerCase()}`;
      if (seenKeys.has(key)) {
        results.push(rowResult(rn, fieldName, 'skipped', 'Duplicate — same field/site/client combination already in this batch'));
        skipped++; continue;
      }
      seenKeys.add(key);
      const site = await prisma.site.findFirst({
        where: { siteName: { equals: String(siteName).trim(), mode: 'insensitive' } },
      });
      if (!site) {
        results.push(rowResult(rn, fieldName, 'failed', `Site "${siteName}" not found`));
        failed++; continue;
      }
      let clientConnect = [];
      if (String(clientName || '').trim()) {
        const client = await prisma.client.findFirst({ where: { clientName: { equals: String(clientName).trim(), mode: 'insensitive' } } });
        if (client) clientConnect = [{ id: client.id }];
      }
      try {
        // Upsert: find existing field by name+site
        let field = await prisma.field.findFirst({
          where: { fieldName: { equals: String(fieldName).trim(), mode: 'insensitive' }, siteId: site.id },
        });
        if (!field) {
          field = await prisma.field.create({ data: {
            fieldName: String(fieldName).trim(),
            siteId: site.id,
            acres: parseFloat(acres) || null,
            ...(clientConnect.length && { clients: { connect: clientConnect } }),
          }});
          const fieldCode = `F-${String(field.id).padStart(3, '0')}`;
          await prisma.field.update({ where: { id: field.id }, data: { fieldCode } });
          results.push(rowResult(rn, fieldName, 'imported'));
          imported++;
        } else {
          if (clientConnect.length) {
            await prisma.field.update({ where: { id: field.id }, data: { clients: { connect: clientConnect } } });
          }
          results.push(rowResult(rn, fieldName, 'updated'));
          imported++;
        }
      } catch (e) {
        results.push(rowResult(rn, fieldName, 'failed', e.message));
        failed++;
      }
    }
    res.json({ summary: { total: rows.length, imported, skipped, failed }, results });
  } catch (err) { next(err); }
});

// POST /api/import/employees/rows
router.post('/import/employees/rows', auth, async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array is required' });

    const results = [];
    let imported = 0, failed = 0, skipped = 0;
    const seenKeys = new Set();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rn = i + 2;
      const { workerName, title, phoneNumber, email, type, isActive } = row;
      if (!String(workerName || '').trim()) {
        results.push(rowResult(rn, workerName, 'failed', 'workerName is required'));
        failed++; continue;
      }
      const key = String(workerName).trim().toLowerCase();
      if (seenKeys.has(key)) {
        results.push(rowResult(rn, workerName, 'skipped', 'Duplicate — same employee name already in this batch'));
        skipped++; continue;
      }
      seenKeys.add(key);
      try {
        const data = {
          workerName: String(workerName).trim(),
          title:      title       || null,
          phone:      phoneNumber || null,
          email:      email       || null,
          type:       type        || null,
          active:     isActive !== undefined && isActive !== '' ? parseBool(isActive) : true,
        };
        const existing = await prisma.employee.findFirst({ where: { workerName: { equals: data.workerName, mode: 'insensitive' } } });
        if (existing) {
          await prisma.employee.update({ where: { id: existing.id }, data });
        } else {
          const emp = await prisma.employee.create({ data });
          const employeeCode = `E-${String(emp.id).padStart(3, '0')}`;
          await prisma.employee.update({ where: { id: emp.id }, data: { employeeCode } });
        }
        results.push(rowResult(rn, workerName, 'imported'));
        imported++;
      } catch (e) {
        results.push(rowResult(rn, workerName, 'failed', e.message));
        failed++;
      }
    }
    res.json({ summary: { total: rows.length, imported, skipped, failed }, results });
  } catch (err) { next(err); }
});

// POST /api/import/worklogs/rows
router.post('/import/worklogs/rows', auth, async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array is required' });

    const results = [];
    let imported = 0, failed = 0, skipped = 0;
    const seenKeys = new Set();

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rn = i + 2;
      const { date, workerName, clientName, siteName } = row;
      const label = [clientName, siteName].filter(Boolean).join(' / ') || `Row ${rn}`;

      if (!date || !workerName || !clientName || !siteName) {
        results.push(rowResult(rn, label, 'failed', 'Missing required: date, workerName, clientName, siteName'));
        failed++; continue;
      }

      const wkKey = `${String(date)}|${String(workerName).trim().toLowerCase()}|${String(clientName).trim().toLowerCase()}|${String(siteName).trim().toLowerCase()}|${String(row.fieldName || '').trim().toLowerCase()}|${String(row.serviceType || '').trim().toLowerCase()}|${String(row.invoiceNumber || '').trim().toLowerCase()}`;
      if (seenKeys.has(wkKey)) {
        results.push(rowResult(rn, label, 'skipped', 'Duplicate — same work log entry already in this batch'));
        skipped++; continue;
      }
      seenKeys.add(wkKey);

      const [worker, client, site] = await Promise.all([
        prisma.employee.findFirst({ where: { workerName: { equals: String(workerName).trim(), mode: 'insensitive' } } }),
        prisma.client.findFirst({   where: { clientName: { equals: String(clientName).trim(), mode: 'insensitive' } } }),
        prisma.site.findFirst({     where: { siteName:   { equals: String(siteName).trim(),   mode: 'insensitive' } } }),
      ]);
      if (!worker) { results.push(rowResult(rn, label, 'failed', `Worker "${workerName}" not found`));   failed++; continue; }
      if (!client) { results.push(rowResult(rn, label, 'failed', `Client "${clientName}" not found`));   failed++; continue; }
      if (!site)   { results.push(rowResult(rn, label, 'failed', `Site "${siteName}" not found`));       failed++; continue; }

      let field = null;
      if (row.fieldName) {
        field = await prisma.field.findFirst({
          where: { fieldName: { equals: String(row.fieldName), mode: 'insensitive' } },
        });
      }

      const details       = safeStr(row.details);
      const gallons       = parseNum(row.gallons);
      const mileage       = parseNum(row.mileage);
      const hours         = parseNum(row.hours);
      const ratePerGallon = parseRate(row.ratePerGallon);
      const ratePerMile   = parseRate(row.ratePerMile);
      const hourlyRate    = parseRate(row.hourlyRate);
      const waylenGallons = parseNum(row.waylenGallons);
      const acres         = parseNum(row.acres);
      const suggestedRate = parseNum(row.suggestedRate);
      const extraCharge   = parseRate(row.extraCharge);

      // Auto-calc actualRate for Manure Application: gallons per acre
      const isManureApp   = (row.serviceType || '').toLowerCase().includes('manure');
      const actualRate    = (isManureApp && gallons && acres)
        ? gallons / acres
        : parseNum(row.actualRate);

      const pitStart      = parseNum(row.pitStartInches);
      const pitEnd        = parseNum(row.pitEndInches);
      const lineTotal     = extraCharge
                          ? (ratePerGallon || 0) * (acres || 0) * extraCharge
                          : (gallons || 0) * (ratePerGallon || 0)
                          + (mileage || 0) * (ratePerMile   || 0)
                          + (hours   || 0) * (hourlyRate    || 0);
      const totalDuePerAcre     = (acres && lineTotal) ? lineTotal / acres : null;
      const actualCostPerGallon = (gallons && lineTotal) ? lineTotal / gallons : null;
      const paid                = parseBool(row.paymentReceived);
      const accountsReceivable  = paid ? 0 : lineTotal;

      // Resolve invoice by invoiceNumber — link if the Invoice record already exists.
      // Either way, always store the raw number in legacyInvoiceNumber so it's
      // visible in the Work Logs table and usable for re-generating a formal invoice.
      let invoiceId           = null;
      let invoiceLinkData     = {};
      const rawInvoiceNumber  = row.invoiceNumber ? String(row.invoiceNumber).trim() : null;
      if (rawInvoiceNumber) {
        const inv = await prisma.invoice.findUnique({ where: { invoiceNumber: rawInvoiceNumber } });
        if (inv) {
          invoiceId       = inv.id;
          invoiceLinkData = { invoiceId, billed: true, invoiceSent: true };
        }
        // If not found: legacyInvoiceNumber is still stored below (traceability)
      }

      // Auto-determine billingStatus from flags so the status badge reflects reality.
      // A row with an invoice number is at least 'Invoiced', even when no Invoice record exists yet.
      let billingStatus = 'Unbilled';
      if (paid)                                                              billingStatus = 'Sent';
      else if (parseBool(row.invoiceSent) || invoiceId || rawInvoiceNumber) billingStatus = 'Invoiced';

      try {
        // Upsert: match on the natural composite key so re-uploading the same
        // spreadsheet updates existing rows instead of creating duplicates.
        // Key: date + worker + client + site + serviceType + legacyInvoiceNumber
        // (an invoice number alone already makes a row unique within a client's job sheet)
        const logData = {
          date:               new Date(date),
          dateEnd:            parseDateField(row.dateEnd),
          season:             row.season      || null,
          crew:               row.crew        || null,
          workerId:           worker.id,
          clientId:           client.id,
          clientName:         client.clientName,
          siteId:             site.id,
          fieldId:            field?.id ?? null,
          serviceType:        row.serviceType || null,
          details,
          gallons, mileage, hours,
          ratePerGallon, ratePerMile, hourlyRate,
          waylenGallons, acres, suggestedRate, actualRate, extraCharge,
          pitStartInches:     pitStart,
          pitEndInches:       pitEnd,
          notes:              row.notes || null,
          lineTotal,
          totalDuePerAcre,
          actualCostPerGallon,
          billed:              !!invoiceId || !!rawInvoiceNumber || parseBool(row.billed) || false,
          invoiceSent:         parseBool(row.invoiceSent) || !!invoiceId,
          dateSent:            parseDateField(row.dateSent),
          paymentReceived:     paid,
          dateReceived:        parseDateField(row.dateReceived),
          accountsReceivable,
          billingStatus,
          legacyInvoiceNumber: rawInvoiceNumber,
          ...invoiceLinkData,
        };
        const existing = await prisma.workLog.findFirst({
          where: {
            date:               new Date(date),
            workerId:           worker.id,
            clientId:           client.id,
            siteId:             site.id,
            fieldId:            field?.id ?? null,
            serviceType:        row.serviceType ? { equals: String(row.serviceType).trim(), mode: 'insensitive' } : null,
            legacyInvoiceNumber: rawInvoiceNumber ?? null,
          },
        });
        if (existing) {
          // If this log is already formally invoiced, preserve the billing link —
          // re-importing source data must not detach it from its invoice.
          const updateData = existing.invoiceId
            ? (({ billed, billingStatus, invoiceSent, dateSent,
                   paymentReceived, dateReceived, accountsReceivable,
                   invoiceId: _inv, ...rest }) => rest)(logData)
            : logData;
          await prisma.workLog.update({ where: { id: existing.id }, data: updateData });
        } else {
          await prisma.workLog.create({ data: logData });
        }
        results.push(rowResult(rn, label, 'imported'));
        imported++;
      } catch (e) {
        results.push(rowResult(rn, label, 'failed', e.message));
        failed++;
      }
    }

    res.json({ summary: { total: rows.length, imported, skipped, failed }, results });
  } catch (err) { next(err); }
});

// POST /api/import/rates/rows
router.post('/import/rates/rows', auth, async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array is required' });

    const results = [];
    let imported = 0, failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rn = i + 2;
      const { serviceType } = row;
      const label = [serviceType, row.details].filter(Boolean).join(' / ') || `Row ${rn}`;

      if (!serviceType?.trim()) {
        results.push(rowResult(rn, label, 'failed', 'Missing required: serviceType'));
        failed++; continue;
      }

      const ratePerGallon = parseRate(row.ratePerGallon);
      const ratePerMile   = parseRate(row.ratePerMile);
      const hourlyRate    = parseRate(row.hourlyRate);
      const effectiveFrom = parseDateField(row.effectiveFrom) ?? new Date();
      const effectiveTo   = parseDateField(row.effectiveTo);
      const details       = safeStr(row.details);

      if (isNaN(effectiveFrom.getTime())) {
        results.push(rowResult(rn, label, 'failed', `Invalid effectiveFrom date: "${row.effectiveFrom}"`));
        failed++; continue;
      }

      try {
        // Upsert: match on serviceType + details + effectiveFrom
        const existing = await prisma.rate.findFirst({
          where: {
            serviceType: { equals: String(serviceType).trim(), mode: 'insensitive' },
            details:     details ? { equals: details, mode: 'insensitive' } : null,
            effectiveFrom,
          },
        });
        if (existing) {
          await prisma.rate.update({
            where: { id: existing.id },
            data: { serviceType: String(serviceType).trim(), details, ratePerGallon, ratePerMile, hourlyRate, effectiveFrom, effectiveTo },
          });
        } else {
          await prisma.rate.create({
            data: { serviceType: String(serviceType).trim(), details, ratePerGallon, ratePerMile, hourlyRate, effectiveFrom, effectiveTo },
          });
        }
        results.push(rowResult(rn, label, 'imported'));
        imported++;
      } catch (e) {
        results.push(rowResult(rn, label, 'failed', e.message));
        failed++;
      }
    }

    res.json({ summary: { total: rows.length, imported, failed }, results });
  } catch (err) { next(err); }
});

// POST /api/import/invoices/rows
router.post('/import/invoices/rows', auth, async (req, res, next) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0)
      return res.status(400).json({ error: 'rows array is required' });

    const results = [];
    let imported = 0, failed = 0;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rn = i + 2;
      const { invoiceNumber, clientName, startDate, endDate } = row;
      const label = invoiceNumber || `Row ${rn}`;

      if (!invoiceNumber || !clientName || !startDate || !endDate) {
        results.push(rowResult(rn, label, 'failed', 'Missing required: invoiceNumber, clientName, startDate, endDate'));
        failed++; continue;
      }

      const client = await prisma.client.findFirst({
        where: { clientName: { equals: String(clientName).trim(), mode: 'insensitive' } },
      });
      if (!client) {
        results.push(rowResult(rn, label, 'failed', `Client "${clientName}" not found`));
        failed++; continue;
      }

      const totalAmount = parseFloat(row.totalAmount) || 0;
      const status = ['paid', 'unpaid'].includes(String(row.status || '').toLowerCase())
        ? String(row.status).toLowerCase()
        : 'unpaid';
      const notes = safeStr(row.notes);

      try {
        const existing = await prisma.invoice.findUnique({ where: { invoiceNumber: String(invoiceNumber) } });
        if (existing) {
          await prisma.invoice.update({
            where: { id: existing.id },
            data: {
              clientId: client.id,
              startDate: new Date(startDate),
              endDate: new Date(endDate),
              totalAmount,
              status,
              notes,
            },
          });
        } else {
          await prisma.invoice.create({
            data: {
              invoiceNumber: String(invoiceNumber),
              clientId: client.id,
              startDate: new Date(startDate),
              endDate: new Date(endDate),
              totalAmount,
              status,
              notes,
            },
          });
        }
        results.push(rowResult(rn, label, 'imported'));
        imported++;
      } catch (e) {
        results.push(rowResult(rn, label, 'failed', e.message));
        failed++;
      }
    }

    res.json({ summary: { total: rows.length, imported, failed }, results });
  } catch (err) { next(err); }
});

module.exports = router;
