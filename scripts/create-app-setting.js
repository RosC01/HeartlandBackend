const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
async function run() {
  await p.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "AppSetting" (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log('AppSetting table ready.');
  await p.$disconnect();
}
run().catch(e => { console.error(e.message); process.exit(1); });
