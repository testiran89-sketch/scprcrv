# USDC Flash-Loan Arbitrage Toolkit

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

اسکنر قابل تنظیم است:
- `BASE_SYMBOL` (توکن پایه)
- `QUOTE_SYMBOLS` (لیست quote با کاما)

مثال (پیش‌فرض) USDC روی Polygon:

```bash
BASE_SYMBOL=USDC QUOTE_SYMBOLS=USDT,DAI,WETH CHAIN=polygon node crv-arb-checker.js --same-chain
```

اگر `BASE_SYMBOL` ست نکنی، پیش‌فرض اسکنر `USDC` است.

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

نکته: executor بر اساس `PAIR` خروجی اسکنر، توکن base را داینامیک برمی‌دارد.

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
| `LOAN_QUOTE` | برای جفت‌های non-stable (مثل WETH) مقدار وام به واحد quote | unset |
| `LOAN_UTILIZATION_BPS` | سقف استفاده از نقدینگی pool (از min buy/sell liquidity) | `500` |
| `MIN_POOL_LIQUIDITY_USD` | حداقل نقدینگی لازم برای هر طرف فرصت | `10000` |
| `MIN_PROFIT_BPS` | حداقل سود نسبی نسبت به مبلغ وام | `0` |
| `MIN_PROFIT_QUOTE` | حداقل سود مطلق به واحد quote | unset |
| `VERBOSE` | لاگ جزئیات بیشتر (liquidity/params) | `false` |
| `MAX_OPPS` | حداکثر فرصت اجرا در هر ران | `3` |
| `DRY_RUN` | ارسال واقعی تراکنش یا نه | `true` |

نکته مهم:
- برای quoteهای stable (`USDC/USDT/DAI/FRAX`) مقدار `LOAN_USD` استفاده می‌شود.
- برای quoteهای non-stable مثل `WETH` باید `LOAN_QUOTE` ست شود؛ در غیر این صورت آن فرصت skip می‌شود.

توضیح خطاهای رایج:
- `BAL#304` معمولاً به معنی فشار بیش از حد روی نقدینگی pool است؛ با `LOAN_UTILIZATION_BPS` پایین‌تر (مثلاً 100 تا 300) شروع کن.
- اگر نقدینگی pool خیلی کم باشد، فرصت به‌طور کامل skip می‌شود (با `MIN_POOL_LIQUIDITY_USD`) تا روی poolهای ضعیف اصلاً تلاش اجرا نشود.
- `Too little received` از minOut سخت‌گیرانه می‌آید. در executor جدید minOut فروش روی مقدار حداقلی تنظیم شده و کنترل سود با `minProfit` داخل قرارداد انجام می‌شود.
- `bad address checksum` معمولاً از آدرس‌های mixed-case ناسازگار می‌آید؛ executor آدرس‌ها را normalize می‌کند و pairAddressهای composite را parse می‌کند.
- اگر پیام `Liquidity cap applied ... -> 0 USD` دیدی، یعنی نقدینگی گزارش‌شده برای آن pool خیلی کم/ناقص بوده یا utilization خیلی پایین است. در نسخه جدید این حالت به‌صورت شفاف log می‌شود و اجباری به 0 نمی‌افتد مگر واقعاً cap زیر 1 واحد باشد.

نمونه تنظیمات محافظه‌کار برای Polygon:

```bash
CHAIN=polygon
DRY_RUN=true
MIN_SPREAD_PCT=0.5
LOAN_UTILIZATION_BPS=100
MIN_POOL_LIQUIDITY_USD=50000
LOAN_USD=2000
LOAN_QUOTE=0.5
VERBOSE=true
```

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
