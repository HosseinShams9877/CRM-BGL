import { db } from '../src/lib/db';
import { hashPassword } from '../src/lib/auth';
import crypto from 'crypto';

async function main() {
  console.log('🌱 شروع ایجاد داده‌های اولیه هلدینگ...');

  // ============ ۱. ایجاد شرکت‌ها ============
  const holding = await db.company.upsert({
    where: { slug: 'holding' },
    update: {},
    create: {
      slug: 'holding',
      name: 'هلدینگ BGL',
      description: 'شرکت مادر و مدیریت کل گروه',
      type: 'holding',
      color: '#64748b',
      accentColor: '#94a3b8',
      logo: '🏢',
    },
  });
  console.log(`✅ هلدینگ ایجاد شد: ${holding.name}`);

  const bazargani = await db.company.upsert({
    where: { slug: 'bazargani' },
    update: {},
    create: {
      slug: 'bazargani',
      name: 'بازرگانی',
      description: 'شرکت بازرگانی BGL - فروش B2B تجهیزات پزشکی',
      type: 'b2b',
      color: '#1A5276',
      accentColor: '#2980B9',
      logo: '📦',
    },
  });
  console.log(`✅ بازرگانی ایجاد شد: ${bazargani.name}`);

  const aria = await db.company.upsert({
    where: { slug: 'aria' },
    update: {},
    create: {
      slug: 'aria',
      name: 'آریا مدیکال',
      description: 'شرکت آریا مدیکال - فروش B2C محصولات پزشکی',
      type: 'b2c',
      color: '#4A235A',
      accentColor: '#8E44AD',
      logo: '🏥',
    },
  });
  console.log(`✅ آریا مدیکال ایجاد شد: ${aria.name}`);

  const bgl = await db.company.upsert({
    where: { slug: 'bgl' },
    update: {},
    create: {
      slug: 'bgl',
      name: 'BGL',
      description: 'شرکت BGL - توسعه و فناوری',
      type: 'b2b',
      color: '#2E2A5C',
      accentColor: '#1F8B7D',
      logo: '⚡',
    },
  });
  console.log(`✅ BGL ایجاد شد: ${bgl.name}`);

  // ============ ۲. ایجاد کاربر ادمین ============
  // SECURITY: random password (PBKDF2, aligned with src/lib/auth.ts — the
  // old bcryptjs hash could never be verified by the login route).
  const adminPassword = process.env.SEED_ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const admin = await db.user.upsert({
    where: { username: 'admin' },
    update: { companyId: holding.id },
    create: {
      username: 'admin',
      displayName: 'مدیر سیستم',
      passwordHash: hashPassword(adminPassword),
      role: 'admin',
      roleLabel: 'مدیر سیستم',
      province: 'تهران',
      isActive: true,
      companyId: holding.id,
    },
  });
  console.log(`✅ کاربر ادمین ایجاد شد: ${admin.displayName}`);
  console.log('═══════════════════════════════════════════');
  console.log(`  admin / ${adminPassword}`);
  console.log('  (این رمز یک‌بار نمایش داده می‌شود — ذخیره کنید)');
  console.log('═══════════════════════════════════════════');

  // ============ ۳. ایجاد مراکز بازرگانی ============
  const bazarganiCenters = await Promise.all([
    db.center.create({
      data: {
        name: 'بیمارستان شریعتی',
        province: 'تهران',
        city: 'تهران',
        address: 'تهران، خیابان شریعتی',
        phone: '۰۲۱۲۲۶۵۰۰۰۰',
        companyId: bazargani.id,
        searchKey: 'شریعتی',
      },
    }),
    db.center.create({
      data: {
        name: 'بیمارستان ایرانمهر',
        province: 'تهران',
        city: 'تهران',
        address: 'تهران، بلوار کشاورز',
        phone: '۰۲۱۸۸۹۰۰۰۰۰',
        companyId: bazargani.id,
        searchKey: 'ایرانمهر',
      },
    }),
    db.center.create({
      data: {
        name: 'بیمارستان سینا',
        province: 'تهران',
        city: 'تهران',
        address: 'تهران، خیابان کردستان',
        phone: '۰۲۱۲۳۶۰۰۰۰۰',
        companyId: bazargani.id,
        searchKey: 'سینا',
      },
    }),
    db.center.create({
      data: {
        name: 'بیمارستان امام خمینی',
        province: 'خوزستان',
        city: 'اهواز',
        address: 'اهواز، کیانپارس',
        phone: '۰۶۱۳۳۳۰۰۰۰۰',
        companyId: bazargani.id,
        searchKey: 'امام خمینی اهواز',
      },
    }),
  ]);
  console.log(`✅ ${bazarganiCenters.length} مرکز برای بازرگانی ایجاد شد`);

  // ============ ۴. ایجاد مراکز آریا مدیکال ============
  const ariaCenters = await Promise.all([
    db.center.create({
      data: {
        name: 'داروخانه شبانه‌روزی شهید بهشتی',
        province: 'تهران',
        city: 'تهران',
        address: 'تهران، خیابان ولیعصر',
        phone: '۰۲۱۸۸۷۰۰۰۰۰',
        companyId: aria.id,
        searchKey: 'بهشتی',
      },
    }),
    db.center.create({
      data: {
        name: 'کلینیک آریا',
        province: 'اصفهان',
        city: 'اصفهان',
        address: 'اصفهان، خیابان چهارباغ',
        phone: '۰۳۱۳۲۲۰۰۰۰۰',
        companyId: aria.id,
        searchKey: 'آریا اصفهان',
      },
    }),
    db.center.create({
      data: {
        name: 'بیمارستان سیدالشهدا',
        province: 'فارس',
        city: 'شیراز',
        address: 'شیراز، بلوار ارم',
        phone: '۰۷۱۳۶۲۰۰۰۰۰',
        companyId: aria.id,
        searchKey: 'سیدالشهدا شیراز',
      },
    }),
  ]);
  console.log(`✅ ${ariaCenters.length} مرکز برای آریا مدیکال ایجاد شد`);

  // ============ ۵. ایجاد مراکز BGL ============
  const bglCenters = await Promise.all([
    db.center.create({
      data: {
        name: 'بیمارستان پارس',
        province: 'تهران',
        city: 'تهران',
        address: 'تهران، خیابان انقلاب',
        phone: '۰۲۱۶۶۵۰۰۰۰۰',
        companyId: bgl.id,
        searchKey: 'پارس تهران',
      },
    }),
    db.center.create({
      data: {
        name: 'بیمارستان مهر',
        province: 'مازندران',
        city: 'ساری',
        address: 'ساری، بلوار十八دی',
        phone: '۰۱۱۳۳۱۰۰۰۰۰',
        companyId: bgl.id,
        searchKey: 'مهر ساری',
      },
    }),
    db.center.create({
      data: {
        name: 'بیمارستان تریتا',
        province: 'تهران',
        city: 'تهران',
        address: 'تهران، خیابان آفریقا',
        phone: '۰۲۱۲۶۱۰۰۰۰۰',
        companyId: bgl.id,
        searchKey: 'تریتا',
      },
    }),
  ]);
  console.log(`✅ ${bglCenters.length} مرکز برای BGL ایجاد شد`);

  // ============ ۶. ایجاد پیگیری‌های دوره‌ای بازرگانی ============
  const bazarganiFollowups = await Promise.all([
    db.periodicFollowup.create({
      data: {
        companyId: bazargani.id,
        centerId: bazarganiCenters[0].id,
        centerName: 'بیمارستان شریعتی',
        city: 'تهران',
        personName: 'دکتر احمدی',
        phone: '۰۹۱۲۱۲۳۴۵۶۷',
        frequency: 'weekly',
        frequencyDays: 7,
        lastFollowupDate: '۱۴۰۵/۰۵/۱۸',
        nextFollowupDate: '۱۴۰۵/۰۵/۲۵',
        daysOverdue: 0,
        totalFollowups: 12,
        status: 'today',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: bazargani.id,
        centerId: bazarganiCenters[1].id,
        centerName: 'بیمارستان ایرانمهر',
        city: 'تهران',
        personName: 'مهندس رضایی',
        phone: '۰۹۳۵۱۲۳۴۵۶۷',
        frequency: 'monthly',
        frequencyDays: 30,
        lastFollowupDate: '۱۴۰۵/۰۴/۲۰',
        nextFollowupDate: '۱۴۰۵/۰۵/۲۰',
        daysOverdue: 5,
        totalFollowups: 8,
        status: 'overdue',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: bazargani.id,
        centerId: bazarganiCenters[2].id,
        centerName: 'بیمارستان سینا',
        city: 'تهران',
        personName: 'آقای محمدی',
        phone: '۰۹۱۳۱۲۳۴۵۶۷',
        frequency: 'biweekly',
        frequencyDays: 14,
        lastFollowupDate: '۱۴۰۵/۰۵/۲۰',
        nextFollowupDate: '۱۴۰۵/۰۶/۰۴',
        daysOverdue: 0,
        totalFollowups: 5,
        status: 'upcoming',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: bazargani.id,
        centerId: bazarganiCenters[3].id,
        centerName: 'بیمارستان امام خمینی',
        city: 'اهواز',
        personName: 'خانم کریمی',
        phone: '۰۹۱۶۱۲۳۴۵۶۷',
        frequency: 'bimonthly',
        frequencyDays: 60,
        lastFollowupDate: '۱۴۰۵/۰۵/۲۲',
        nextFollowupDate: '۱۴۰۵/۰۷/۲۲',
        daysOverdue: 0,
        totalFollowups: 3,
        status: 'done',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: bazargani.id,
        centerName: 'بیمارستان نیاوران',
        city: 'تهران',
        personName: 'دکتر صادقی',
        phone: '۰۹۱۲۹۸۷۶۵۴۳',
        frequency: 'monthly',
        frequencyDays: 30,
        lastFollowupDate: '۱۴۰۵/۰۵/۱۰',
        nextFollowupDate: '۱۴۰۵/۰۶/۱۰',
        daysOverdue: 0,
        totalFollowups: 2,
        status: 'upcoming',
      },
    }),
  ]);
  console.log(`✅ ${bazarganiFollowups.length} پیگیری دوره‌ای برای بازرگانی ایجاد شد`);

  // ============ ۷. ایجاد پیگیری‌های دوره‌ای آریا مدیکال ============
  const ariaFollowups = await Promise.all([
    db.periodicFollowup.create({
      data: {
        companyId: aria.id,
        centerId: ariaCenters[0].id,
        centerName: 'داروخانه شبانه‌روزی شهید بهشتی',
        city: 'تهران',
        personName: 'دکتر نوری',
        phone: '۰۹۱۲۳۴۵۶۷۸۹',
        frequency: 'weekly',
        frequencyDays: 7,
        lastFollowupDate: '۱۴۰۵/۰۵/۱۵',
        nextFollowupDate: '۱۴۰۵/۰۵/۲۲',
        daysOverdue: 3,
        totalFollowups: 15,
        status: 'overdue',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: aria.id,
        centerId: ariaCenters[1].id,
        centerName: 'کلینیک آریا',
        city: 'اصفهان',
        personName: 'آقای عباسی',
        phone: '۰۹۳۱۲۳۴۵۶۷۸',
        frequency: 'monthly',
        frequencyDays: 30,
        lastFollowupDate: '۱۴۰۵/۰۵/۲۵',
        nextFollowupDate: '۱۴۰۵/۰۶/۲۵',
        daysOverdue: 0,
        totalFollowups: 6,
        status: 'today',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: aria.id,
        centerId: ariaCenters[2].id,
        centerName: 'بیمارستان سیدالشهدا',
        city: 'شیراز',
        personName: 'خانم موسوی',
        phone: '۰۹۱۷۱۲۳۴۵۶۷',
        frequency: 'biweekly',
        frequencyDays: 14,
        lastFollowupDate: '۱۴۰۵/۰۵/۱۰',
        nextFollowupDate: '۱۴۰۵/۰۵/۲۴',
        daysOverdue: 1,
        totalFollowups: 9,
        status: 'overdue',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: aria.id,
        centerName: 'فروشگاه تجهیزات پزشکی سپید',
        city: 'تهران',
        personName: 'آقای تقوی',
        phone: '۰۹۲۱۳۴۵۶۷۸۹',
        frequency: 'monthly',
        frequencyDays: 30,
        lastFollowupDate: '۱۴۰۵/۰۵/۲۰',
        nextFollowupDate: '۱۴۰۵/۰۶/۲۰',
        daysOverdue: 0,
        totalFollowups: 4,
        status: 'upcoming',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: aria.id,
        centerName: 'مطب دکتر رحیمی',
        city: 'اصفهان',
        personName: 'دکتر رحیمی',
        phone: '۰۹۱۳۵۶۷۸۹۰۱',
        frequency: 'bimonthly',
        frequencyDays: 60,
        lastFollowupDate: '۱۴۰۵/۰۴/۱۵',
        nextFollowupDate: '۱۴۰۵/۰۶/۱۵',
        daysOverdue: 0,
        totalFollowups: 2,
        status: 'upcoming',
      },
    }),
  ]);
  console.log(`✅ ${ariaFollowups.length} پیگیری دوره‌ای برای آریا مدیکال ایجاد شد`);

  // ============ ۸. ایجاد پیگیری‌های دوره‌ای BGL ============
  const bglFollowups = await Promise.all([
    db.periodicFollowup.create({
      data: {
        companyId: bgl.id,
        centerId: bglCenters[0].id,
        centerName: 'بیمارستان پارس',
        city: 'تهران',
        personName: 'دکتر حسینی',
        phone: '۰۹۱۲۴۵۶۷۸۹۰',
        frequency: 'weekly',
        frequencyDays: 7,
        lastFollowupDate: '۱۴۰۵/۰۵/۲۵',
        nextFollowupDate: '۱۴۰۵/۰۶/۰۲',
        daysOverdue: 0,
        totalFollowups: 20,
        status: 'done',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: bgl.id,
        centerId: bglCenters[1].id,
        centerName: 'بیمارستان مهر',
        city: 'ساری',
        personName: 'آقای یوسفی',
        phone: '۰۹۱۱۲۳۴۵۶۷۸',
        frequency: 'monthly',
        frequencyDays: 30,
        lastFollowupDate: '۱۴۰۵/۰۴/۲۵',
        nextFollowupDate: '۱۴۰۵/۰۵/۲۵',
        daysOverdue: 0,
        totalFollowups: 7,
        status: 'today',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: bgl.id,
        centerId: bglCenters[2].id,
        centerName: 'بیمارستان تریتا',
        city: 'تهران',
        personName: 'خانم شفیعی',
        phone: '۰۹۳۵۲۳۴۵۶۷۸',
        frequency: 'biweekly',
        frequencyDays: 14,
        lastFollowupDate: '۱۴۰۵/۰۵/۰۸',
        nextFollowupDate: '۱۴۰۵/۰۵/۲۲',
        daysOverdue: 3,
        totalFollowups: 10,
        status: 'overdue',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: bgl.id,
        centerName: 'بیمارستان شفا',
        city: 'تبریز',
        personName: 'دکتر قاسمی',
        phone: '۰۹۱۴۳۴۵۶۷۸۹',
        frequency: 'monthly',
        frequencyDays: 30,
        lastFollowupDate: '۱۴۰۵/۰۵/۱۵',
        nextFollowupDate: '۱۴۰۵/۰۶/۱۵',
        daysOverdue: 0,
        totalFollowups: 4,
        status: 'upcoming',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: bgl.id,
        centerName: 'مرکز درمانی گلستان',
        city: 'رشت',
        personName: 'آقای پورمحمدی',
        phone: '۰۹۱۱۵۶۷۸۹۰۱',
        frequency: 'bimonthly',
        frequencyDays: 60,
        lastFollowupDate: '۱۴۰۵/۰۳/۲۵',
        nextFollowupDate: '۱۴۰۵/۰۵/۲۵',
        daysOverdue: 0,
        totalFollowups: 3,
        status: 'today',
      },
    }),
    db.periodicFollowup.create({
      data: {
        companyId: bgl.id,
        centerName: 'بیمارستان بوعلی سینا',
        city: 'همدان',
        personName: 'خانم رحمانی',
        phone: '۰۹۱۸۳۴۵۶۷۸۹',
        frequency: 'monthly',
        frequencyDays: 30,
        lastFollowupDate: '۱۴۰۵/۰۵/۰۱',
        nextFollowupDate: '۱۴۰۵/۰۶/۰۱',
        daysOverdue: 0,
        totalFollowups: 5,
        status: 'upcoming',
      },
    }),
  ]);
  console.log(`✅ ${bglFollowups.length} پیگیری دوره‌ای برای BGL ایجاد شد`);

  // ============ ۹. ایجاد تاریخچه پیگیری‌ها ============
  const _allFollowups = [...bazarganiFollowups, ...ariaFollowups, ...bglFollowups];
  void _allFollowups;
  const historyData: { followupId: string; followupDate: string; method: string; result: string; note: string }[] = [];

  // تاریخچه برای پیگیری‌های بازرگانی
  historyData.push(
    { followupId: bazarganiFollowups[0].id, followupDate: '۱۴۰۵/۰۵/۱۸', method: 'phone', result: 'سفارش جدید ثبت شد', note: 'دکتر احمدی نیاز به دستگاه monitors جدید دارد' },
    { followupId: bazarganiFollowups[0].id, followupDate: '۱۴۰۵/۰۵/۱۱', method: 'visit', result: 'مذاکره مثبت', note: 'بازدید از بخش ICU انجام شد' },
    { followupId: bazarganiFollowups[1].id, followupDate: '۱۴۰۵/۰۴/۲۰', method: 'whatsapp', result: 'درخواست قیمت‌گذاری', note: 'لیست قیمت تجهیزات ارسال شد' },
    { followupId: bazarganiFollowups[2].id, followupDate: '۱۴۰۵/۰۵/۲۰', method: 'visit', result: 'قرارداد تمدید شد', note: 'تمدید قرارداد سالانه' },
    { followupId: bazarganiFollowups[3].id, followupDate: '۱۴۰۵/۰۵/۲۲', method: 'phone', result: 'ارسال فاکتور', note: 'فاکتور فصلی ارسال شد' },
  );

  // تاریخچه برای پیگیری‌های آریا
  historyData.push(
    { followupId: ariaFollowups[0].id, followupDate: '۱۴۰۵/۰۵/۱۵', method: 'phone', result: 'موجودی بررسی شد', note: 'نیاز به شارژ موجودی داروخانه' },
    { followupId: ariaFollowups[0].id, followupDate: '۱۴۰۵/۰۵/۰۸', method: 'visit', result: 'تحویل محصول', note: 'محصولات جدید تحویل داده شد' },
    { followupId: ariaFollowups[1].id, followupDate: '۱۴۰۵/۰۵/۲۵', method: 'email', result: 'ارسال کاتالوگ', note: 'کاتالوگ محصولات جدید ایمیل شد' },
    { followupId: ariaFollowups[2].id, followupDate: '۱۴۰۵/۰۵/۱۰', method: 'whatsapp', result: 'در انتظار پاسخ', note: 'پیشنهاد قیمت ارسال شده، منتظر تأیید' },
    { followupId: ariaFollowups[3].id, followupDate: '۱۴۰۵/۰۵/۲۰', method: 'phone', result: 'سفارش ثبت شد', note: 'سفارش ۵ قلم کالا ثبت گردید' },
  );

  // تاریخچه برای پیگیری‌های BGL
  historyData.push(
    { followupId: bglFollowups[0].id, followupDate: '۱۴۰۵/۰۵/۲۵', method: 'visit', result: 'پرداخت انجام شد', note: 'مبلغ فاکتور تسویه گردید' },
    { followupId: bglFollowups[0].id, followupDate: '۱۴۰۵/۰۵/۱۸', method: 'phone', result: 'پیگیری فاکتور', note: 'یادآوری سررسید پرداخت' },
    { followupId: bglFollowups[1].id, followupDate: '۱۴۰۵/۰۵/۲۵', method: 'visit', result: 'نیازسنجی', note: 'بررسی نیازهای فصلی بیمارستان' },
    { followupId: bglFollowups[2].id, followupDate: '۱۴۰۵/۰۵/۰۸', method: 'whatsapp', result: 'ارسال پیشنهاد', note: 'پیشنهاد قیمت ویژه ارسال شد' },
    { followupId: bglFollowups[3].id, followupDate: '۱۴۰۵/۰۵/۱۵', method: 'phone', result: 'تماس اولیه', note: 'آشنایی با مرکز و بررسی نیازها' },
    { followupId: bglFollowups[4].id, followupDate: '۱۴۰۵/۰۵/۲۵', method: 'visit', result: 'ارائه محصول', note: 'نمایش محصول جدید و بررسی شرایط' },
  );

  for (const h of historyData) {
    await db.followupHistory.create({ data: h });
  }
  console.log(`✅ ${historyData.length} رکورد تاریخچه پیگیری ایجاد شد`);

  // ============ ۱۰. ایجاد یادداشت‌های پیگیری ============
  const notesData = [
    { followupId: bazarganiFollowups[0].id, text: 'دکتر احمدی تأکید کرد که قیمت‌گذاری رقابتی مهم‌ترین عامل انتخاب تأمین‌کننده است' },
    { followupId: bazarganiFollowups[1].id, text: 'مهندس رضایی درخواست جلسه حضوری برای بررسی شرایط قرارداد جدید دارد' },
    { followupId: ariaFollowups[0].id, text: 'داروخانه بهشتی یکی از بهترین مشتریان ماست، باید توجه ویژه داشته باشیم' },
    { followupId: ariaFollowups[2].id, text: 'بیمارستان سیدالشهدا در حال تجهیز بخش جدید ER است' },
    { followupId: bglFollowups[0].id, text: 'بیمارستان پارس یکی از بزرگترین حساب‌های ماست، پرداخت‌ها معمولاً به موقع انجام می‌شود' },
    { followupId: bglFollowups[2].id, text: 'خانم شفیعی ابراز علاقه کرد به محصولات جدید شرکت' },
  ];

  for (const n of notesData) {
    await db.followupNote.create({ data: n });
  }
  console.log(`✅ ${notesData.length} یادداشت پیگیری ایجاد شد`);

  console.log('\n🎉 تمام داده‌های اولیه با موفقیت ایجاد شدند!');
  console.log(`
  شرکت‌ها: ۴ عدد
  مراکز بازرگانی: ${bazarganiCenters.length} عدد
  مراکز آریا مدیکال: ${ariaCenters.length} عدد
  مراکز BGL: ${bglCenters.length} عدد
  پیگیری‌های بازرگانی: ${bazarganiFollowups.length} عدد
  پیگیری‌های آریا: ${ariaFollowups.length} عدد
  پیگیری‌های BGL: ${bglFollowups.length} عدد
  تاریخچه پیگیری: ${historyData.length} رکورد
  یادداشت‌های پیگیری: ${notesData.length} عدد
  `);
}

main()
  .catch((e) => {
    console.error('❌ خطا در ایجاد داده‌های اولیه:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
