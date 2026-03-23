const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
p.appSetting.findMany().then(r => {
  console.log('AppSetting rows:', r.length, '- OK');
  return p.$disconnect();
});
