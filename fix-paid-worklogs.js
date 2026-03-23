/**
 * One-time fix: update billingStatus to 'Paid' for all work logs
 * linked to invoices that are already in Paid or Closed status.
 *
 * Run once from the backend folder:
 *   node fix-paid-worklogs.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find all invoices that are Paid or Closed
  const paidInvoices = await prisma.invoice.findMany({
    where: { status: { in: ['Paid', 'Closed'] } },
    select: { id: true, invoiceNumber: true, status: true },
  });

  console.log(`Found ${paidInvoices.length} Paid/Closed invoice(s).`);

  let totalUpdated = 0;
  for (const inv of paidInvoices) {
    const result = await prisma.workLog.updateMany({
      where: {
        invoiceId:     inv.id,
        billingStatus: { not: 'Paid' },   // only update those not already Paid
      },
      data: {
        billingStatus:    'Paid',
        paymentReceived:  true,
        dateReceived:     new Date(),
      },
    });
    if (result.count > 0) {
      console.log(`  Invoice ${inv.invoiceNumber} (${inv.status}): updated ${result.count} work log(s) → Paid`);
      totalUpdated += result.count;
    }
  }

  console.log(`\nDone. Total work logs updated: ${totalUpdated}`);
}

main()
  .catch((e) => { console.error('Error:', e.message); process.exit(1); })
  .finally(() => prisma.$disconnect());
