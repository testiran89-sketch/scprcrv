# CRV Flash-Loan Arbitrage Toolkit

این پروژه 3 بخش اصلی دارد:

1. **اسکنر فرصت**: `crv-arb-checker.js`
2. **قرارداد اجرای آربیتراژ با فلش‌لون**: `contracts/CrvFlashArb.sol`
3. **اجرای خودکار فرصت‌ها**: `crv-arb-executor.js`

> ⚠️ مهم: آربیتراژ فلش‌لون باید در **یک چین** انجام شود. فرصت‌های cross-chain فقط برای اطلاع هستند و قابل اجرای اتمیک نیستند.

---

## 1) پیش‌نیازها

- Node.js 18+
- npm یا pnpm
- کیف‌پول با مقدار کافی Native token برای gas
- RPC معتبر
- قرارداد `CrvFlashArb` دیپلوی‌شده

نصب وابستگی‌ها:

```bash
npm install
```

---

## 2) نصب و اجرا

### 2.1 تنظیم متغیرهای محیطی

فایل نمونه را کپی کن:

```bash
cp .env.example .env
```

مقادیر `RPC_URL`، `PRIVATE_KEY` و `FLASH_ARB_CONTRACT` را وارد کن.

### 2.2 اسکن فرصت‌ها

- حالت عمومی (ممکن است cross-chain هم نشان دهد):

```bash
node crv-arb-checker.js
```

- فقط فرصت‌های قابل اجرای فلش‌لون (same-chain):

```bash
node crv-arb-checker.js --same-chain
```

### 2.3 اجرای خودکار (پیش‌فرض Dry Run)

```bash
node crv-arb-executor.js
```

اگر `.env` مقدار `CHAIN=polygon` داشته باشد، executor روی Polygon اجرا می‌شود.
برای اجرای مستقیم روی Polygon هم می‌توانی اینطور بزنی:

```bash
CHAIN=polygon node crv-arb-executor.js
```

پیش‌فرض `DRY_RUN=true` است، یعنی تراکنش واقعی ارسال نمی‌شود.

برای اجرای واقعی:

```bash
DRY_RUN=false node crv-arb-executor.js
```

---

## 3) روند دقیق کاری (Step-by-step)

### قدم 1: دیپلوی قرارداد

قرارداد `CrvFlashArb.sol` را با پارامترها دیپلوی کن:

- `aavePool`: آدرس Pool در شبکه هدف
- `profitRecipient`: آدرس مقصد برداشت سود

### قدم 2: وضعیت آدرس DEXها (نسخه تکمیل‌شده)

در نسخه فعلی executor:

- برای DEXهای V2/V3 (Uniswap/Sushi/QuickSwap/Pancake/Fraxswap) آدرس router در `ADDRESSES` تنظیم شده است.
- برای **Balancer** دیگر نیازی به وارد کردن دستی `poolId` نیست؛ اسکریپت `poolId` را مستقیماً از خود pool (`getPoolId`) می‌خواند.
- اگر `pairAddress` در Balancer از نوع `bytes32` باشد (خود `poolId`)، همان مستقیم استفاده می‌شود و دیگر call اضافه‌ای زده نمی‌شود.
- برای **Curve** دیگر نیازی به وارد کردن دستی `curveI/curveJ` نیست؛ اسکریپت با خواندن `coins(i)` اندیس درست را پیدا می‌کند.

نکته: اگر برای شبکه/DEX خاص هنوز router موجود نباشد، executor همان فرصت را skip می‌کند و پیام می‌دهد.

### قدم 3: تایید decimals توکن‌ها

در نسخه فعلی executor، برای سادگی decimals روی 18 فرض شده.
برای استفاده واقعی باید decimals واقعی quote token را از قرارداد بخوانی و نرمال‌سازی کنی (خصوصاً USDC/USDT).

### قدم 4: اول Dry Run

با `DRY_RUN=true` خروجی را بررسی کن و ببین فرصت انتخابی و route درست است.

### قدم 5: اجرای محدود و امن

در شروع:

- `MAX_OPPS=1`
- `LOAN_USD` پایین
- `MIN_SPREAD_PCT` بالاتر (مثلاً 0.8 تا 1.2)

بعد به‌تدریج تنظیمات را تغییر بده.

---

## 4) تنظیمات executor

| متغیر | توضیح | پیش‌فرض |
|---|---|---|
| `RPC_URL` | آدرس RPC شبکه | - |
| `PRIVATE_KEY` | کلید خصوصی sender | - |
| `FLASH_ARB_CONTRACT` | آدرس قرارداد `CrvFlashArb` | - |
| `CHAIN` | `ethereum` / `polygon` / `bsc` | `ethereum` |
| `MIN_SPREAD_PCT` | حداقل spread برای اجرا | `0.3` |
| `LOAN_USD` | نُوشنل وام | `100000` |
| `MAX_OPPS` | حداکثر فرصت اجرا در هر ران | `3` |
| `DRY_RUN` | ارسال واقعی تراکنش یا نه | `true` |

---

## 5) چرا خروجی قبلی ناقص به نظر می‌رسید؟

کاملاً حق داری. علت‌ها:

1. مستندات عملیاتی (MD) اضافه نشده بود.
2. بعضی آدرس‌های DEX به‌صورت placeholder گذاشته شده بودند.
3. برای production نیاز به مدیریت دقیق decimals، slippage، gas و fee داریم.
4. اسکنر قیمت «نشانه اولیه» می‌دهد و تضمین اجرای سودده در لحظه تراکنش نیست.

این README برای رفع همین ابهام‌ها اضافه شده تا مسیر اجرای واقعی شفاف باشد.

---

## 6) پیشنهاد برای نسخه بعدی (اگر بخوای انجام می‌دم)

- اضافه‌کردن `hardhat` + اسکریپت deploy و verify
- اضافه‌کردن `.env` loader (`dotenv`) و validation قوی
- افزودن simulation قبل از ارسال تراکنش (`callStatic` / quote API)
- افزودن token decimals واقعی به executor
- نوشتن تست unit/integration برای مسیرهای swap
