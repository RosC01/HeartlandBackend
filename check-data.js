const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const siteTotal  = await p.site.count();
  const siteActive = await p.site.count({ where: { isActive: true } });
  const fieldTotal  = await p.field.count();
  const fieldActive = await p.field.count({ where: { isActive: true } });
  const rateTotal  = await p.rate.count();
  const rateActive = await p.rate.count({ where: { isActive: true } });

  console.log(`sites  — total: ${siteTotal},  isActive=true: ${siteActive}`);
  console.log(`fields — total: ${fieldTotal}, isActive=true: ${fieldActive}`);
  console.log(`rates  — total: ${rateTotal},  isActive=true: ${rateActive}`);
}

main().catch(console.error).finally(() => p.$disconnect());
