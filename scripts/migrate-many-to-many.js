/**
 * One-time migration script: copies Site.clientId values into the
 * _ClientToSite join table before prisma db push drops the column.
 *
 * Run ONCE before `npx prisma db push`:
 *   node scripts/migrate-many-to-many.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  console.log('Creating _ClientToSite join table…');
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_ClientToSite" (
      "A" integer NOT NULL,
      "B" integer NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "_ClientToSite_AB_unique" ON "_ClientToSite"("A", "B")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "_ClientToSite_B_index" ON "_ClientToSite"("B")`
  );

  console.log('Copying site→client associations from Site.clientId…');
  const count = await prisma.$executeRawUnsafe(`
    INSERT INTO "_ClientToSite" ("A", "B")
    SELECT "clientId", "id" FROM "Site" WHERE "clientId" IS NOT NULL
    ON CONFLICT DO NOTHING
  `);
  console.log(`  → inserted ${count} associations`);

  console.log('Creating _ClientToField join table…');
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "_ClientToField" (
      "A" integer NOT NULL,
      "B" integer NOT NULL
    )
  `);
  await prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "_ClientToField_AB_unique" ON "_ClientToField"("A", "B")`
  );
  await prisma.$executeRawUnsafe(
    `CREATE INDEX IF NOT EXISTS "_ClientToField_B_index" ON "_ClientToField"("B")`
  );
  console.log('  → done (no existing data to migrate for fields)');

  console.log('Data migration complete. Now run: npx prisma db push --accept-data-loss');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
