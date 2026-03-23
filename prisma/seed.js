const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Admin user
  const hashedPassword = await bcrypt.hash('admin123', 12);
  await prisma.user.upsert({
    where: { username: 'admin' },
    update: {},
    create: { username: 'admin', password: hashedPassword, role: 'admin', email: 'admin@heartlandservices.com' },
  });
  await prisma.user.upsert({
    where: { username: 'staff1' },
    update: {},
    create: { username: 'staff1', password: await bcrypt.hash('staff123', 12), role: 'staff', email: 'staff@heartlandservices.com' },
  });

  // Rates
  const ratesData = [
    { serviceType: 'Fertilizer Application', ratePerGallon: 0.15, ratePerMile: 1.25, hourlyRate: null },
    { serviceType: 'Herbicide Application',  ratePerGallon: 0.18, ratePerMile: 1.25, hourlyRate: null },
    { serviceType: 'Pesticide Application',  ratePerGallon: 0.20, ratePerMile: 1.25, hourlyRate: null },
    { serviceType: 'Snow Removal',           ratePerGallon: null,  ratePerMile: 2.50, hourlyRate: 85.00 },
    { serviceType: 'General Field Service',  ratePerGallon: null,  ratePerMile: 1.25, hourlyRate: 75.00 },
  ];
  for (const rate of ratesData) {
    await prisma.rate.upsert({ where: { serviceType: rate.serviceType }, update: rate, create: rate });
  }

  // Clients
  const client1 = await prisma.client.upsert({
    where: { id: 1 }, update: {},
    create: { clientName: 'Johnson Family Farm', address: '4521 County Road 550', city: 'Champaign', state: 'IL', zipCode: '61820', phoneNumber: '(217) 555-1234', email: 'johnson@jffarm.com', clientCode: 'C-001' },
  });
  const client2 = await prisma.client.upsert({
    where: { id: 2 }, update: {},
    create: { clientName: 'Green Acres Agriculture', address: '890 Prairie Road', city: 'Bloomington', state: 'IL', zipCode: '61701', phoneNumber: '(309) 555-8765', email: 'contact@greenacres.ag', clientCode: 'C-002' },
  });

  // Employees
  const emp1 = await prisma.employee.upsert({
    where: { id: 1 }, update: {},
    create: { workerName: 'Mike Thompson', title: 'Lead Field Operator', phone: '(217) 555-9876', email: 'mthompson@heartland.com', active: true, employeeCode: 'E-001' },
  });
  const emp2 = await prisma.employee.upsert({
    where: { id: 2 }, update: {},
    create: { workerName: 'Sarah Williams', title: 'Field Technician', phone: '(217) 555-4321', email: 'swilliams@heartland.com', active: true, employeeCode: 'E-002' },
  });

  // Sites
  const site1 = await prisma.site.upsert({
    where: { id: 1 }, update: {},
    create: { siteName: 'North Farm', clientId: client1.id, siteCode: 'S-001' },
  });
  const site2 = await prisma.site.upsert({
    where: { id: 2 }, update: {},
    create: { siteName: 'South Farm', clientId: client1.id, siteCode: 'S-002' },
  });
  const site3 = await prisma.site.upsert({
    where: { id: 3 }, update: {},
    create: { siteName: 'Main Property', clientId: client2.id, siteCode: 'S-003' },
  });

  // Fields
  const existingFields = await prisma.field.count();
  if (existingFields === 0) {
    await prisma.field.createMany({
      data: [
        { fieldName: 'Field A - North 40', siteId: site1.id },
        { fieldName: 'Field B - South 60', siteId: site1.id },
        { fieldName: 'Field C - Corn Ground', siteId: site2.id },
        { fieldName: 'Field D - Soy Ground', siteId: site2.id },
        { fieldName: 'West Pasture', siteId: site3.id },
        { fieldName: 'East Cropland', siteId: site3.id },
      ],
    });
  }

  // Sample work logs
  const existingLogs = await prisma.workLog.count();
  if (existingLogs === 0) {
    const today = new Date();
    const logsData = [
      { date: new Date(today.getFullYear(), today.getMonth(), 1),  workerId: emp1.id, clientId: client1.id, clientName: client1.clientName, siteId: site1.id, serviceType: 'Fertilizer Application', gallons: 1200, mileage: 45, ratePerGallon: 0.15, ratePerMile: 1.25, lineTotal: 1200 * 0.15 + 45 * 1.25, billed: false },
      { date: new Date(today.getFullYear(), today.getMonth(), 5),  workerId: emp2.id, clientId: client1.id, clientName: client1.clientName, siteId: site2.id, serviceType: 'Herbicide Application', gallons: 800,  mileage: 30, ratePerGallon: 0.18, ratePerMile: 1.25, lineTotal: 800 * 0.18 + 30 * 1.25, billed: false },
      { date: new Date(today.getFullYear(), today.getMonth(), 8),  workerId: emp1.id, clientId: client2.id, clientName: client2.clientName, siteId: site3.id, serviceType: 'Fertilizer Application', gallons: 1500, mileage: 60, ratePerGallon: 0.15, ratePerMile: 1.25, lineTotal: 1500 * 0.15 + 60 * 1.25, billed: false },
      { date: new Date(today.getFullYear(), today.getMonth(), 12), workerId: emp2.id, clientId: client2.id, clientName: client2.clientName, siteId: site3.id, serviceType: 'Snow Removal',           mileage: 85,  hours: 4, ratePerMile: 2.50, hourlyRate: 85.00, lineTotal: 85 * 2.50 + 4 * 85.00, billed: false },
      { date: new Date(today.getFullYear(), today.getMonth() - 1, 15), workerId: emp1.id, clientId: client1.id, clientName: client1.clientName, siteId: site1.id, serviceType: 'Pesticide Application', gallons: 600, mileage: 25, ratePerGallon: 0.20, ratePerMile: 1.25, lineTotal: 600 * 0.20 + 25 * 1.25, billed: true },
    ];
    await prisma.workLog.createMany({ data: logsData });
  }

  console.log('✅ Database seeded successfully!');
  console.log('   Admin login: admin / admin123');
  console.log('   Staff login: staff1 / staff123');

  // Backfill any existing records that are missing their codes
  const [clients, sites, fields, employees] = await Promise.all([
    prisma.client.findMany({ where: { clientCode: null } }),
    prisma.site.findMany({ where: { siteCode: null } }),
    prisma.field.findMany({ where: { fieldCode: null } }),
    prisma.employee.findMany({ where: { employeeCode: null } }),
  ]);
  for (const c of clients)   await prisma.client.update({ where: { id: c.id }, data: { clientCode:   `C-${String(c.id).padStart(3, '0')}` } });
  for (const s of sites)     await prisma.site.update({   where: { id: s.id }, data: { siteCode:     `S-${String(s.id).padStart(3, '0')}` } });
  for (const f of fields)    await prisma.field.update({  where: { id: f.id }, data: { fieldCode:    `F-${String(f.id).padStart(3, '0')}` } });
  for (const e of employees) await prisma.employee.update({ where: { id: e.id }, data: { employeeCode: `E-${String(e.id).padStart(3, '0')}` } });
  const backfilled = clients.length + sites.length + fields.length + employees.length;
  if (backfilled > 0) console.log(`   Backfilled codes for ${backfilled} record(s).`);
}
main().catch(console.error).finally(() => prisma.$disconnect());
