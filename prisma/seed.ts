import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/auth';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DEMO_TEAM, validateDemoTeam, DemoUserSpec } from './demo-team';
import { DEFAULT_JOB_TITLES } from '../src/lib/access-config';

const prisma = new PrismaClient();

// ═══════════════════════════════════════════════════════════
// تنظیمات ادمین: نام کاربری و رمز عبور دلخواه
// ═══════════════════════════════════════════════════════════
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = '12345678';

async function main() {
  // Create default business units
  await prisma.businessUnit.upsert({
    where: { id: 'production' },
    update: {},
    create: {
      id: 'production',
      name: 'واحد تولید',
      label: 'تولید',
      features: JSON.stringify({ productionWorkspace: true, inventoryMode: 'serial' }),
      userIds: '[]',
    },
  });

  await prisma.businessUnit.upsert({
    where: { id: 'trading' },
    update: {},
    create: {
      id: 'trading',
      name: 'واحد تجاری',
      label: 'تجاری',
      features: JSON.stringify({ productionWorkspace: false, inventoryMode: 'quantity' }),
      userIds: '[]',
    },
  });

  // Create the initial admin account
  const adminExisted = !!(await prisma.user.findUnique({ where: { username: ADMIN_USERNAME }, select: { id: true } }));
  await prisma.user.upsert({
    where: { username: ADMIN_USERNAME },
    update: { passwordHash: hashPassword(ADMIN_PASSWORD) }, // هر بار پسورد را ریست می‌کند
    create: {
      username: ADMIN_USERNAME,
      displayName: 'مدیر سیستم',
      passwordHash: hashPassword(ADMIN_PASSWORD),
      role: 'admin',
      roleLabel: 'مدیر سیستم',
      companyIds: '[]', // admin sees all companies
      businessUnitId: 'production',
      isActive: true,
    },
  });

  // Send a welcome letter to the initial admin so the mailbox isn't empty
  try {
    const admin = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } });
    if (admin) {
      await prisma.letter.create({
        data: {
          subject: 'خوش آمدید به سامانهٔ BGL CRM',
          body: 'سلام و خوش آمدید!\n\nاین نامهٔ خوشامدگویی است. از این پس می‌توانید هماهنگی‌های تیمی، ابلاغ گردش اسناد و پیام‌های داخلی را از این صندوق پیگیری کنید.\n\nبرای شروع:\n• از منوی «اسناد فروش» اولین پیش‌فاکتور را ثبت کنید\n• محصولات و مشخصات فنی آن‌ها را از منوی «محصولات» تکمیل کنید\n• مراکز و مشتریان را ثبت و پیگیری‌ها را زمان‌بندی کنید\n\nموفق باشید!',
          senderId: admin.id,
          recipients: { create: [{ userId: admin.id }] },
        },
      });
    }
  } catch { /* welcome letter optional */ }

  // ── default companies ─────────────────────────────
  const companies = [
    {
      slug: 'holding', name: 'بهبود گستر (هلدینگ)', type: 'هلدینگ مادر گروه', color: '#2E2A5C', accentColor: '#1F8B7D', tagline: 'هلدینگ مادر گروه بهبود گستر',
      logo: '/logo-holding.png', printTemplate: 'holding',
      phone: '09125154753',
      headOfficeAddress: 'تهران، بزرگ‌راه تهران–قم، شهرک صنعتی شمس‌آباد، خیابان پنجم شمالی (دفتر مرکزی)',
      website: 'www.BGL.ir',
      nationalId: null, address: null, postalCode: null,
      bankName: null, bankAccountHolder: null, bankAccountNumber: null, bankSheba: null,
    },
    {
      slug: 'bazargani', name: 'بهبود گستر لیان ایرانیان', type: 'واحد بازرگانی گروه', color: '#0891b2', accentColor: '#164e63', logo: '/logo-bgl-white-full.png', tagline: 'واحد بازرگانی',
      printTemplate: 'lian',
      nationalId: '14015339159',
      address: 'خوزستان، دزفول، شهرک صنعتی شماره ۱، انتهای خیابان ششم',
      phone: '06142547982',
      postalCode: '6465120185',
      bankName: 'بانک رفاه',
      bankAccountHolder: 'شرکت بهبود گستر لیان ایرانیان',
      bankAccountNumber: '439019308',
      bankSheba: 'IR710130100000000439019308',
    },
    { slug: 'aria', name: 'آریا مدیکال', type: 'فروش دستگاه و تجهیزات کمک تنفسی', color: '#7c3aed', accentColor: '#4A235A', logo: '/logo-aria-full.png', tagline: 'فروش تجهیزات و مصرفی‌های پزشکی و آزمایشگاه',
      printTemplate: 'aria', phone: '09125154753',
      headOfficeAddress: 'تهران، خیابان نباب، خیابان آذربایجان',
      website: 'www.ariamedical.ir',
      nationalId: null, address: null, postalCode: null,
      bankName: null, bankAccountHolder: null, bankAccountNumber: null, bankSheba: null },
    { slug: 'bgl', name: 'بهبود گستر لیام ایرانیان', type: 'تولید دستگاه‌های خلوص‌سنج', color: '#1F8B7D', accentColor: '#2E2A5C', logo: '/logo-bgl-white-full.png', tagline: 'تولیدکنندهٔ دستگاه‌های خلوص‌سنج',
      printTemplate: 'lian', phone: '09125154753',
      nationalId: null, address: null, postalCode: null,
      bankName: null, bankAccountHolder: null, bankAccountNumber: null, bankSheba: null },
    {
      slug: 'yasteb', name: 'یاس طب', type: 'تولید ست‌های ونتیلاتور', color: '#134E4A', accentColor: '#0D9488',
      logo: '/logo-yasteb.png', tagline: 'تولیدکنندهٔ ست‌های ونتیلاتور',
      printTemplate: 'yasteb', phone: '09125154753',
      headOfficeAddress: 'تهران، خیابان نباب، خیابان آذربایجان',
      website: 'www.yastebderak.ir',
      isIsolated: true,
      nationalId: null, address: null, postalCode: null,
      bankName: null, bankAccountHolder: null, bankAccountNumber: null, bankSheba: null,
    },
  ];
  for (const c of companies) {
    const { slug: _slug, ..._profile } = c;
    await prisma.company.upsert({
      where: { slug: c.slug },
      update: {},
      create: c,
    });
  }

  // Create default products
  const products = [
    { code: 'P001', name: 'ست‌های ونتیلاتور پرتابل', price: 0, unit: 'عدد', source: 'پیش‌فرض' },
    { code: 'P002', name: 'خلوص سنج پرتابل', price: 0, unit: 'عدد', source: 'پیش‌فرض' },
    { code: 'P003', name: 'خلوص سنج دیواری', price: 0, unit: 'عدد', source: 'پیش‌فرض' },
    { code: 'P004', name: 'اسمارت کاف', price: 0, unit: 'عدد', source: 'پیش‌فرض' },
    { code: '000019', name: 'لارنژال ماسک PVC سایز ۲/۵ برند well lead', price: 7140000, unit: 'عدد', source: 'پیش‌فرض', category: 'مصرفی', ircCode: '9087404071772735' },
  ];
  for (const p of products) {
    await prisma.product.upsert({ where: { code: p.code }, update: {}, create: p });
  }

  // demo centers
  const demoCenters = [
    { name: 'بیمارستان ولایت (نمونه)', companySlug: 'bazargani', province: 'خوزستان', city: 'دزفول', customerType: 'organization', phone: '06142547982' },
    { name: 'درمانگاه نمونهٔ یاس طب', companySlug: 'yasteb', province: 'تهران', city: 'تهران', customerType: 'organization', phone: '02112345678' },
  ];
  for (const c of demoCenters) {
    const comp = await prisma.company.findUnique({ where: { slug: c.companySlug }, select: { id: true } });
    if (!comp) continue;
    const existing = await prisma.center.findFirst({
      where: { name: c.name, companyId: comp.id },
      select: { id: true },
    });
    if (!existing) {
      const { companySlug: _slug, ...row } = c;
      await prisma.center.create({
        data: { ...row, companyId: comp.id, businessUnitId: 'production', searchKey: c.name },
      });
    }
  }

  // Create default meta settings
  await prisma.meta.upsert({
    where: { key: 'app.name' },
    update: {},
    create: { key: 'app.name', value: 'BGL | سامانه جامع مدیریت مراکز و فروش' },
  });
  await prisma.meta.upsert({
    where: { key: 'app.version' },
    update: {},
    create: { key: 'app.version', value: '2.58.10' },
  });
  await prisma.meta.upsert({
    where: { key: 'app.website' },
    update: {},
    create: { key: 'app.website', value: 'www.BGL.ir' },
  });

  // Optional demo staff accounts
  if (process.env.SEED_DEMO_USERS === 'true') {
    const drift = validateDemoTeam(DEMO_TEAM);
    if (drift.length > 0) {
      console.error('[seed] DEMO_TEAM failed its drift guard — refusing to seed:');
      for (const e of drift) console.error(`[seed]   • ${e}`);
      process.exit(1);
    }
    await seedDemoTeam();
  }

  console.log('Seed completed successfully!');
  console.log('═══════════════════════════════════════════════');
  console.log('  Initial administrator account');
  console.log(`  username: ${ADMIN_USERNAME}`);
  console.log(`  password: ${ADMIN_PASSWORD}`);
  console.log('═══════════════════════════════════════════════');
}

function writeFirstLoginFile(username: string, password: string): void {
  try {
    const target = path.resolve(__dirname, '..', 'FIRST-LOGIN.txt');
    const stamp = new Date().toISOString();
    fs.writeFileSync(
      target,
      [
        'BGL CRM — مشخصات ورود نخستین (این نصب)',
        `تولید‌شده: ${stamp}`,
        '',
        `username: ${username}`,
        `password: ${password}`,
        '',
        'این فایل فقط روی همین سیستم و هنگام نصب ساخته شده است.',
        'رمز را پس از اولین ورود از «تنظیمات» تغییر کنید و',
        'همین فایل را حذف کنید (delete this file after first login).',
        '',
        'فراموشی رمز:  npm run reset:admin',
        '',
      ].join('\n'),
      { encoding: 'utf-8', mode: 0o600 },
    );
    console.log(`  (FIRST-LOGIN.txt نوشته شد در ریشهٔ نصب: ${target})`);
  } catch (e) {
    console.warn(`  [seed] could not write FIRST-LOGIN.txt: ${String(e)}`);
  }
}

async function seedDemoTeam(): Promise<void> {
  const explicitDemoPassword = process.env.SEED_DEMO_PASSWORD || null;
  const demoPassword = explicitDemoPassword || crypto.randomBytes(9).toString('base64url');
  const registry = new Map(DEFAULT_JOB_TITLES.map((t) => [t.key, t]));

  console.log('[seed] SEED_DEMO_USERS=true — creating demo staff accounts…');
  for (const u of DEMO_TEAM as DemoUserSpec[]) {
    const entry = registry.get(u.jobTitle)!;
    const update = explicitDemoPassword ? { passwordHash: hashPassword(explicitDemoPassword) } : {};
    await prisma.user.upsert({
      where: { username: u.username },
      update,
      create: {
        username: u.username,
        displayName: u.displayName,
        passwordHash: hashPassword(demoPassword),
        role: entry.baseRole,
        roleLabel: entry.label,
        jobTitle: entry.key,
        province: u.province || null,
        companyIds: JSON.stringify(u.companyIds),
        businessUnitId: u.businessUnitId,
        isActive: true,
      },
    });
    if (explicitDemoPassword) {
      const demo = await prisma.user.findUnique({ where: { username: u.username } });
      if (demo) {
        await prisma.session.updateMany({
          where: { userId: demo.id, revokedAt: null },
          data: { revokedAt: new Date() },
        }).catch(() => undefined);
        await prisma.loginAttempt.deleteMany({ where: { userId: demo.id } }).catch(() => undefined);
      }
    }
  }

  console.log('═══════════════════════════════════════════════');
  console.log('  Demo staff accounts (SEED_DEMO_USERS)');
  for (const u of DEMO_TEAM) {
    const entry = registry.get(u.jobTitle)!;
    console.log(`  ${u.username.padEnd(18)} ${entry.label} — شرکت‌ها: ${u.companyIds.join(', ')}`);
  }
  console.log(`  shared password: ${demoPassword}`);
  console.log('  (Demo accounts — change or deactivate them');
  console.log('   before real production use.)');
  console.log('═══════════════════════════════════════════════');
  if (explicitDemoPassword) {
    console.warn('[seed] SEED_DEMO_PASSWORD was set via environment — consider unsetting it.');
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });