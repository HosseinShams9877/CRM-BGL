# راهنمای استقرار تولیدی — BGL CRM

این سند، مسیر کامل «از بستهٔ تحویلی تا CRM در حال اجرا روی دامنهٔ شما با HTTPS» را گام‌به‌گام شرح می‌دهد.
برای نصب محلی/تست (بدون دامنه و nginx) از [INSTALL.md](./INSTALL.md) استفاده کنید.

> محدودهٔ این نسخه (v2.58.0): تمام فایل‌های لازم برای استقرار در پوشهٔ `deploy/` موجود است —
> کانفیگ nginx، سرویس systemd، فایل PM2 و اسکریپت پشتیبان‌گیری خودکار.

---

## معماری هدف

```
مرورگر کاربر ──HTTPS──▶ nginx (پورت 443) ──proxy──▶ Node standalone (127.0.0.1:3000)
                                                        │
                                                        ├── SQLite (فایل روی SSD محلی)
                                                        ├── storage/uploads (فایل‌های بارگذاری‌شده)
                                                        └── backups/ (پشتیبان خودکار)
```

قواعد معماری که نباید شکسته شوند:

1. **nginx تنها درِ ورود است.** Node فقط روی `127.0.0.1:3000` گوش می‌دهد (در سرویس systemd ست شده) و پورت 3000 در فایروال بسته است.
2. **یک فرآیند Node، یک فایل دیتابیس.** SQLite فقط یک نویسندهٔ هم‌زمان می‌پذیرد؛ حالت cluster/چند-نمونه ممنوع (INSTALL.md §۱۰-۱ قاعدهٔ ۴).
3. **دیتابیس روی دیسک محلی سریع** (SSD، فایل‌سیستم ext4/xfs) — نه پوشهٔ شبکهٔ SMB/NFS و نه درایو ابری نگاشت‌شده.
4. **هر متغیر حساس فقط در `.env`** با مسیر مطلق؛ بین محیط‌ها کپی نمی‌شود.

---

## گام ۰ — پیش‌نیازها (قبل از خرید هر چیزی بخوانید)

| مورد | حداقل پیشنهادی | توضیح |
|------|----------------|-------|
| سرور (VPS) | ۲ vCPU، ۴GB RAM، ۳۰GB SSD | برای تیم تا ~۵۰ کاربر هم‌زمان کافی است (بار سنجی‌شده: rps≈57، p95≈99ms روی مشخصات مشابه) |
| سیستم‌عامل | Ubuntu 22.04/24.04 LTS یا Debian 12 | راهنما بر همین پایه است؛ Alma/Rocky هم با تفاوت جزئی (`dnf`) کار می‌کند |
| دامنه | هر دامنه‌ای که DNS آن در اختیار شماست | رکورد A به IP سرور |
| دسترسی | root یا sudo | برای نصب nginx/certbot و ساخت سرویس |
| هوش مصنوعی (اختیاری) | یکی از: zai (داخلی)، هر endpoint سازگار با OpenAI که از سرور در دسترس است، یا Ollama محلی | با «دکمهٔ تست اتصال» در تنظیمات هوش مصنوعی از خودِ سرور راستی‌آزمایی کنید |

> ⚠️ **هاست اشتراکی (cPanel/میزبانی PHP مشترک) مناسب این سامانه نیست.**
> Next.js standalone به فرآیند Node دائمی و پورت اختصاصی نیاز دارد؛ VPS (سرور مجازی) لازم است.

> 🇮🇷 **نکتهٔ انتخاب هاست برای ایران:** اگر سرور داخل ایران است، همه‌چیز بدون تحریم کار می‌کند به‌جز
> سرویس‌های هوش مصنوعی خارجی (OpenAI/Anthropic/Google از IP ایران مسدودند) — راه‌حل: zai یا
> Ollama خودمیزبان (هر دو بدون تحریم). اگر سرور خارج از ایران است، همهٔ سرویس‌ها باز هستند اما
> دسترسی شما به پنل مدیریت هاست ممکن است نیاز به تحمل شرایط داشته باشد. گواهی Let's Encrypt از
> هر دو موقعیت بدون مشکل صادر و تمدید می‌شود.

---

## گام ۱ — آماده‌سازی سرور (یک‌بار)

```bash
# به‌روزرسانی و ابزارهای پایه
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl unzip ufw

# کاربر اختصاصی (هرگز با root اجرا نکنید)
sudo adduser --disabled-password --gecos "" bgl

# فایروال: فقط SSH و وب
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable
# توجه: پورت 3000 عمداً باز نمی‌شود — Node فقط localhost است
```

نکتهٔ امنیتی جدی: ورود SSH با رمز را خاموش و فقط کلید بگذارید (`PasswordAuthentication no` در `/etc/ssh/sshd_config`) و در صورت امکان `fail2ban` نصب کنید. سروری که CRM یک شرکت روی آن است، هر روز اسکن خودکار می‌شود.

## گام ۲ — نصب Node.js 22 LTS و nginx

```bash
# Node.js 22 (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version    # باید v22.x باشد

# nginx و certbot
sudo apt install -y nginx certbot python3-certbot-nginx
```

## گام ۳ — استقرار برنامه

بستهٔ تحویلی (`bgl-crm-vX.Y.Z-*.zip`) را روی سرور بگذارید:

```bash
sudo mkdir -p /opt/bgl-crm && sudo chown bgl:bgl /opt/bgl-crm
sudo -u bgl unzip bgl-crm-vX.Y.Z-*.zip -d /opt/bgl-crm
cd /opt/bgl-crm
sudo -u bgl npm ci            # دقیقاً همان وابستگی‌های تست‌شده
```

فایل `.env` را بسازید — **با این تفاوت‌های حیاتی نسبت به محیط توسعه:**

```bash
sudo -u bgl cp .env.example .env
sudo -u bgl nano .env
```

```ini
# ۱) مسیر مطلق — نه نسبی. مسیر نسبی بسته به نقطهٔ ورود (CLI پرایسما یا
#    فرآیند standalone) نسبت به پوشه‌های متفاوتی resolve می‌شود؛ مطلق = صفر ابهام.
DATABASE_URL="file:/opt/bgl-crm/data/custom.db"

# ۲) کلید HMAC تصادفی و اختصاصی این سرور (الزامی در production)
BGL_HMAC_SECRET="<خروجی دستور زیر>"

# ۳) پشت HTTPS است → کوکی امن
COOKIE_SECURE=true
```

```bash
# تولید کلید تصادفی:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

ساخت دیتابیس و دادهٔ اولیه، سپس build:

```bash
sudo -u bgl mkdir -p /opt/bgl-crm/data
sudo -u bgl npm run db:push     # ساخت جداول
sudo -u bgl npm run db:seed     # شرکت‌ها + مدیر (رمز یک‌بار چاپ می‌شود — ذخیره کنید!)
sudo -u bgl npm run build       # خروجی standalone + کپی خودکار static/public
```

> پوشهٔ `data/` عمداً جدا از `.next/` است تا با هر build جدید دست‌نخورده بماند.

## گام ۴ — سرویس دائمی (systemd)

فایل آمادهٔ `deploy/bgl-crm.service` را نصب کنید؛ فقط سه مورد را مطابق سرور خودتان ویرایش کنید: `User=`، مسیر `/opt/bgl-crm` و مسیر دقیق `node`:

```bash
which node   # مسیر باینری را بردارید (کاربران nvm: مسیر داخل ~/.nvm/versions/...)
sudo nano deploy/bgl-crm.service     # سه placeholder را اصلاح کنید
sudo cp deploy/bgl-crm.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bgl-crm
systemctl status bgl-crm             # باید: active (running)
```

نکته‌های طراحی سرویس (در خود فایل توضیح داده شده):
- متغیرها از طریق `EnvironmentFile=.env` تزریق می‌شوند — سرور standalone مسیر کاری خودش را عوض می‌کند و `.env` را خودکار نمی‌خواند؛ systemd این ابهام را حذف می‌کند.
- `HOSTNAME=127.0.0.1` یعنی Node فقط روی loopback گوش می‌دهد؛ nginx تنها راه دسترسی است.
- `ProtectSystem=strict` + `ReadWritePaths` یعنی حتی اگر فرآیند آسیب ببیند، خارج از پوشهٔ برنامه نوشتن نمی‌تواند.

**جایگزین: PM2** (اگر ترجیح می‌دهید): `deploy/pm2.config.cjs` را ببینید — `pm2 start deploy/pm2.config.cjs && pm2 save && pm2 startup`. هر دو را هم‌زمان اجرا نکنید.

## گام ۵ — nginx و دامنه

رکورد A دامنه را به IP سرور بدهید و منتظر propagate بمانید، سپس:

```bash
# ۱) کانفیگ آماده — فقط crm.example.com را با دامنهٔ خودتان عوض کنید
sudo nano deploy/nginx-bgl-crm.conf
sudo cp deploy/nginx-bgl-crm.conf /etc/nginx/sites-available/bgl-crm.conf
sudo ln -sf /etc/nginx/sites-available/bgl-crm.conf /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

# ۲) ابتدا فقط بلوک HTTP فعال است — سرور را بالا بیاورید
sudo nginx -t && sudo systemctl reload nginx
curl -I http://localhost/    # باید 301 به https بدهد یا پاسخ از Node برسد

# ۳) گواهی رایگان و تمدید خودکار
sudo certbot --nginx -d crm.example.com
sudo systemctl enable --now certbot.timer   # تمدید خودکار هر ۹۰ روز
```

بعد از صدور گواهی، خطوط `ssl_certificate` در کانفیگ nginx (که certbot خودش تنظیم می‌کند) فعال می‌شوند و هدر HSTS را می‌توانید از حالت کامنت خارج کنید.

**دو قاعدهٔ امنیتی در کانفیگ nginx که نباید تغییر کند:**
- `client_max_body_size 75m` — سقف آپلود فایل (10MB) و صوت تماس (تا 60MB) پوشش می‌دهد؛ nginx قبل از برنامه بدنهٔ بزرگ را 413 می‌کند.
- `X-Forwarded-For $remote_addr` — عمداً **جایگزین‌سازی** است نه الحاق. اگر به فرم رایج `$proxy_add_x_forwarded_for` تغییر دهید، کاربر می‌تواند هدر جعلی بفرستد و rate-limit ورود را دور بزند.

## گام ۶ — راستی‌آزمایی نهایی

```bash
# سلامت سرویس (مانیتورها هم همین را poll می‌کنند)
curl -s https://crm.example.com/api/health
# انتظار: {"status":"ok","db":"ok","latencyMs":...,"uptimeSec":...}

# لاگ‌ها
sudo journalctl -u bgl-crm -n 50 --no-pager
sudo tail -20 /var/log/nginx/bgl-crm.error.log
```

سپس در مرورگر: ورود با مدیر seed → ساخت یک سند آزمایشی → **تنظیمات هوش مصنوعی → دکمهٔ تست اتصال** (اگر AI فعال است). اگر تلفنی (Call Center) دارید، آدرس وب‌هوک را از تنظیمات کپی و در PBX ثبت کنید.

پایان استقرار. موارد بعدی بهره‌برداری‌اند.

## گام ۷ — پشتیبان‌گیری خودکار

اسکریپت آمادهٔ `scripts/backup-cron.mjs` اسنپ‌شات سازگار (`VACUUM INTO`) می‌سازد، **صحتش را با `PRAGMA quick_check` راستی‌آزمایی می‌کند** و نسخه‌های قدیمی را می‌چرخاند — بدون توقف سرویس:

```bash
# تست دستی (اول این را ببینید):
cd /opt/bgl-crm && sudo -u bgl node scripts/backup-cron.mjs --with-files
# انتظار: خط آخر [backup] OK — ... .db (حجم) ... و exit code صفر

# زمان‌بندی روزانه 02:30 + نگهداری ۱۴ نسخه + آرشیو فایل‌های بارگذاری‌شده:
sudo -u bgl crontab -e
# این خط را اضافه کنید:
30 2 * * * cd /opt/bgl-crm && node scripts/backup-cron.mjs --with-files >> backups/backup.log 2>&1
```

سه قانون پشتیبان که تعیین‌کننده‌اند:
1. **کپی خارج از سرور.** پشتیبانِ روی همان دیسکِ اصلی، در خرابی دیسک با داده می‌میرد. حداقل هفته‌ای یک‌بار `backups/bgl-backup-*.db` را با `scp`/rsync به مقصد دوم (سرور دیگر یا سرویس ابری در دسترس) ببرید.
2. **هر فایل پشتیبان خودش را اثبات می‌کند** — اسکریپت exit code غیرصفر می‌دهد اگر snapshot باز نشود یا quick_check نا-ok باشد؛ cron خروجی را در `backups/backup.log` نگه می‌دارد، آن را گاهی بخوانید.
3. **بازیابی را تمرین کنید** (سالانه): فایل پشتیبان را جای `data/custom.db` بگذارید (ابتدا `systemctl stop bgl-crm`)، `npm run db:push`، سرویس را بالا بیاورید و ورود/گزارش‌ها را چک کنید.

## گام ۸ — به‌روزرسانی و بازگشت

```bash
sudo systemctl stop bgl-crm
sudo -u bgl cp -r /opt/bgl-crm/data /opt/bgl-crm/data.bak-$(date +%F)   # بیمه
cd /opt/bgl-crm
sudo -u bgl unzip -o bgl-crm-vX.Y.NEW-*.zip
sudo -u bgl npm ci && sudo -u bgl npm run db:push && sudo -u bgl npm run build
# فقط هنگام ارتقا به v2.31.3+ (یک‌بار): هش‌کردن id نشست‌های موجود —
# کوکی‌های فعال بدون نیاز به ورود دوباره به کار ادامه می‌دهند.
sudo -u bgl npm run migrate:session-hashes
sudo systemctl start bgl-crm
curl -s http://127.0.0.1:3000/api/health    # باید ok بدهد
```

**بازگشت (rollback):** همان مسیر با ZIP نسخهٔ قبل + بازیابی `data.bak-*`. `.env` و `data/` و `storage/` و `backups/` بین به‌روزرسانی‌ها دست‌نخورده می‌مانند. پس از هر به‌روزرسانی، CHANGELOG.md را بخوانید — اگر نسخهٔ سازگاری (breaking) بود، نکات مهاجرت همان‌جا آمده است.

## گام ۹ — مانیتورینگ روزمره

| چی را | چطور | هشدار زمانی |
|--------|------|--------------|
| سلامت | `curl /api/health` (یا ابزار Uptime Kuma روی همان سرور) | غیر از 200 برای بیش از ۲ پول متوالی |
| لاگ برنامه | `journalctl -u bgl-crm -f` | خطای تکرارشونده، ری‌استارتِ خودکار مکرر |
| لاگ nginx | `/var/log/nginx/bgl-crm.*.log` | موج 413/429/5xx |
| فضا | `df -h /opt` + `du -sh backups storage` | بالای ۸۰٪ — WAL روی دیسک پر = دیتابیس فقط-خواندنی |
| گواهی | `sudo certbot certificates` | کمتر از ۳۰ روز مانده |

## رفع اشکال رایج استقرار

| نشانه | علت محتمل | راه‌حل |
|-------|-----------|--------|
| 502 Bad Gateway | سرویس bgl-crm بالا نیست | `systemctl status bgl-crm`؛ لاگ journalctl؛ `HOSTNAME=127.0.0.1` ست شده؟ |
| بعد از ورود، دوباره صفحهٔ ورود | کوکی secure روی HTTP | یا HTTPS فعال کنید یا موقتاً (شبکهٔ داخلی مطمئن) `COOKIE_SECURE=false` |
| «حجم درخواست بیش از حد مجاز» هنگام آپلود صوت تماس | `client_max_body_size` کم است | در کانفیگ nginx بزرگ‌تر کنید (سقف صوت در تنظیمات تلفنی، تا 60MB) |
| خطای `BGL_HMAC_SECRET` هنگام ورود | `.env` بعد از ساخت سرویس عوض شده | `sudo systemctl restart bgl-crm` (EnvironmentFile هنگام start خوانده می‌شود) |
| 429 روی همهٔ APIها | یک ابزار پایش/اسکن پشت سر هم می‌زند | آهنگ poll را کم کنید (سقف عمومی: 120 درخواست/دقیقه/IP) |
| «درخواست از مبدا غیرمجاز رد شد» هنگام ورود | سامانه پشت پروکسی/تونلی است که Host را بازنویسی می‌کند (tunnel، پیش‌نمایش، `proxy_set_header Host` فراموش شده) | یا در nginx خط `proxy_set_header Host $host;` را اضافه کنید، یا `TRUSTED_ORIGINS=دامنه-شما` را در `.env` بگذارید و ری‌استارت کنید — v2.31.1 |
| `EADDRINUSE :3000` | فرآیند یتیم مانده (کشتن parent کافی نیست — درس v2.26.1) | `sudo systemctl stop bgl-crm` سپس `ss -ltnp \| grep 3000` و kill با PID، بعد start |
| دیتابیس فقط-خواندنی | دیسک پر (WAL) | فضا آزاد کنید؛ `df -h`؛ پشتیبان‌های قدیمی را بچرخانید |
| پس از به‌روزرسانی، صفحه‌های 500 عجیب | فرآیند قدیمی روی پورت مانده یا static کپی نشده | stop کامل → `npm run build` (postbuild static را کپی می‌کند) → start |

---

## جمع‌بندی: چک‌لیست نهایی پیش از «روشن‌کردن برای کاربران»

- [ ] `/api/health` روی دامنه `status:ok` می‌دهد
- [ ] ورود مدیر seed کار می‌کند و رمز موقت تغییر داده شده
- [ ] HTTPS فعال و HTTP→HTTPS ریدایرکت می‌شود
- [ ] پورت 3000 از بیرون بسته است (`ufw status`؛ یا `curl http://IP:3000` باید fail بدهد)
- [ ] پشتیبان روزانه اجرا شده و `quick_check` پاس شده (فایل لاگ را دیده‌اید)
- [ ] یک کپی پشتیبان خارج از سرور موجود است
- [ ] تست اتصال هوش مصنوعی (در صورت فعال‌بودن) از خود سرور PASS شده
- [ ] `certbot certificates` تاریخ انقضای درست نشان می‌دهد
