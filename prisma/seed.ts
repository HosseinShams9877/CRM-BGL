import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../src/lib/auth';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DEMO_TEAM, validateDemoTeam, DemoUserSpec } from './demo-team';
import { DEFAULT_JOB_TITLES } from '../src/lib/access-config';

const prisma = new PrismaClient();

// ═══════════════════════════════════════════════════════════
// SECURITY: no hardcoded passwords anymore.
// - The admin password is generated randomly (or taken from
//   SEED_ADMIN_PASSWORD env var) and printed ONCE to the console.
// - Demo staff accounts are NOT created unless SEED_DEMO_USERS=true.
// ═══════════════════════════════════════════════════════════

const ADMIN_USERNAME = 'admin';
const adminPassword = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');

async function main() {
  // v2.22.0 — WAL mode for every install. journal_mode is a persistent,
  // per-database setting, but nothing set it automatically: fresh installs
  // ran in the default `delete` journal (slower writes, whole-file locks
  // during checkpoints, no snapshot reads for concurrent backups). WAL is
  // what the production notes in INSTALL.md §۱۰ assume; enabling it here is
  // idempotent — re-running seed on an existing WAL database is a no-op.
  await prisma.$queryRawUnsafe('PRAGMA journal_mode=WAL');

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

  // Create the initial admin account (random password, printed below).
  // v2.30.0: the upsert previously used `update: {}`, so re-running seed with
  // SEED_ADMIN_PASSWORD (the documented lost-password recovery path in
  // INSTALL.md §troubleshooting and WINDOWS.md) silently did NOTHING on an
  // existing database — the old hash stayed in place. When the password is
  // EXPLICITLY provided via env, we now rewrite the hash (and revoke the
  // admin's active sessions, because a password reset must kill sessions).
  // A random print-once password (fresh installs) keeps the no-op update.
  const explicitSeedPassword = process.env.SEED_ADMIN_PASSWORD || null;
  const adminExisted = !!(await prisma.user.findUnique({ where: { username: ADMIN_USERNAME }, select: { id: true } }));
  await prisma.user.upsert({
    where: { username: ADMIN_USERNAME },
    update: explicitSeedPassword
      ? { passwordHash: hashPassword(explicitSeedPassword) }
      : {},
    create: {
      username: ADMIN_USERNAME,
      displayName: 'مدیر سیستم',
      passwordHash: hashPassword(adminPassword),
      role: 'admin',
      roleLabel: 'مدیر سیستم',
      companyIds: '[]', // admin sees all companies
      businessUnitId: 'production',
      isActive: true,
    },
  });
  if (explicitSeedPassword) {
    // Password reset hygiene: revoke sessions + clear login-throttle rows.
    const admin = await prisma.user.findUnique({ where: { username: ADMIN_USERNAME } });
    if (admin) {
      await prisma.session.updateMany({
        where: { userId: admin.id, revokedAt: null },
        data: { revokedAt: new Date() },
      }).catch(() => undefined);
      await prisma.loginAttempt.deleteMany({ where: { userId: admin.id } }).catch(() => undefined);
    }
  }

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

  // ── v2.20.0 — default companies ─────────────────────────────
  // The menu catalog (src/lib/menu-catalog.ts) defines per-company menus for
  // four slugs, and Center.companyId carries the schema default "bazargani".
  // A fresh install WITHOUT these rows could not create any center (FK
  // violation — resolveScopedCompanyId found no active company). Seed them
  // idempotently so a brand-new database is immediately operable.
  const companies = [
    // v2.31.7 — logo: letterhead branding asset per company (Company.logo
    // drives the A4 print template). v2.56.0 — the holding carries its own
    // uploaded colorful BGL lockup (/logo-holding.png); آریا مدیکال has its
    // own mark (lungs icon, navy/cyan).
    // v2.31.8 — بازرگانی gets its official identity (بهبود گستر لیان ایرانیان
    // + BGL wordmark logo) and آریا gets the letterhead tagline from the
    // official invoice format (round 37).
    // v2.31.9 — بازرگانی carries the full seller profile + bank account
    // from the official Lian proforma format (پیش‌فاکتور فروش، مرجع دور ۳۸):
    // شناسه ملی، نشانی دزفول، تلفن، کد پستی و حساب بانک رفاه. These feed
    // «مشخصات فروشنده» + «اطلاعات حساب» on the printout and pre-fill the
    // read-only seller card in the data-entry form.
    // v2.31.10 — شرکت تولیدی (تولیدکنندهٔ دستگاه‌های خلوص‌سنج) gets its own
    // lockup logo (BGL wordmark + «بهبود گستر لیام ایرانیان» + descriptor
    // «شرکت تولیدکنندهٔ دستگاه‌های اندازه‌گیری» + slogan), distinct from the
    // holding's گلدن لایف mark and from the بازرگانی identity (round 39).
    // v2.34.4 — user-confirmed legal names (round 51): the manufacturer is
    // بهبود گستر لیام ایرانیان (میم — تولید دستگاه); the round-40 label
    // «بهبود گستر لیان» was a typo colliding with the trader
    // بهبود گستر لیان ایرانیان (نون — بازرگانی). BGL names the HOLDING.
    // v2.31.12 — آریا مدیکال gets the official FULL lockup (round 41:
    // lungs/ECG icon + ARIA MEDICAL wordmark + «شرکت آریا مدیکال» + the
    // official tagline «فروش تجهیزات و مصرفی‌های پزشکی و آزمایشگاه»). The
    // letterhead prints it as one brand block; the compact mark stays at
    // /logo-aria.png for the switcher/navbar tiles.
    {
      slug: 'holding', name: 'بهبود گستر (هلدینگ)', type: 'هلدینگ مادر گروه', color: '#2E2A5C', accentColor: '#1F8B7D', tagline: 'هلدینگ مادر گروه بهبود گستر',
      // v2.56.0 — the royal-indigo Holding design (round-81 upload
      // «bgl_transparent.png», the group's colorful BGL lockup): the
      // white→periwinkle→indigo banner sweep with the teal streak,
      // lavender zebra rows and the teal→indigo duotone footer. Logo =
      // the uploaded transparent lockup (sits on the banner's white
      // zone at full brand color); profile = the group contact line
      // printed in every reference footer (0912 515 4753 / www.BGL.ir)
      // + the group دفتر مرکزی.
      logo: '/logo-holding.png', printTemplate: 'holding',
      phone: '09125154753',
      headOfficeAddress: 'تهران، بزرگ‌راه تهران–قم، شهرک صنعتی شمس‌آباد، خیابان پنجم شمالی (دفتر مرکزی)',
      website: 'www.BGL.ir',
      nationalId: null, address: null, postalCode: null,
      bankName: null, bankAccountHolder: null, bankAccountNumber: null, bankSheba: null,
    },
    {
      slug: 'bazargani', name: 'بهبود گستر لیان ایرانیان', type: 'واحد بازرگانی گروه', color: '#0891b2', accentColor: '#164e63', logo: '/logo-bgl-white-full.png', tagline: 'واحد بازرگانی',
      // v2.52.0 — dedicated Lian A4 print template (sea-green + dark-purple
      // waves + gradient divider); mirrors the migration backfill so a
      // FRESH install gets the same per-company template as an upgraded one.
      printTemplate: 'lian',
      // v2.53.0 — the all-white BGL lockup sits directly on the teal banner
      // (round-77 reference composition) instead of the white-plate asset.
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
      // v2.54.0 — the medical-blue Arya reference design (round-79 upload
      // «آریامدیکال»): cyan→navy gradient banner + petrol ink. Profile
      // from the reference footer: group phone 0912 515 4753, the
      // registered address (Tehran, Navab St., Azarbaijan St.) and the
      // company site under the globe icon.
      printTemplate: 'aria', phone: '09125154753',
      headOfficeAddress: 'تهران، خیابان نباب، خیابان آذربایجان',
      website: 'www.ariamedical.ir',
      nationalId: null, address: null, postalCode: null,
      bankName: null, bankAccountHolder: null, bankAccountNumber: null, bankSheba: null },
    { slug: 'bgl', name: 'بهبود گستر لیام ایرانیان', type: 'تولید دستگاه‌های خلوص‌سنج', color: '#1F8B7D', accentColor: '#2E2A5C', logo: '/logo-bgl-white-full.png', tagline: 'تولیدکنندهٔ دستگاه‌های خلوص‌سنج',
      // v2.53.0 — the BGL production company joins the Lian reference
      // design (round-78 upload «لیام»: same sea-green/purple family with
      // the BGL identity). Phone = the group contact printed in both
      // reference footers (0912 515 4753).
      printTemplate: 'lian', phone: '09125154753',
      nationalId: null, address: null, postalCode: null,
      bankName: null, bankAccountHolder: null, bankAccountNumber: null, bankSheba: null },
    // v2.35.0 — یاس طب (ISOLATED company, round 60): a fully independent
    // tenant outside the group aggregate. isIsolated=true keeps it out of
    // every group view (holding dashboards, reports, stats, trends); only
    // users explicitly assigned to it (User.companyIds=["yasteb"]) ever
    // see its data. Its catalog and warehouse are strictly private.
    {
      slug: 'yasteb', name: 'یاس طب', type: 'تولید ست‌های ونتیلاتور', color: '#134E4A', accentColor: '#0D9488',
      // v2.55.0 — the ocean-blue Yas-Tab reference design (round-80
      // upload «یاس طب»): mirrored navy→white gradient banner + cyan
      // streak + zebra rows + the amber footer ribbon. Brand assets +
      // profile from the reference: the extracted English lockup, group
      // phone 0912 515 4753, the registered address (Tehran, Navab St.,
      // Azarbaijan St.) and the company site under the globe icon. The
      // tagline drops «(شرکت مستقل)» — isolation is a system property,
      // not a printed matter.
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
    // v2.58.1 (round 86, audit F6 — REVERSED sync policy): create-only.
    // The old `update: profile` re-ran on EVERY upgrade and overwrote the
    // company profile the settings UI has been able to edit since v2.48
    // (bank account, addresses, proformaNote, printTemplate, website —
    // the schema documents them as LIVE user data). An admin's edited
    // bank details were silently reset to the seed defaults on the next
    // `npm run db:seed`. Official-branding changes for EXISTING installs
    // now travel exclusively through migrations (the 20260904082504_
    // v2520_company_print_template backfill is the precedent); the seed
    // only guarantees a FRESH install starts with the full identity.
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
    // v2.31.9 — carries a real IRC registration code so the Lian proforma
    // format's «کد کالا / IRC» sub-line has demo data out of the box.
    { code: '000019', name: 'لارنژال ماسک PVC سایز ۲/۵ برند well lead', price: 7140000, unit: 'عدد', source: 'پیش‌فرض', category: 'مصرفی', ircCode: '9087404071772735' },
  ];
  for (const p of products) {
    await prisma.product.upsert({ where: { code: p.code }, update: {}, create: p });
  }

  // ── v2.58.3 — demo centers (create-only, idempotent) ────────
  // WHY: the integration battery (backup-snapshot, billing-payments,
  // territory/company-isolation regressions) asserts against REAL table
  // counts and a second active staff account. A fresh install previously
  // shipped zero centers, so `npm test` failed on the customer's machine
  // even though the suite was green against the developer's operational
  // database. Two create-only demo centers (one in the trading company,
  // one in the isolated company) make a fresh database self-sufficient
  // for its own test suite without touching any existing row.
  const demoCenters = [
    { name: 'بیمارستان ولایت (نمونه)', companySlug: 'bazargani', province: 'خوزستان', city: 'دزفول', customerType: 'organization', phone: '06142547982' },
    { name: 'درمانگاه نمونهٔ یاس طب', companySlug: 'yasteb', province: 'تهران', city: 'تهران', customerType: 'organization', phone: '02112345678' },
  ];
  for (const c of demoCenters) {
    // companyId is a real id (cuid), never the slug — resolve it (the
    // schema's @default("bazargani") slug default is a legacy trap).
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
  // v2.53.0 — global footer website: printed under the globe icon in the
  // contact band of every proforma/invoice (both round-77/78 references
  // show www.BGL.ir there). Editable in general settings.
  await prisma.meta.upsert({
    where: { key: 'app.website' },
    update: {},
    create: { key: 'app.website', value: 'www.BGL.ir' },
  });

  // ── v2.31.0 — optional demo staff accounts (SEED_DEMO_USERS=true) ──
  // The security banner above has promised this branch since v2.22.0 but
  // no code implemented it. Team spec + drift-guard live in ./demo-team.ts
  // (pure module, unit-tested in tests/demo-team.test.ts).
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
  console.log('');
  console.log('═══════════════════════════════════════════════');
  console.log('  Initial administrator account');
  console.log(`  username: ${ADMIN_USERNAME}`);
  if (explicitSeedPassword || !adminExisted) {
    // The printed password was actually APPLIED (explicit reset or a
    // brand-new install). v2.31.0: previously we also printed the random
    // value on existing databases where the upsert was a no-op — a
    // misleading print of a password that is NOT in effect.
    console.log(`  password: ${adminPassword}`);
    console.log('  (Stored nowhere else — save it NOW, then');
    console.log('   change it from Settings after first login.)');
    // v2.58.10 (final-review P0): the credential file is now written at
    // INSTALL time on the user's machine — never shipped inside a
    // release package. Only written when the password was actually
    // APPLIED (fresh install / explicit reset); an upgrade re-run never
    // fabricates one.
    writeFirstLoginFile(ADMIN_USERNAME, adminPassword);
  } else {
    console.log('  password: unchanged (existing account — reset with');
    console.log('  npm run reset:admin -- --password <new> or SEED_ADMIN_PASSWORD)');
  }
  console.log('═══════════════════════════════════════════════');
  if (process.env.SEED_ADMIN_PASSWORD) {
    console.warn('[seed] SEED_ADMIN_PASSWORD was set via environment — consider unsetting it.');
  }
}

/** v2.58.10 — install-time FIRST-LOGIN.txt (setup.bat's banner promises
 *  it lives at the package root; the RELEASE never contains it — it is
 *  born on the installer's machine with THIS install's random password,
 *  and the file itself says to delete it after first login). */
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
    // a read-only install root must never fail the seed for this
    console.warn(`  [seed] could not write FIRST-LOGIN.txt: ${String(e)}`);
  }
}

// ── Demo team seeding ──────────────────────────────────────
// Mirrors the round-27 password hygiene for the admin: an EXPLICITLY provided
// password (SEED_DEMO_PASSWORD) rewrites the hash of existing demo users and
// revokes their sessions; a random one (fresh installs) keeps existing users'
// passwords untouched (safe no-op re-runs).
async function seedDemoTeam(): Promise<void> {
  const explicitDemoPassword = process.env.SEED_DEMO_PASSWORD || null;
  const demoPassword = explicitDemoPassword || crypto.randomBytes(9).toString('base64url');
  const registry = new Map(DEFAULT_JOB_TITLES.map((t) => [t.key, t]));

  console.log('[seed] SEED_DEMO_USERS=true — creating demo staff accounts…');
  for (const u of DEMO_TEAM as DemoUserSpec[]) {
    const entry = registry.get(u.jobTitle)!; // drift guard already proved existence
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
