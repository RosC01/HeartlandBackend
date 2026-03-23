const PDFDocument = require('pdfkit');
const fs          = require('fs');
const path        = require('path');

// ── Palette (subtle, clean – matching the reference invoice) ─────────────────
const INK        = '#1a1a2e';   // near-black for headings / totals
const BODY       = '#333333';   // body text
const MUTED      = '#666666';   // labels, secondary text
const ROW_ALT    = '#f0f0f0';   // alternating row fill
const RULE       = '#cccccc';   // horizontal rules / borders
const PAGE_W     = 612;         // LETTER width in pts
const PAGE_H     = 792;         // LETTER height in pts
const ML         = 50;          // left margin
const MR         = 50;          // right margin
const CW         = PAGE_W - ML - MR; // usable content width = 512

function fmt(n) {
  return `$${(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}
function fmtDate(d) {
  const dt = new Date(d);
  return `${dt.getMonth() + 1}/${dt.getDate()}/${dt.getFullYear()}`;
}
function hRule(doc, y, color = RULE) {
  doc.moveTo(ML, y).lineTo(ML + CW, y).strokeColor(color).lineWidth(0.5).stroke();
}

function generateInvoicePDF(invoice, companyOverride = {}) {
  const doc = new PDFDocument({ margin: 0, size: 'LETTER', autoFirstPage: true });

  const co = {
    name:      process.env.COMPANY_NAME             || 'Heartland Field Services',
    fromName:  process.env.COMPANY_FROM_NAME        || process.env.COMPANY_NAME || 'Heartland Field Services',
    contacts:  process.env.COMPANY_FROM_CONTACTS    || '',
    address:   process.env.COMPANY_ADDRESS          || '123 Main Street',
    csz:       process.env.COMPANY_CITY_STATE_ZIP   || 'Springfield, IL 62701',
    phone:     process.env.COMPANY_PHONE            || '(555) 555-5555',
    email:     process.env.COMPANY_EMAIL            || 'billing@heartlandservices.com',
    logoPath:  process.env.LOGO_PATH                || '',
    payTerms:  process.env.PAYMENT_TERMS            || '',
    ...companyOverride,  // selected company profile overrides env defaults
  };

  const cl = invoice.client;

  // ── Section 1: Company header (top-left) + Invoice number (top-right) ──────
  let curY = 45;

  // Logo image if provided and the file exists
  if (co.logoPath && fs.existsSync(co.logoPath)) {
    doc.image(co.logoPath, ML, curY, { width: 80 });
    curY += 90;
  } else {
    // Text logo – large bold company name
    doc.font('Helvetica-Bold').fontSize(22).fillColor(INK)
       .text(co.name, ML, curY);
    curY = doc.y + 4;

    doc.font('Helvetica').fontSize(9).fillColor(BODY)
       .text(co.address, ML, curY);
    curY = doc.y + 1;
    doc.text(co.csz, ML, curY);
    curY = doc.y + 1;
    doc.text(co.phone, ML, curY);
    curY = doc.y + 1;
    doc.text(co.email, ML, curY);
    curY = doc.y + 6;
  }

  // Invoice number – large, top-right
  // Show full HLFS-YYYY-NNNN for new invoices; strip prefix for legacy plain numbers
  const isFullInvNum = /^HLFS-/i.test(String(invoice.invoiceNumber));
  const invNumStr    = isFullInvNum
    ? String(invoice.invoiceNumber)
    : (String(invoice.invoiceNumber).replace(/^[A-Z]+-\d+-?/i, '') || invoice.invoiceNumber);
  const invNumSize   = isFullInvNum ? 20 : 28;
  doc.font('Helvetica-Bold').fontSize(invNumSize).fillColor(INK)
     .text(invNumStr, ML, 45, { width: CW, align: 'right' });
  // Date below invoice number
  doc.font('Helvetica').fontSize(10).fillColor(BODY)
     .text(fmtDate(invoice.createdAt), ML, 80, { width: CW, align: 'right' });
  // Legacy / original invoice reference (if present)
  if (invoice.legacyInvoiceNumber) {
    doc.font('Helvetica').fontSize(8).fillColor(MUTED)
       .text(`Ref: ${invoice.legacyInvoiceNumber}`, ML, 94, { width: CW, align: 'right' });
  }

  // ── Section 2: FROM / TO ───────────────────────────────────────────────────
  hRule(doc, curY);
  curY += 10;

  const midX = ML + CW * 0.45; // "TO" starts here

  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
     .text('FROM', ML, curY);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
     .text('TO', midX + 30, curY);
  curY += 12;

  // FROM block
  doc.font('Helvetica').fontSize(10).fillColor(BODY)
     .text(co.fromName, ML, curY);
  if (co.contacts) {
    doc.text(co.contacts, ML, doc.y + 1);
  }

  // TO block (right column) – start at same curY
  const toStartY = curY;
  doc.font('Helvetica-Bold').fontSize(10).fillColor(INK)
     .text(cl.clientName, midX + 30, toStartY);

  let toY = toStartY + 14;
  doc.font('Helvetica').fontSize(9).fillColor(BODY);
  if (cl.address)  { doc.text(cl.address,  midX + 30, toY); toY = doc.y + 1; }
  const cityLine = [cl.city, cl.state && cl.zipCode ? `${cl.state} ${cl.zipCode}` : (cl.state || cl.zipCode || '')].filter(Boolean).join(', ');
  if (cityLine)    { doc.text(cityLine,    midX + 30, toY); toY = doc.y + 1; }
  if (cl.email)    { doc.text(cl.email,    midX + 30, toY); toY = doc.y + 1; }

  curY = Math.max(doc.y, toY) + 16;

  // ── Section 3: JOB / PAYMENT TERMS ────────────────────────────────────────
  hRule(doc, curY);
  curY += 8;

  // Determine dominant service type for the job label
  const serviceTypes = [...new Set(invoice.workLogs.map((l) => l.serviceType).filter(Boolean))];
  const jobLabel = serviceTypes.length ? serviceTypes.join(' / ').toUpperCase() : 'FIELD SERVICES';

  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
     .text('JOB', ML, curY);
  doc.font('Helvetica-Bold').fontSize(8).fillColor(MUTED)
     .text('PAYMENT TERMS', midX + 30, curY);
  curY += 12;

  doc.font('Helvetica').fontSize(10).fillColor(BODY)
     .text(jobLabel, ML, curY);

  // Payment terms – parse into rate table rows and note lines
  // Set SHOW_RATE_SCHEDULE=false in .env to omit the rate table from PDFs
  const showRateSchedule = process.env.SHOW_RATE_SCHEDULE !== 'false';

  const allTermLines = co.payTerms
    ? co.payTerms.split('|').map((s) => s.trim())
    : (() => {
        const seen = new Set();
        const lines = [];
        invoice.workLogs.forEach((l) => {
          if (l.hourlyRate) {
            const k = `${l.serviceType || 'Service'}-${l.hourlyRate}`;
            if (!seen.has(k)) { seen.add(k); lines.push(`${l.serviceType || 'Service'} - $${l.hourlyRate}/hr`); }
          }
          if (l.ratePerGallon) {
            const k = `gal-${l.ratePerGallon}`;
            if (!seen.has(k)) { seen.add(k); lines.push(`Application - $${l.ratePerGallon}/gal`); }
          }
          if (l.ratePerMile) {
            const k = `mi-${l.ratePerMile}`;
            if (!seen.has(k)) { seen.add(k); lines.push(`Mileage - $${l.ratePerMile}/mi`); }
          }
        });
        if (lines.length) lines.push('ALL JOBS ARE CHARGED BY THE HOUR WITH A MINIMUM OF 1 HOUR');
        return lines.length ? lines : ['Payment due upon receipt.'];
      })();

  // Split: lines with " - $" are rate rows; everything else is a note
  // Filter out empty lines and bare column-header artifacts (e.g. "Service Rate")
  const SKIP_NOTE = /^(service\s*rate|rate|service)$/i;
  const rateRows  = allTermLines.filter((l) => l && / - \$/.test(l));
  const noteLines = allTermLines.filter((l) => l && !/ - \$/.test(l) && !SKIP_NOTE.test(l.trim()));

  let termY = curY;
  const tblX    = midX + 30;
  const tblW    = ML + CW - tblX;
  const colSvcW = Math.floor(tblW * 0.64);
  const colRteW = tblW - colSvcW;

  if (showRateSchedule && rateRows.length > 0) {
    const rowH = 15;
    const hdrH = 16;
    const tableStartY = termY;

    // Header row
    doc.rect(tblX, termY, tblW, hdrH).fill('#e0e0e0');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK)
       .text('Service', tblX + 4, termY + 4, { width: colSvcW - 6, lineBreak: false });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(INK)
       .text('Rate', tblX + colSvcW, termY + 4, { width: colRteW - 4, align: 'right', lineBreak: false });
    termY += hdrH;

    rateRows.forEach((line, i) => {
      const dashIdx = line.indexOf(' - ');
      const svc  = dashIdx !== -1 ? line.slice(0, dashIdx).trim() : line;
      const rate = dashIdx !== -1 ? line.slice(dashIdx + 3).trim() : '';

      if (i % 2 === 1) doc.rect(tblX, termY, tblW, rowH).fill(ROW_ALT);
      doc.font('Helvetica').fontSize(8).fillColor(BODY)
         .text(svc,  tblX + 4,       termY + 3, { width: colSvcW - 6, lineBreak: false });
      doc.font('Helvetica').fontSize(8).fillColor(BODY)
         .text(rate, tblX + colSvcW, termY + 3, { width: colRteW - 4, align: 'right', lineBreak: false });
      termY += rowH;
    });

    // Border around the entire table
    doc.rect(tblX, tableStartY, tblW, termY - tableStartY).strokeColor(RULE).lineWidth(0.5).stroke();
    termY += 5;
  }

  // Note lines (e.g. "ALL JOBS ARE CHARGED BY THE HOUR...") rendered below the table
  noteLines.forEach((line) => {
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED)
       .text(line, tblX, termY, { width: tblW });
    termY = doc.y + 2;
  });

  curY = Math.max(doc.y, termY) + 14;
  hRule(doc, curY);
  curY += 12;

  // ── Section 4: Line Items Table ────────────────────────────────────────────
  // Columns:  DESCRIPTION | Service | Date | Qty | Rate | Total

  // Derive the quantity column label from the billing basis across all logs
  const hasGallons = invoice.workLogs.some(l => l.gallons);
  const hasHours   = invoice.workLogs.some(l => l.hours);
  const hasMileage = invoice.workLogs.some(l => l.mileage);
  const hasAcres   = invoice.workLogs.some(l => l.acres);
  const basisCount = [hasGallons, hasHours, hasMileage].filter(Boolean).length;
  const qtyLabel   = basisCount > 1 ? 'Quantity'
                   : hasGallons     ? 'Gallons'
                   : hasHours       ? 'Hours'
                   : hasMileage     ? 'Miles'
                   : hasAcres       ? 'Acres'
                   : 'Quantity';

  const col = {
    desc:    { x: ML,           w: 138, label: 'DESCRIPTION', align: 'left'  },
    service: { x: ML + 138,     w: 98,  label: 'Service',     align: 'left'  },
    date:    { x: ML + 236,     w: 70,  label: 'Date',        align: 'left'  },
    hours:   { x: ML + 306,     w: 70,  label: qtyLabel,      align: 'right' },
    rate:    { x: ML + 376,     w: 56,  label: 'Rate',        align: 'right' },
    total:   { x: ML + 432,     w: CW - 432, label: 'Total',  align: 'right' },
  };

  // Table header (bold text, bottom rule)
  Object.values(col).forEach((c) => {
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(INK)
       .text(c.label, c.x + 2, curY, { width: c.w - 4, align: c.align || 'left' });
  });
  curY += 14;
  hRule(doc, curY);
  curY += 4;

  let grandTotal = 0;

  invoice.workLogs.forEach((log, idx) => {
    // Build description: site name (+ field if present)
    const desc = [
      log.site?.siteName,
      log.field?.fieldName,
    ].filter(Boolean).join(' / ') || cl.clientName;

    // Dynamic row height — expand when description wraps
    doc.font('Helvetica').fontSize(9);
    const descH = doc.heightOfString(desc, { width: col.desc.w - 4 });
    const rowH  = Math.max(20, descH + 10);

    // Alternating row fill
    if (idx % 2 === 1) {
      doc.rect(ML, curY, CW, rowH).fill(ROW_ALT);
    }

    // Determine display rate
    let rateDisplay = '';
    if (log.hourlyRate)    rateDisplay = `$${log.hourlyRate}`;
    else if (log.ratePerGallon) rateDisplay = `$${log.ratePerGallon}/gal`;
    else if (log.ratePerMile)   rateDisplay = `$${log.ratePerMile}/mi`;

    const qtyDisplay = [
      log.hours   ? String(log.hours)               : null,
      log.gallons ? `${Number(log.gallons).toLocaleString('en-US')} gal` : null,
      log.mileage ? `${log.mileage} mi`             : null,
    ].filter(Boolean).join(' / ') || '—';

    const textY = curY + 4;
    doc.font('Helvetica').fontSize(9).fillColor(BODY);
    doc.text(desc,                      col.desc.x    + 2, textY, { width: col.desc.w    - 4 });
    doc.text(log.serviceType || '—',    col.service.x + 2, textY, { width: col.service.w - 4 });
    doc.text(fmtDate(log.date),         col.date.x    + 2, textY, { width: col.date.w    - 4 });
    doc.text(qtyDisplay,                col.hours.x   + 2, textY, { width: col.hours.w   - 4, align: 'right' });
    doc.text(rateDisplay,               col.rate.x    + 2, textY, { width: col.rate.w    - 4, align: 'right' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor(INK)
       .text(fmt(log.lineTotal),        col.total.x   + 2, textY, { width: col.total.w   - 4, align: 'right' });

    grandTotal += log.lineTotal || 0;
    curY += rowH;

    // Notes sub-row
    if (log.notes) {
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED)
         .text(`  ${log.notes}`, col.desc.x + 8, curY + 2, { width: CW - 12 });
      curY += 14;
    }

    // Page overflow guard
    if (curY > PAGE_H - 130) {
      doc.addPage();
      curY = ML;
    }
  });

  // Bottom rule + empty spacer row (matches the blank row before TOTAL DUE in image)
  curY += 4;
  hRule(doc, curY);
  curY += 20;
  hRule(doc, curY);
  curY += 10;

  // ── Section 5: TOTAL DUE ───────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
     .text('TOTAL DUE', ML, curY, { width: CW - (col.total.w + 4), align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).fillColor(INK)
     .text(fmt(grandTotal), col.total.x + 2, curY, { width: col.total.w - 4, align: 'right' });
  curY += 22;

  // ── Section 6: Footer ─────────────────────────────────────────────────────
  const footerY = Math.max(curY + 30, PAGE_H - 80);
  hRule(doc, footerY - 4);

  doc.font('Helvetica-Oblique').fontSize(9).fillColor(BODY)
     .text(`Make all checks payable to ${co.fromName || co.name}.`, ML, footerY + 4, { width: CW, align: 'center' });
  doc.font('Helvetica-BoldOblique').fontSize(10).fillColor(INK)
     .text('THANK YOU FOR YOUR BUSINESS!', ML, doc.y + 4, { width: CW, align: 'center' });

  return doc;
}

module.exports = { generateInvoicePDF };
