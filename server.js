require("dotenv").config();
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const os = require("node:os");
const { getDataDirectory } = require("./lib/restaurant-config");
const express = require("express");
const cookieParser = require("cookie-parser");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, unlink, writeFile } = require("node:fs/promises");
const { Database } = require("./lib/database");
const { getDefaultPrinter, getPrinters, print: printPdf } = require("pdf-to-printer");
const {
  SESSION_TTL_MS,
  createSessionToken,
  hashPassword,
  hashSessionToken,
  verifyPassword,
} = require("./lib/security");

const app = express();
let pool;
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = getDataDirectory();
const BACKUPS_DIR = path.join(path.dirname(DATA_DIR), `${path.basename(DATA_DIR)}-backups`);
const LEGACY_BACKUPS_DIR = path.join(DATA_DIR, "backups");
const PRODUCT_IMAGES_DIR = path.join(DATA_DIR, "uploads", "products");
const RESTAURANT_LOGOS_DIR = path.join(DATA_DIR, "uploads", "restaurant");
const PRINT_JOBS_DIR = path.join(DATA_DIR, "print-jobs");
const RESTAURANT_CONFIG_PATH = path.join(DATA_DIR, "restaurant.json");
const BACKUP_RETENTION = 14;
const MAX_BACKUP_SIZE = 512 * 1024 * 1024;
const BACKUP_FILENAME_PATTERN = /^(auto|manual)-[A-Za-z0-9_-]+\.nourix$/;
const BACKUP_ARCHIVE_MAGIC = Buffer.from("NOURIX01");
const DEFAULT_RESTAURANT_CONFIG = {
  restaurantName: "Nourix",
  phone1: "",
  phone2: "",
  address: "",
  logoUrl: "",
  printer: { paperWidthMm: 80, cashierPrinter: "", secondPrinterEnabled: false, secondPrinter: "" },
};
const COOKIE_NAME = "mathaq_session";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true" ||
  (process.env.COOKIE_SECURE !== "false" && process.env.NODE_ENV === "production");
const SIZE_LABELS = { small: "صغير", medium: "وسط", large: "كبير" };
const PAYMENT_METHODS = { cash: "نقدي", cash_wallet: "محفظة كاش", visa: "فيزا" };
const PAGE_PERMISSIONS = ["pos", "orders", "order-report", "reports", "expenses", "menu", "customers", "users", "drivers", "settings", "shifts"];
const CASHIER_PAGE_PERMISSIONS = PAGE_PERMISSIONS.filter((page) => !["users", "drivers", "settings", "shifts"].includes(page));
if (process.env.TRUST_PROXY === "true") app.set("trust proxy", 1);

app.disable("x-powered-by");
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
}));
app.use("/api/backups/restore", express.raw({
  type: ["application/gzip", "application/x-gzip", "application/octet-stream"],
  limit: MAX_BACKUP_SIZE,
}));
app.use(express.json({ limit: "12mb" }));
app.use(cookieParser());
app.use((req, res, next) => {
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    if (req.body === undefined || req.body === null) req.body = {};
    if (typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "بيانات الطلب غير صالحة." });
    }
  }
  return next();
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const fail = (status, message) => { throw new HttpError(status, message); };
const trimText = (value, maxLength, label, { required = true } = {}) => {
  if (typeof value !== "string") {
    if (!required && (value === undefined || value === null)) return "";
    fail(400, `${label} غير صالح.`);
  }
  const result = value.trim();
  if ((!result && required) || result.length > maxLength) fail(400, `تحقق من ${label}.`);
  return result;
};
const readPassword = (value, { min = 1 } = {}) => {
  if (typeof value !== "string" || value.length < min || value.length > 200) {
    fail(400, min > 1 ? `كلمة المرور يجب أن تكون ${min} أحرف على الأقل.` : "كلمة المرور غير صالحة.");
  }
  return value;
};
const readNewPassword = (value) => {
  if (typeof value !== "string" || !/^\d{4,200}$/.test(value)) {
    fail(400, "كلمة المرور يجب أن تتكون من 4 أرقام على الأقل.");
  }
  return value;
};
const readRestaurantConfig = (body, { logoUrl = "" } = {}) => {
  const restaurantName = trimText(body.restaurantName, 100, "اسم المطعم");
  const phone1 = trimText(body.phone1 ?? "", 30, "رقم الهاتف الأول", { required: false });
  const phone2 = trimText(body.phone2 ?? "", 30, "رقم الهاتف الثاني", { required: false });
  const address = trimText(body.address ?? "", 240, "عنوان المطعم", { required: false });
  const paperWidthMm = Number(body.printer?.paperWidthMm ?? DEFAULT_RESTAURANT_CONFIG.printer.paperWidthMm);
  if (![58, 80].includes(paperWidthMm)) fail(400, "عرض ورق الطابعة يجب أن يكون 58 أو 80 مم.");
  const cashierPrinter = trimText(body.printer?.cashierPrinter ?? "", 200, "طابعة الكاشير", { required: false });
  const secondPrinterEnabled = body.printer?.secondPrinterEnabled === true;
  if (body.printer?.secondPrinterEnabled !== undefined && typeof body.printer.secondPrinterEnabled !== "boolean") {
    fail(400, "حالة الطابعة الثانية غير صالحة.");
  }
  const secondPrinter = trimText(body.printer?.secondPrinter ?? "", 200, "الطابعة الثانية", { required: false });
  if (secondPrinterEnabled && !secondPrinter) fail(400, "اختر الطابعة الثانية أو أوقف استخدامها.");
  if (secondPrinterEnabled && cashierPrinter && cashierPrinter === secondPrinter) {
    fail(400, "يجب اختيار طابعة ثانية مختلفة عن طابعة الكاشير.");
  }
  return {
    restaurantName,
    phone1,
    phone2,
    address,
    logoUrl,
    printer: { paperWidthMm, cashierPrinter, secondPrinterEnabled, secondPrinter },
  };
};
async function loadRestaurantConfig() {
  try {
    const savedConfig = JSON.parse(await readFile(RESTAURANT_CONFIG_PATH, "utf8"));
    const logoUrl = typeof savedConfig.logoUrl === "string" &&
      /^\/uploads\/restaurant\/[a-f0-9-]{36}\.(?:png|jpg|webp)$/.test(savedConfig.logoUrl)
      ? savedConfig.logoUrl
      : "";
    return readRestaurantConfig(savedConfig, { logoUrl });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await saveRestaurantConfig(DEFAULT_RESTAURANT_CONFIG);
    return DEFAULT_RESTAURANT_CONFIG;
  }
}

async function getCurrentShiftRow() {
  const result = await pool.query(
    "SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1"
  );
  return result.rowCount ? result.rows[0] : null;
}

async function ensureActiveShift() {
  const current = await getCurrentShiftRow();
  if (current) return current;
  const result = await pool.query(
    "INSERT INTO shifts (opened_by, opened_at) VALUES (NULL, NOW()) RETURNING *"
  );
  return result.rows[0];
}

async function summarizeShiftRange(startedAt, shiftId, endedAt = new Date(), queryable = pool) {
  const endIso = new Date(endedAt).toISOString();
  const [salesResult, cancelledResult, expensesResult, cashFloatResult] = await Promise.all([
    queryable.query(
      `SELECT
         COALESCE(SUM(total), 0) AS sales_total,
         COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN total ELSE 0 END), 0) AS cash_total,
         COALESCE(SUM(CASE WHEN payment_method = 'cash_wallet' THEN total ELSE 0 END), 0) AS cash_wallet_total,
         COALESCE(SUM(CASE WHEN payment_method = 'visa' THEN total ELSE 0 END), 0) AS visa_total
       FROM orders
       WHERE shift_id = $3 OR (shift_id IS NULL AND created_at >= $1 AND created_at <= $2)`,
      [startedAt, endIso, shiftId]
    ),
    queryable.query(
      `SELECT COALESCE(SUM(total), 0) AS cancelled_total
       FROM orders
       WHERE status = 'ملغي' AND (shift_id = $3 OR (shift_id IS NULL AND cancelled_at >= $1 AND cancelled_at <= $2))`,
      [startedAt, endIso, shiftId]
    ),
    queryable.query(
      `SELECT COALESCE(SUM(amount), 0) AS expenses_total,
              COALESCE(SUM(amount) FILTER (WHERE payment = 'نقدي'), 0) AS cash_expenses_total
       FROM expenses
       WHERE shift_id = $3 OR (shift_id IS NULL AND created_at >= $1 AND created_at <= $2)`,
      [startedAt, endIso, shiftId]
    ),
    queryable.query(
      "SELECT COALESCE(SUM(amount), 0) AS opening_cash_total FROM shift_cash_float_entries WHERE shift_id = $1",
      [shiftId]
    )
  ]);
  const salesTotal = Number(salesResult.rows[0].sales_total || 0);
  const cashTotal = Number(salesResult.rows[0].cash_total || 0);
  const cashWalletTotal = Number(salesResult.rows[0].cash_wallet_total || 0);
  const visaTotal = Number(salesResult.rows[0].visa_total || 0);
  const cancelledTotal = Number(cancelledResult.rows[0].cancelled_total || 0);
  const expensesTotal = Number(expensesResult.rows[0].expenses_total || 0);
  const cashExpensesTotal = Number(expensesResult.rows[0].cash_expenses_total || 0);
  const openingCashTotal = Number(cashFloatResult.rows[0].opening_cash_total || 0);
  const netTotal = salesTotal - expensesTotal - cancelledTotal;
  return {
    salesTotal,
    cancelledTotal,
    cashTotal,
    cashWalletTotal,
    visaTotal,
    expensesTotal,
    openingCashTotal,
    cashExpensesTotal,
    netTotal,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date(endedAt).toISOString(),
    durationMinutes: Math.max(0, Math.round((new Date(endedAt) - new Date(startedAt)) / 60000)),
  };
}

async function saveRestaurantConfig(config) {
  await mkdir(DATA_DIR, { recursive: true });
  const temporaryPath = `${RESTAURANT_CONFIG_PATH}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporaryPath, RESTAURANT_CONFIG_PATH);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") console.error("تعذر حذف ملف إعدادات المطعم المؤقت:", cleanupError);
    }
    throw error;
  }
}

async function listSystemPrinters() {
  if (process.platform !== "win32") fail(501, "الطباعة المباشرة للطابعات المحددة متاحة حاليًا على Windows فقط.");
  try {
    const printers = await getPrinters();
    return printers.map((printer) => printer.name).filter(Boolean);
  } catch (error) {
    console.error("تعذر قراءة قائمة طابعات Windows:", error);
    fail(500, "تعذر قراءة طابعات Windows. تحقق من تثبيت الطابعات ثم أعد المحاولة.");
  }
}

async function validateInstalledPrinters(printerSettings) {
  const selectedPrinters = [
    printerSettings.cashierPrinter,
    ...(printerSettings.secondPrinterEnabled ? [printerSettings.secondPrinter] : []),
  ].filter(Boolean);
  if (!selectedPrinters.length) return;
  const availablePrinters = await listSystemPrinters();
  const missingPrinters = [...new Set(selectedPrinters.filter((name) => !availablePrinters.includes(name)))];
  if (missingPrinters.length) {
    fail(400, `الطابعة المحددة غير مثبتة أو غير متاحة: ${missingPrinters.join("، ")}. حدّث قائمة الطابعات واختر طابعة متاحة.`);
  }
}

const readPagePermissions = (value, role) => {
  if (role === "admin") return PAGE_PERMISSIONS;
  if (!Array.isArray(value)) fail(400, "حدد الصفحات المسموح بها للحساب.");
  const permissions = [...new Set(value)];
  if (!permissions.length) fail(400, "اختر صفحة واحدة على الأقل للحساب.");
  if (permissions.some((page) => !CASHIER_PAGE_PERMISSIONS.includes(page))) {
    fail(400, "بعض الصفحات المحددة غير متاحة لحساب الكاشير.");
  }
  return permissions;
};
const numberValue = (value, label, { min = 0, max = 10000000, integer = false } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) {
    fail(400, `${label} غير صالح.`);
  }
  return number;
};
const normalizePhoneDigits = (value) => String(value ?? "")
  .replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x6f0 ? 0x6f0 : 0x660)))
  .replace(/\D/g, "");
const normalizePhone = (value) => {
  const phone = normalizePhoneDigits(trimText(value, 30, "رقم الهاتف"));
  if (!/^\d{7,15}$/.test(phone)) fail(400, "رقم الهاتف يجب أن يتكون من 7 إلى 15 رقمًا.");
  return phone;
};
const toProduct = (row) => ({
  id: Number(row.id),
  name: row.name,
  description: row.description,
  category: row.category,
  imageUrl: row.image_url,
  price: Number(row.price),
  sizePrices: normalizeSizePrices(row.size_prices, Number(row.price)),
  active: row.active,
});

async function saveProductImage(value) {
  if (typeof value !== "string") fail(400, "صورة الصنف غير صالحة.");
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) fail(400, "اختر صورة بصيغة PNG أو JPG أو WebP.");
  const image = Buffer.from(match[2], "base64");
  if (!image.length || image.length > 3 * 1024 * 1024) fail(400, "حجم صورة الصنف يجب ألا يتجاوز 3 ميجابايت.");
  const extension = match[1] === "jpeg" ? "jpg" : match[1];
  const validSignature = extension === "png"
    ? image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : extension === "jpg"
      ? image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
      : image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP";
  if (!validSignature) fail(400, "محتوى الصورة لا يطابق نوع الملف.");
  await mkdir(PRODUCT_IMAGES_DIR, { recursive: true });
  const filename = `${randomUUID()}.${extension}`;
  await writeFile(path.join(PRODUCT_IMAGES_DIR, filename), image, { flag: "wx" });
  return `/uploads/products/${filename}`;
}

async function removeProductImage(imageUrl) {
  const match = typeof imageUrl === "string" && imageUrl.match(/^\/uploads\/products\/([a-f0-9-]{36}\.(?:png|jpg|webp))$/);
  if (match) await unlink(path.join(PRODUCT_IMAGES_DIR, match[1]));
}

async function saveRestaurantLogo(value) {
  if (typeof value !== "string") fail(400, "شعار المطعم غير صالح.");
  const match = value.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) fail(400, "اختر شعارًا بصيغة PNG أو JPG أو WebP.");
  const image = Buffer.from(match[2], "base64");
  if (!image.length || image.length > 3 * 1024 * 1024) fail(400, "حجم شعار المطعم يجب ألا يتجاوز 3 ميجابايت.");
  const extension = match[1] === "jpeg" ? "jpg" : match[1];
  const validSignature = extension === "png"
    ? image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    : extension === "jpg"
      ? image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff
      : image.toString("ascii", 0, 4) === "RIFF" && image.toString("ascii", 8, 12) === "WEBP";
  if (!validSignature) fail(400, "محتوى الشعار لا يطابق نوع الملف.");
  await mkdir(RESTAURANT_LOGOS_DIR, { recursive: true });
  const filename = `${randomUUID()}.${extension}`;
  await writeFile(path.join(RESTAURANT_LOGOS_DIR, filename), image, { flag: "wx" });
  return `/uploads/restaurant/${filename}`;
}

async function removeRestaurantLogo(logoUrl) {
  const match = typeof logoUrl === "string" && logoUrl.match(/^\/uploads\/restaurant\/([a-f0-9-]{36}\.(?:png|jpg|webp))$/);
  if (match) await unlink(path.join(RESTAURANT_LOGOS_DIR, match[1]));
}

async function listDatabaseBackups() {
  await mkdir(BACKUPS_DIR, { recursive: true });
  const entries = await readdir(BACKUPS_DIR, { withFileTypes: true });
  const backups = [];
  for (const entry of entries) {
    if (!entry.isFile() || !BACKUP_FILENAME_PATTERN.test(entry.name)) continue;
    const details = await stat(path.join(BACKUPS_DIR, entry.name));
    backups.push({
      filename: entry.name,
      createdAt: details.mtime.toISOString(),
      size: details.size,
      automatic: entry.name.startsWith("auto-"),
    });
  }
  return backups.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

async function pruneDatabaseBackups() {
  const backups = await listDatabaseBackups();
  for (const backup of backups.slice(BACKUP_RETENTION)) {
    await unlink(path.join(BACKUPS_DIR, backup.filename));
  }
}

async function prepareBackupDirectory() {
  let entries;
  try {
    entries = await readdir(LEGACY_BACKUPS_DIR);
  } catch (error) {
    if (error.code === "ENOENT") {
      await mkdir(BACKUPS_DIR, { recursive: true });
      return;
    }
    throw error;
  }
  await mkdir(BACKUPS_DIR, { recursive: true });
  if (!entries.length) return;
  await cp(LEGACY_BACKUPS_DIR, BACKUPS_DIR, { recursive: true, force: true });
  await rm(LEGACY_BACKUPS_DIR, { recursive: true, force: true });
}

async function collectBackupFiles() {
  const files = [];
  for (const relativePath of ["restaurant.json"]) {
    try {
      files.push({ path: relativePath, content: await readFile(path.join(DATA_DIR, relativePath)) });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const directory of ["uploads/products", "uploads/restaurant"]) {
    const absoluteDirectory = path.join(DATA_DIR, ...directory.split("/"));
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !/^[a-f0-9-]{36}\.(png|jpg|webp)$/.test(entry.name)) continue;
      const relativePath = `${directory}/${entry.name}`;
      files.push({ path: relativePath, content: await readFile(path.join(absoluteDirectory, entry.name)) });
    }
  }
  return files;
}

async function createPortableBackup() {
  const databaseArchive = Buffer.from(await (await pool.dumpDataDir()).arrayBuffer());
  const files = await collectBackupFiles();
  const manifest = Buffer.from(JSON.stringify({
    version: 1,
    databaseSize: databaseArchive.length,
    files: files.map(({ path: filePath, content }) => ({ path: filePath, size: content.length })),
  }));
  const header = Buffer.alloc(BACKUP_ARCHIVE_MAGIC.length + 4);
  BACKUP_ARCHIVE_MAGIC.copy(header);
  header.writeUInt32BE(manifest.length, BACKUP_ARCHIVE_MAGIC.length);
  return Buffer.concat([header, manifest, databaseArchive, ...files.map(({ content }) => content)]);
}

function readPortableBackup(archive) {
  if (!Buffer.isBuffer(archive) || archive.length > MAX_BACKUP_SIZE ||
      archive.length < BACKUP_ARCHIVE_MAGIC.length + 4 ||
      !archive.subarray(0, BACKUP_ARCHIVE_MAGIC.length).equals(BACKUP_ARCHIVE_MAGIC)) {
    fail(400, "ملف النسخة الاحتياطية غير صالح أو يتجاوز الحد المسموح.");
  }
  const manifestSize = archive.readUInt32BE(BACKUP_ARCHIVE_MAGIC.length);
  const manifestStart = BACKUP_ARCHIVE_MAGIC.length + 4;
  const payloadStart = manifestStart + manifestSize;
  if (!manifestSize || manifestSize > 1_000_000 || payloadStart > archive.length) {
    fail(400, "بيانات النسخة الاحتياطية غير صالحة.");
  }
  let manifest;
  try {
    manifest = JSON.parse(archive.subarray(manifestStart, payloadStart).toString("utf8"));
  } catch {
    fail(400, "بيانات النسخة الاحتياطية غير صالحة.");
  }
  if (manifest.version !== 1 || !Number.isSafeInteger(manifest.databaseSize) ||
      manifest.databaseSize <= 0 || !Array.isArray(manifest.files) || manifest.files.length > 10_000) {
    fail(400, "تنسيق النسخة الاحتياطية غير مدعوم.");
  }
  let offset = payloadStart;
  const database = archive.subarray(offset, offset + manifest.databaseSize);
  if (database.length !== manifest.databaseSize) fail(400, "ملف قاعدة البيانات في النسخة غير مكتمل.");
  offset += manifest.databaseSize;
  const seenPaths = new Set();
  const files = [];
  for (const entry of manifest.files) {
    const allowedPath = entry?.path === "restaurant.json" ||
      (typeof entry?.path === "string" && /^uploads\/(products|restaurant)\/[a-f0-9-]{36}\.(png|jpg|webp)$/.test(entry.path));
    if (!allowedPath || seenPaths.has(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0) {
      fail(400, "تحتوي النسخة الاحتياطية على ملف غير صالح.");
    }
    seenPaths.add(entry.path);
    const content = archive.subarray(offset, offset + entry.size);
    if (content.length !== entry.size) fail(400, "أحد ملفات النسخة الاحتياطية غير مكتمل.");
    files.push({ path: entry.path, content });
    offset += entry.size;
  }
  if (offset !== archive.length) fail(400, "حجم النسخة الاحتياطية لا يطابق محتواها.");
  return { database, files };
}

async function createDatabaseBackup(kind = "manual") {
  const previousBackup = backupInProgress || Promise.resolve();
  const currentBackup = previousBackup.catch(() => {}).then(async () => {
    await mkdir(BACKUPS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${kind}-${timestamp}-${randomUUID()}.nourix`;
    const targetPath = path.join(BACKUPS_DIR, filename);
    const temporaryPath = `${targetPath}.tmp`;
    const archive = await createPortableBackup();
    try {
      await writeFile(temporaryPath, archive, { flag: "wx" });
      await rename(temporaryPath, targetPath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") console.error("تعذر حذف ملف النسخة الاحتياطية المؤقت:", cleanupError);
      }
      throw error;
    }
    await pruneDatabaseBackups();
    return (await listDatabaseBackups()).find((backup) => backup.filename === filename);
  });
  backupInProgress = currentBackup;
  try {
    return await currentBackup;
  } finally {
    if (backupInProgress === currentBackup) backupInProgress = null;
  }
}

async function validateDatabaseBackup(archive) {
  const parsed = readPortableBackup(archive);
  if (parsed.database.length < 2 || parsed.database[0] !== 0x1f || parsed.database[1] !== 0x8b) {
    fail(400, "ملف قاعدة البيانات في النسخة غير صالح.");
  }
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "nourix-backup-check-"));
  let temporaryDatabase;
  try {
    temporaryDatabase = new Database({
      dataDir: path.join(temporaryDirectory, "database"),
      loadDataDir: new Blob([parsed.database]),
    });
    await temporaryDatabase.waitReady();
    const result = await temporaryDatabase.query(
      "SELECT to_regclass('public.users') AS users_table, to_regclass('public.orders') AS orders_table"
    );
    if (!result.rows[0]?.users_table || !result.rows[0]?.orders_table) {
      fail(400, "الملف لا يحتوي على قاعدة بيانات Nourix صالحة.");
    }
    const configFile = parsed.files.find((file) => file.path === "restaurant.json");
    if (configFile) {
      try {
        const config = JSON.parse(configFile.content.toString("utf8"));
        const logoUrl = typeof config.logoUrl === "string" &&
          /^\/uploads\/restaurant\/[a-f0-9-]{36}\.(?:png|jpg|webp)$/.test(config.logoUrl)
          ? config.logoUrl
          : "";
        readRestaurantConfig(config, { logoUrl });
      } catch {
        fail(400, "إعدادات المطعم في النسخة الاحتياطية غير صالحة.");
      }
    }
  } catch (error) {
    if (Number.isInteger(error.status)) throw error;
    console.error("تعذر التحقق من ملف النسخة الاحتياطية:", error);
    fail(400, "تعذر قراءة ملف النسخة الاحتياطية.");
  } finally {
    if (temporaryDatabase) await temporaryDatabase.end();
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function restorePendingDatabaseBackup() {
  const pendingPath = path.join(BACKUPS_DIR, "restore-pending.nourix");
  let archive;
  try {
    archive = await readFile(pendingPath);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  await validateDatabaseBackup(archive);
  const previousDirectory = `${DATA_DIR}.restore-${randomUUID()}`;
  const parsed = readPortableBackup(archive);
  await rename(DATA_DIR, previousDirectory);
  let restoredDatabase;
  try {
    restoredDatabase = new Database({
      dataDir: DATA_DIR,
      loadDataDir: new Blob([parsed.database]),
    });
    await restoredDatabase.waitReady();
    await restoredDatabase.end();
    restoredDatabase = null;
    await rm(path.join(DATA_DIR, "restaurant.json"), { force: true });
    await rm(path.join(DATA_DIR, "uploads"), { recursive: true, force: true });
    await rm(path.join(DATA_DIR, "backups"), { recursive: true, force: true });
    for (const file of parsed.files) {
      const target = path.join(DATA_DIR, ...file.path.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, { flag: "wx" });
    }
    await unlink(path.join(BACKUPS_DIR, "restore-pending.nourix"));
    await rm(previousDirectory, { recursive: true, force: true });
    console.log("تمت استعادة قاعدة البيانات من النسخة الاحتياطية المحددة.");
    return true;
  } catch (error) {
    if (restoredDatabase) await restoredDatabase.end();
    await rm(DATA_DIR, { recursive: true, force: true });
    await rename(previousDirectory, DATA_DIR);
    throw error;
  }
}

function normalizeSizePrices(value, fallbackPrice) {
  const prices = typeof value === "string" ? JSON.parse(value) : (value || {});
  return Object.fromEntries(Object.keys(SIZE_LABELS).map((size) => [
    size,
    Number.isFinite(Number(prices[size])) ? Number(prices[size]) : fallbackPrice,
  ]));
}

async function inTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function requireUser(req, res, next) {
  try {
    const token = req.cookies[COOKIE_NAME];
    if (!token) return res.status(401).json({ error: "سجّل الدخول للمتابعة." });
    const result = await pool.query(
      `SELECT u.id, u.username, u.role, u.page_permissions
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW() AND u.active = TRUE`,
      [hashSessionToken(token)]
    );
    if (!result.rowCount) return res.status(401).json({ error: "انتهت الجلسة. سجّل الدخول مرة أخرى." });
    req.user = {
      id: Number(result.rows[0].id),
      username: result.rows[0].username,
      role: result.rows[0].role,
      pagePermissions: result.rows[0].role === "admin" ? PAGE_PERMISSIONS : result.rows[0].page_permissions,
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

const requireAdmin = (req, res, next) => {
  if (req.user.role !== "admin") return res.status(403).json({ error: "هذه العملية متاحة لحساب المدير فقط." });
  return next();
};
const requirePage = (...pages) => (req, res, next) => {
  if (req.user.role === "admin" || pages.some((page) => req.user.pagePermissions.includes(page))) return next();
  return res.status(403).json({ error: "ليس لديك صلاحية للوصول إلى هذه الصفحة." });
};

app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (!origin) return res.status(403).json({ error: "تعذر التحقق من مصدر الطلب." });
  try {
    if (new URL(origin).host !== req.get("host")) return res.status(403).json({ error: "مصدر الطلب غير مسموح." });
  } catch {
    return res.status(403).json({ error: "مصدر الطلب غير صالح." });
  }
  if (pendingRestore) {
    return res.status(503).json({ error: "الاستعادة جاهزة. أعد تشغيل البرنامج قبل متابعة العمل." });
  }
  return next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "محاولات تسجيل الدخول كثيرة. حاول بعد 15 دقيقة." },
});

app.get("/api/setup/status", asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT COUNT(*)::int AS count FROM users");
  res.json({ needsSetup: result.rows[0].count === 0 });
}));

app.post("/api/setup", asyncRoute(async (req, res) => {
  let logoUrl = "";
  let config;
  const username = trimText(req.body.username, 40, "اسم الدخول").toLowerCase();
  const password = readNewPassword(req.body.password);
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) fail(400, "اسم الدخول يجب أن يكون 3-40 حرفًا إنجليزيًا أو رقمًا أو _ . -");
  const configDetails = readRestaurantConfig(req.body);
  try {
    const user = await inTransaction(async (client) => {
      await client.query("LOCK TABLE users IN EXCLUSIVE MODE");
      const existing = await client.query("SELECT COUNT(*)::int AS count FROM users");
      if (existing.rows[0].count) fail(409, "تم إعداد البرنامج بالفعل. سجّل الدخول بحساب المدير.");
      if (req.body.logoData) logoUrl = await saveRestaurantLogo(req.body.logoData);
      config = { ...configDetails, logoUrl };
      const created = await client.query(
        "INSERT INTO users (username, password_hash, role, page_permissions) VALUES ($1, $2, 'admin', $3::jsonb) RETURNING id, username, role",
        [username, await hashPassword(password), JSON.stringify(PAGE_PERMISSIONS)]
      );
      await saveRestaurantConfig(config);
      return created.rows[0];
    });
    try {
      await createDatabaseBackup("auto");
    } catch (error) {
      console.error("تعذر إنشاء النسخة الاحتياطية بعد إعداد المطعم:", error);
    }
    res.status(201).json({
      user: { id: Number(user.id), username: user.username, role: user.role, pagePermissions: PAGE_PERMISSIONS },
      restaurant: config,
    });
  } catch (error) {
    if (logoUrl) {
      try {
        await removeRestaurantLogo(logoUrl);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") console.error("تعذر حذف شعار المطعم بعد فشل الإعداد:", cleanupError);
      }
    }
    throw error;
  }
}));

app.post("/api/auth/login", loginLimiter, asyncRoute(async (req, res) => {
  const username = trimText(req.body.username, 40, "اسم الدخول").toLowerCase();
  const password = readPassword(req.body.password);
  const result = await pool.query(
    "SELECT id, username, role, page_permissions, password_hash FROM users WHERE username = $1 AND active = TRUE",
    [username]
  );
  const user = result.rows[0];
  const passwordMatches = user
    ? await verifyPassword(password, user.password_hash)
    : await verifyPassword(password, "scrypt:00000000000000000000000000000000:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000");
  if (!user || !passwordMatches) fail(401, "اسم الدخول أو كلمة المرور غير صحيحة.");
  const token = createSessionToken();
  const expiry = new Date(Date.now() + SESSION_TTL_MS);
  await pool.query(
    "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
    [hashSessionToken(token), user.id, expiry]
  );
  await pool.query("DELETE FROM sessions WHERE expires_at <= NOW()");
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
  res.json({ user: {
    id: Number(user.id), username: user.username, role: user.role,
    pagePermissions: user.role === "admin" ? PAGE_PERMISSIONS : user.page_permissions,
  } });
}));

app.get("/api/auth/users", asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT username FROM users WHERE active = TRUE ORDER BY username");
  res.json({ users: result.rows.map((user) => ({ username: user.username })) });
}));

app.get("/api/auth/me", requireUser, (req, res) => res.json({ user: req.user }));
app.get("/api/restaurant", requireUser, asyncRoute(async (_req, res) => {
  res.json({ restaurant: await loadRestaurantConfig() });
}));
app.get("/api/settings", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  res.json({ settings: await loadRestaurantConfig() });
}));
app.get("/api/backups", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  res.json({ backups: await listDatabaseBackups() });
}));
app.post("/api/backups", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  res.status(201).json({ backup: await createDatabaseBackup() });
}));
app.get("/api/backups/:filename", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const filename = req.params.filename;
  if (!BACKUP_FILENAME_PATTERN.test(filename)) fail(400, "اسم النسخة الاحتياطية غير صالح.");
  const backupPath = path.join(BACKUPS_DIR, filename);
  try {
    await stat(backupPath);
  } catch (error) {
    if (error.code === "ENOENT") fail(404, "النسخة الاحتياطية غير موجودة.");
    throw error;
  }
  res.download(backupPath, filename, (error) => {
    if (error && !res.headersSent) res.status(error.statusCode || 500).json({ error: "تعذر تنزيل النسخة الاحتياطية." });
  });
}));
app.post("/api/backups/restore", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  if (!Buffer.isBuffer(req.body)) fail(400, "أرسل ملف نسخة احتياطية صالحًا.");
  const pendingPath = path.join(BACKUPS_DIR, "restore-pending.nourix");
  try {
    await stat(pendingPath);
    fail(409, "توجد استعادة معلقة بالفعل. أعد تشغيل البرنامج لإتمامها أولًا.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await validateDatabaseBackup(req.body);
  await createDatabaseBackup();
  await mkdir(BACKUPS_DIR, { recursive: true });
  const temporaryPath = `${pendingPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, req.body, { flag: "wx" });
    await rename(temporaryPath, pendingPath);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== "ENOENT") console.error("تعذر حذف ملف الاستعادة المؤقت:", cleanupError);
    }
    throw error;
  }
  pendingRestore = true;
  res.status(202).json({ message: "تم التحقق من النسخة وحفظ نسخة أمان. أعد تشغيل البرنامج لإتمام الاستعادة." });
}));
app.get("/api/printers", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const printers = await listSystemPrinters();
  let defaultPrinter = "";
  try {
    defaultPrinter = (await getDefaultPrinter())?.name || "";
  } catch (error) {
    console.error("تعذر تحديد طابعة Windows الافتراضية:", error);
    fail(500, "تعذر قراءة الطابعة الافتراضية في Windows.");
  }
  res.json({ printers, defaultPrinter });
}));
app.patch("/api/settings", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const currentConfig = await loadRestaurantConfig();
  const removeLogo = req.body.removeLogo === true;
  if (removeLogo && req.body.logoData) fail(400, "اختر شعارًا جديدًا أو احذف الشعار الحالي.");
  let newLogoUrl = "";
  let config;
  try {
    if (req.body.logoData) newLogoUrl = await saveRestaurantLogo(req.body.logoData);
    config = readRestaurantConfig(req.body, {
      logoUrl: removeLogo ? "" : (newLogoUrl || currentConfig.logoUrl),
    });
    await validateInstalledPrinters(config.printer);
    await saveRestaurantConfig(config);
  } catch (error) {
    if (newLogoUrl) {
      try {
        await removeRestaurantLogo(newLogoUrl);
      } catch (cleanupError) {
        if (cleanupError.code !== "ENOENT") console.error("تعذر حذف شعار المطعم بعد فشل حفظ الإعدادات:", cleanupError);
      }
    }
    throw error;
  }
  if (currentConfig.logoUrl && currentConfig.logoUrl !== config.logoUrl) {
    try {
      await removeRestaurantLogo(currentConfig.logoUrl);
    } catch (error) {
      if (error.code !== "ENOENT") console.error("تعذر حذف شعار المطعم السابق:", error);
    }
  }
  res.json({ settings: config });
}));
app.post("/api/auth/logout", requireUser, asyncRoute(async (req, res) => {
  const token = req.cookies[COOKIE_NAME];
  await pool.query("DELETE FROM sessions WHERE token_hash = $1", [hashSessionToken(token)]);
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: COOKIE_SECURE, sameSite: "strict", path: "/" });
  res.json({ ok: true });
}));

app.get("/api/users", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const result = await pool.query(
    "SELECT id, username, role, page_permissions, active, created_at FROM users ORDER BY created_at DESC"
  );
  res.json({ users: result.rows.map((user) => ({
    id: Number(user.id), username: user.username, role: user.role,
    pagePermissions: user.role === "admin" ? PAGE_PERMISSIONS : user.page_permissions,
    active: user.active, createdAt: user.created_at,
  })) });
}));

app.post("/api/users", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const username = trimText(req.body.username, 40, "اسم الدخول").toLowerCase();
  const password = readNewPassword(req.body.password);
  const role = req.body.role;
  const pagePermissions = readPagePermissions(req.body.pagePermissions, role);
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) fail(400, "اسم الدخول يجب أن يكون 3-40 حرفًا إنجليزيًا أو رقمًا أو _ . -");
  if (!["admin", "cashier"].includes(role)) fail(400, "نوع الحساب غير صالح.");
  try {
    const result = await pool.query(
      "INSERT INTO users (username, password_hash, role, page_permissions) VALUES ($1, $2, $3, $4::jsonb) RETURNING id, username, role, page_permissions, active, created_at",
      [username, await hashPassword(password), role, JSON.stringify(pagePermissions)]
    );
    const user = result.rows[0];
    res.status(201).json({ user: {
      id: Number(user.id), username: user.username, role: user.role,
      pagePermissions: role === "admin" ? PAGE_PERMISSIONS : user.page_permissions,
      active: user.active, createdAt: user.created_at,
    } });
  } catch (error) {
    if (error.code === "23505") fail(409, "اسم الدخول مستخدم بالفعل.");
    throw error;
  }
}));

app.patch("/api/users/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = numberValue(req.params.id, "المستخدم", { min: 1, integer: true });
  const username = trimText(req.body.username, 40, "اسم الدخول").toLowerCase();
  const role = req.body.role;
  const pagePermissions = readPagePermissions(req.body.pagePermissions, role);
  const active = req.body.active;
  const password = req.body.password ? readNewPassword(req.body.password) : "";
  if (!/^[a-z0-9_.-]{3,40}$/.test(username)) fail(400, "اسم الدخول يجب أن يكون 3-40 حرفًا إنجليزيًا أو رقمًا أو _ . -");
  if (!["admin", "cashier"].includes(role)) fail(400, "نوع الحساب غير صالح.");
  if (typeof active !== "boolean") fail(400, "حالة الحساب غير صالحة.");
  if (id === req.user.id && (!active || role !== "admin")) fail(400, "لا يمكن إيقاف حساب المدير الحالي أو تغيير صلاحيته.");
  const targetResult = await pool.query("SELECT id, role, active FROM users WHERE id = $1", [id]);
  const target = targetResult.rows[0];
  if (!target) fail(404, "المستخدم غير موجود.");
  if (target.role === "admin" && target.active && (!active || role !== "admin")) {
    const admins = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND active = TRUE");
    if (admins.rows[0].count <= 1) fail(400, "يجب الإبقاء على حساب مدير نشط واحد على الأقل.");
  }
  try {
    const values = [username, role, active, JSON.stringify(pagePermissions), id];
    const passwordSql = password ? ", password_hash = $6" : "";
    if (password) values.push(await hashPassword(password));
    const result = await pool.query(
      `UPDATE users SET username = $1, role = $2, active = $3, page_permissions = $4::jsonb${passwordSql}
       WHERE id = $5 RETURNING id, username, role, page_permissions, active, created_at`,
      values
    );
    if (password || !active) {
      await pool.query(
        "DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2",
        [id, hashSessionToken(req.cookies[COOKIE_NAME] || "")]
      );
    }
    const user = result.rows[0];
    res.json({ user: {
      id: Number(user.id), username: user.username, role: user.role,
      pagePermissions: role === "admin" ? PAGE_PERMISSIONS : user.page_permissions,
      active: user.active, createdAt: user.created_at,
    } });
  } catch (error) {
    if (error.code === "23505") fail(409, "اسم الدخول مستخدم بالفعل.");
    throw error;
  }
}));

app.delete("/api/users/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = numberValue(req.params.id, "المستخدم", { min: 1, integer: true });
  if (id === req.user.id) fail(400, "لا يمكنك حذف حسابك أثناء تسجيل الدخول.");
  const targetResult = await pool.query("SELECT id, role, active FROM users WHERE id = $1", [id]);
  const target = targetResult.rows[0];
  if (!target) fail(404, "المستخدم غير موجود.");
  if (target.role === "admin" && target.active) {
    const admins = await pool.query("SELECT COUNT(*)::int AS count FROM users WHERE role = 'admin' AND active = TRUE");
    if (admins.rows[0].count <= 1) fail(400, "يجب الإبقاء على حساب مدير نشط واحد على الأقل.");
  }
  const historyResult = await pool.query(
    `SELECT
       EXISTS (SELECT 1 FROM shift_cash_float_entries WHERE cashier_id = $1) OR
       EXISTS (SELECT 1 FROM delivery_collections WHERE collected_by = $1) OR
       EXISTS (SELECT 1 FROM orders WHERE created_by = $1) OR
       EXISTS (SELECT 1 FROM expenses WHERE created_by = $1) AS has_history`,
    [id]
  );
  if (historyResult.rows[0].has_history) {
    fail(409, "لا يمكن حذف هذا المستخدم لارتباطه بطلبات أو سجلات مالية سابقة. يمكنك إيقاف حسابه بدلًا من ذلك.");
  }
  await pool.query("DELETE FROM users WHERE id = $1", [id]);
  res.json({ ok: true });
}));

app.get("/api/delivery-drivers", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const result = await pool.query(
    "SELECT id, name, phone, created_at FROM delivery_drivers ORDER BY created_at DESC, id DESC"
  );
  res.json({ drivers: result.rows.map((driver) => ({
    id: Number(driver.id),
    name: driver.name,
    phone: driver.phone,
    createdAt: driver.created_at,
  })) });
}));

app.delete("/api/delivery-drivers/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const driverId = numberValue(req.params.id, "سائق التوصيل", { min: 1, integer: true });
  await inTransaction(async (client) => {
    const driver = await client.query("SELECT id FROM delivery_drivers WHERE id = $1 FOR UPDATE", [driverId]);
    if (!driver.rowCount) fail(404, "سائق التوصيل غير موجود.");
    const history = await client.query(
      `SELECT EXISTS (SELECT 1 FROM orders WHERE driver_id = $1) OR
              EXISTS (SELECT 1 FROM delivery_collections WHERE driver_id = $1) AS has_history`,
      [driverId]
    );
    if (history.rows[0].has_history) {
      fail(409, "لا يمكن حذف هذا السائق لارتباطه بطلبات أو تحصيلات سابقة.");
    }
    await client.query("DELETE FROM delivery_drivers WHERE id = $1", [driverId]);
  });
  res.json({ ok: true });
}));

app.get("/api/delivery-drivers/:id/summary", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const driverId = numberValue(req.params.id, "سائق التوصيل", { min: 1, integer: true });
  const driverResult = await pool.query("SELECT id, name, phone FROM delivery_drivers WHERE id = $1", [driverId]);
  if (!driverResult.rowCount) fail(404, "سائق التوصيل غير موجود.");
  const [totals, collections, orders] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS order_count,
              COALESCE(SUM(o.subtotal) FILTER (WHERE o.status <> 'ملغي'), 0) AS restaurant_due,
              COALESCE(SUM(o.delivery_fee) FILTER (WHERE o.status <> 'ملغي'), 0) AS driver_due
       FROM orders o WHERE o.driver_id = $1`,
      [driverId]
    ),
    pool.query(
      `SELECT c.id, c.amount, c.created_at, u.username
       FROM delivery_collections c JOIN users u ON u.id = c.collected_by
       WHERE c.driver_id = $1 ORDER BY c.created_at DESC, c.id DESC LIMIT 100`,
      [driverId]
    ),
    fetchOrders({ driverId, limit: 500 }),
  ]);
  const collected = Number((await pool.query(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM delivery_collections WHERE driver_id = $1",
    [driverId]
  )).rows[0].total);
  const restaurantDue = Number(totals.rows[0].restaurant_due);
  res.json({
    driver: {
      id: Number(driverResult.rows[0].id),
      name: driverResult.rows[0].name,
      phone: driverResult.rows[0].phone,
    },
    summary: {
      orderCount: Number(totals.rows[0].order_count),
      restaurantDue,
      driverDue: Number(totals.rows[0].driver_due),
      collected,
      remaining: Math.max(0, restaurantDue - collected),
    },
    collections: collections.rows.map((entry) => ({
      id: Number(entry.id),
      amount: Number(entry.amount),
      createdAt: entry.created_at,
      collectedBy: entry.username,
    })),
    orders,
  });
}));

app.post("/api/delivery-drivers/:id/collections", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const driverId = numberValue(req.params.id, "سائق التوصيل", { min: 1, integer: true });
  const amount = numberValue(req.body.amount, "مبلغ التحصيل", { min: 0.01, max: 10000000 });
  const result = await inTransaction(async (client) => {
    const driver = await client.query("SELECT id FROM delivery_drivers WHERE id = $1 FOR UPDATE", [driverId]);
    if (!driver.rowCount) fail(404, "سائق التوصيل غير موجود.");
    const totals = await client.query(
      `SELECT COALESCE(SUM(o.subtotal) FILTER (WHERE o.status <> 'ملغي'), 0) AS restaurant_due
       FROM orders o WHERE o.driver_id = $1`,
      [driverId]
    );
    const collected = await client.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM delivery_collections WHERE driver_id = $1",
      [driverId]
    );
    const remaining = Math.max(0, Number(totals.rows[0].restaurant_due) - Number(collected.rows[0].total));
    if (amount > remaining) fail(400, `مبلغ التحصيل يتجاوز مستحق المطعم المتبقي (${remaining.toFixed(2)} ج.م).`);
    const collection = await client.query(
      `INSERT INTO delivery_collections (driver_id, collected_by, amount)
       VALUES ($1, $2, $3) RETURNING id, amount, created_at`,
      [driverId, req.user.id, amount]
    );
    return collection.rows[0];
  });
  res.status(201).json({ collection: {
    id: Number(result.id),
    amount: Number(result.amount),
    createdAt: result.created_at,
  } });
}));

app.post("/api/delivery-drivers", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const name = trimText(req.body.name, 100, "اسم السائق");
  const phone = normalizePhone(req.body.phone);
  try {
    const result = await pool.query(
      "INSERT INTO delivery_drivers (name, phone) VALUES ($1, $2) RETURNING id, name, phone, created_at",
      [name, phone]
    );
    const driver = result.rows[0];
    res.status(201).json({ driver: {
      id: Number(driver.id),
      name: driver.name,
      phone: driver.phone,
      createdAt: driver.created_at,
    } });
  } catch (error) {
    if (error.code === "23505") fail(409, "رقم الهاتف مسجل لسائق توصيل بالفعل.");
    throw error;
  }
}));

app.patch("/api/delivery-drivers/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = numberValue(req.params.id, "سائق التوصيل", { min: 1, integer: true });
  const name = trimText(req.body.name, 100, "اسم السائق");
  const phone = normalizePhone(req.body.phone);
  try {
    const result = await pool.query(
      `UPDATE delivery_drivers SET name = $1, phone = $2
       WHERE id = $3 RETURNING id, name, phone, created_at`,
      [name, phone, id]
    );
    if (!result.rowCount) fail(404, "سائق التوصيل غير موجود.");
    const driver = result.rows[0];
    res.json({ driver: {
      id: Number(driver.id),
      name: driver.name,
      phone: driver.phone,
      createdAt: driver.created_at,
    } });
  } catch (error) {
    if (error.code === "23505") fail(409, "رقم الهاتف مسجل لسائق توصيل بالفعل.");
    throw error;
  }
}));

app.get("/api/products", requireUser, requirePage("pos", "menu"), asyncRoute(async (req, res) => {
  const includeInactive = req.user.role === "admin" && req.query.all === "true";
  const result = await pool.query(
    `SELECT id, name, description, category, image_url, price, size_prices, active
     FROM products ${includeInactive ? "" : "WHERE active = TRUE"} ORDER BY category, name`
  );
  res.json({ products: result.rows.map(toProduct) });
}));

app.get("/api/product-categories", requireUser, requirePage("pos", "menu"), asyncRoute(async (_req, res) => {
  const result = await pool.query("SELECT name FROM product_categories ORDER BY name");
  res.json({ categories: result.rows.map((row) => row.name) });
}));

app.post("/api/product-categories", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const name = trimText(req.body.name, 60, "اسم الفئة");
  try {
    const result = await pool.query(
      "INSERT INTO product_categories (name) VALUES ($1) RETURNING name",
      [name]
    );
    res.status(201).json({ category: result.rows[0].name });
  } catch (error) {
    if (error.code === "23505") fail(409, "اسم الفئة موجود بالفعل.");
    throw error;
  }
}));

app.put("/api/product-categories/:name", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const currentName = trimText(req.params.name, 60, "اسم الفئة");
  const name = trimText(req.body.name, 60, "اسم الفئة");
  try {
    const result = await pool.query(
      "UPDATE product_categories SET name = $1 WHERE name = $2 RETURNING name",
      [name, currentName]
    );
    if (!result.rowCount) fail(404, "الفئة غير موجودة.");
    res.json({ category: result.rows[0].name });
  } catch (error) {
    if (error.code === "23505") fail(409, "اسم الفئة موجود بالفعل.");
    throw error;
  }
}));

app.delete("/api/product-categories/:name", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const name = trimText(req.params.name, 60, "اسم الفئة");
  try {
    const result = await pool.query("DELETE FROM product_categories WHERE name = $1 RETURNING name", [name]);
    if (!result.rowCount) fail(404, "الفئة غير موجودة.");
    res.json({ category: result.rows[0].name });
  } catch (error) {
    if (["23503", "23001"].includes(error.code)) fail(409, "لا يمكن حذف الفئة لارتباط أصناف بها. غيّر فئة الأصناف أولًا.");
    throw error;
  }
}));

async function validateProductCategory(category) {
  const result = await pool.query("SELECT 1 FROM product_categories WHERE name = $1", [category]);
  if (!result.rowCount) fail(400, "اختر فئة موجودة من القائمة.");
}

app.post("/api/products", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const product = readProduct(req.body);
  await validateProductCategory(product.category);
  const imageUrl = req.body.imageData ? await saveProductImage(req.body.imageData) : null;
  try {
    const result = await pool.query(
      `INSERT INTO products (name, description, category, image_url, price, size_prices)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING id, name, description, category, image_url, price, size_prices, active`,
      [product.name, product.description, product.category, imageUrl, product.price, JSON.stringify(product.sizePrices)]
    );
    res.status(201).json({ product: toProduct(result.rows[0]) });
  } catch (error) {
    if (imageUrl) {
      try {
        await removeProductImage(imageUrl);
      } catch (cleanupError) {
        console.error("تعذر حذف صورة الصنف بعد فشل الحفظ:", cleanupError);
      }
    }
    throw error;
  }
}));

app.put("/api/products/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = numberValue(req.params.id, "الصنف", { min: 1, integer: true });
  const product = readProduct(req.body);
  await validateProductCategory(product.category);
  const currentResult = await pool.query("SELECT image_url, active FROM products WHERE id = $1", [id]);
  if (!currentResult.rowCount) fail(404, "الصنف غير موجود.");
  const current = currentResult.rows[0];
  const imageUrl = req.body.imageData ? await saveProductImage(req.body.imageData) : current.image_url;
  const active = typeof req.body.active === "boolean" ? req.body.active : current.active;
  try {
    const result = await pool.query(
      `UPDATE products SET name=$1, description=$2, category=$3, image_url=$4,
       price=$5, size_prices=$6::jsonb, active=$7
       WHERE id=$8
       RETURNING id, name, description, category, image_url, price, size_prices, active`,
      [product.name, product.description, product.category, imageUrl, product.price, JSON.stringify(product.sizePrices), active, id]
    );
    if (current.image_url && imageUrl !== current.image_url) {
      try {
        await removeProductImage(current.image_url);
      } catch (error) {
        console.error("تعذر حذف صورة الصنف السابقة:", error);
      }
    }
    res.json({ product: toProduct(result.rows[0]) });
  } catch (error) {
    if (imageUrl && imageUrl !== current.image_url && req.body.imageData) {
      try {
        await removeProductImage(imageUrl);
      } catch (cleanupError) {
        console.error("تعذر حذف صورة الصنف بعد فشل التحديث:", cleanupError);
      }
    }
    throw error;
  }
}));

function readProduct(body) {
  const name = trimText(body.name, 100, "اسم الصنف");
  const description = trimText(body.description ?? "", 240, "الوصف", { required: false });
  const category = trimText(body.category, 60, "التصنيف");
  const fallbackPrice = numberValue(body.price ?? body.sizePrices?.medium, "السعر");
  const suppliedPrices = body.sizePrices && typeof body.sizePrices === "object" && !Array.isArray(body.sizePrices)
    ? body.sizePrices
    : {};
  const sizePrices = Object.fromEntries(Object.keys(SIZE_LABELS).map((size) => [
    size,
    numberValue(suppliedPrices[size] ?? fallbackPrice, `سعر حجم ${SIZE_LABELS[size]}`),
  ]));
  const price = sizePrices.medium;
  return { name, description, category, price, sizePrices };
}

app.post("/api/orders", requireUser, requirePage("pos"), asyncRoute(async (req, res) => {
  const orderType = req.body.type;
  if (!["takeaway", "delivery", "reservation"].includes(orderType)) fail(400, "نوع الطلب غير صالح.");
  if (!Array.isArray(req.body.items) || !req.body.items.length || req.body.items.length > 50) fail(400, "أضف أصنافًا صالحة للطلب.");
  const quantities = new Map();
  for (const item of req.body.items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail(400, "أحد أصناف الطلب غير صالح.");
    const productId = numberValue(item.productId, "الصنف", { min: 1, integer: true });
    const quantity = numberValue(item.quantity, "الكمية", { min: 1, max: 500, integer: true });
    const size = item.size;
    if (!Object.hasOwn(SIZE_LABELS, size)) fail(400, "اختر حجمًا صالحًا لكل صنف.");
    const key = `${productId}:${size}`;
    quantities.set(key, (quantities.get(key) || 0) + quantity);
  }
  const customerName = trimText(req.body.customerName ?? "", 100, "اسم العميل", { required: false });
  const phoneInput = trimText(req.body.phone ?? "", 30, "رقم الهاتف", { required: false });
  const address = trimText(req.body.address ?? "", 240, "العنوان", { required: false });
  const note = trimText(req.body.note ?? "", 500, "ملاحظات الطلب", { required: false });
  const paymentMethod = req.body.paymentMethod;
  if (!["cash", "cash_wallet", "visa"].includes(paymentMethod)) fail(400, "اختر طريقة دفع صحيحة.");
  const deliveryFee = orderType === "delivery"
    ? numberValue(req.body.deliveryFee, "سعر التوصيل", { min: 0, max: 1000000 })
    : 0;
  if ((phoneInput && !customerName) || (customerName && !phoneInput)) fail(400, "أدخل اسم العميل ورقم الهاتف معًا.");
  if (orderType === "delivery" && (!customerName || !phoneInput || !address)) fail(400, "بيانات الدليفري تتطلب الاسم ورقم الهاتف والعنوان.");
  if (orderType === "reservation" && (!customerName || !phoneInput)) fail(400, "الحجز يتطلب الاسم ورقم الهاتف.");
  const phone = phoneInput ? normalizePhone(phoneInput) : null;

  const order = await inTransaction(async (client) => {
    const activeShiftResult = await client.query(
      "SELECT id FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE"
    );
    if (!activeShiftResult.rowCount) fail(409, "لا توجد وردية نشطة. ابدأ وردية جديدة قبل تسجيل الطلب.");
    const shiftId = activeShiftResult.rows[0].id;
    const nextOrderNumberResult = await client.query(
      "SELECT COALESCE(MAX(shift_order_number), 0) + 1 AS next_number FROM orders WHERE shift_id = $1",
      [shiftId]
    );
    const shiftOrderNumber = Number(nextOrderNumberResult.rows[0].next_number);
    const ids = [...new Set([...quantities.keys()].map((key) => Number(key.split(":")[0])))];
    const productResult = await client.query(
      "SELECT id, name, price, size_prices FROM products WHERE id = ANY($1::bigint[]) AND active = TRUE ORDER BY id FOR UPDATE",
      [ids]
    );
    if (productResult.rowCount !== ids.length) fail(409, "أحد الأصناف لم يعد متاحًا في المنيو.");
    const productsById = new Map(productResult.rows.map((product) => [Number(product.id), product]));
    let customerId = null;
    if (phone) {
      const customerResult = await client.query(
        `INSERT INTO customers (name, phone) VALUES ($1, $2)
         ON CONFLICT (phone) DO UPDATE SET name=EXCLUDED.name, updated_at=NOW()
         RETURNING id`,
        [customerName, phone]
      );
      customerId = customerResult.rows[0].id;
      if (address) {
        await client.query(
          `INSERT INTO customer_addresses (customer_id, address, delivery_fee) VALUES ($1, $2, $3)
           ON CONFLICT (customer_id, address) DO UPDATE SET delivery_fee=EXCLUDED.delivery_fee`,
          [customerId, address, deliveryFee]
        );
      }
    }
    const items = [...quantities.entries()].map(([key, quantity]) => {
      const [idText, size] = key.split(":");
      const id = Number(idText);
      const product = productsById.get(id);
      const sizePrices = normalizeSizePrices(product.size_prices, Number(product.price));
      const unitPrice = sizePrices[size];
      return { id, name: product.name, size, quantity, unitPrice, lineTotal: Number((unitPrice * quantity).toFixed(2)) };
    });
    const subtotal = Number(items.reduce((sum, item) => sum + item.lineTotal, 0).toFixed(2));
    const total = Number((subtotal + deliveryFee).toFixed(2));
    const orderIdResult = await client.query("SELECT nextval(pg_get_serial_sequence('orders', 'id')) AS id");
    const orderId = orderIdResult.rows[0].id;
    const orderNumber = `#${String(orderId).padStart(8, "0")}`;
    const created = await client.query(
      `INSERT INTO orders
       (id, order_number, customer_id, created_by, order_type, subtotal, delivery_fee, payment_method, total, delivery_address, note, shift_id, shift_order_number)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id, created_at`,
      [orderId, orderNumber, customerId, req.user.id, orderType, subtotal, deliveryFee, paymentMethod, total, address, note, shiftId, shiftOrderNumber]
    );
    const id = created.rows[0].id;
    for (const item of items) {
      await client.query(
        "INSERT INTO order_items (order_id, product_id, product_name, size_key, quantity, unit_price, line_total) VALUES ($1,$2,$3,$4,$5,$6,$7)",
        [id, item.id, item.name, item.size, item.quantity, item.unitPrice, item.lineTotal]
      );
    }
    return {
      id: orderNumber, displayNumber: String(shiftOrderNumber), customer: customerName || "عميل تيك أوي", phone: phone || "",
      address, type: orderType, status: "قيد التحضير", items, subtotal, deliveryFee, total,
      paymentMethod, paymentLabel: PAYMENT_METHODS[paymentMethod], note, createdAt: created.rows[0].created_at, createdBy: req.user.username,
    };
  });
  res.status(201).json({ order });
}));

async function fetchOrders({ customerId, driverId, limit = 500, hideOldCompleted = false, lastMonth = false } = {}) {
  const values = [];
  const conditions = [];
  if (customerId) {
    values.push(customerId);
    conditions.push(`o.customer_id = $${values.length}`);
  }
  if (driverId) {
    values.push(driverId);
    conditions.push(`o.driver_id = $${values.length}`);
  }
  if (hideOldCompleted) {
    conditions.push(`(
      (o.status <> 'مكتمل' OR o.completed_at > NOW() - INTERVAL '10 minutes')
      AND (o.status <> 'ملغي' OR o.cancelled_at > NOW() - INTERVAL '1 hour')
    )`);
  }
  if (lastMonth) conditions.push("o.created_at >= date_trunc('month', NOW())");
  const limitClause = limit === null ? "" : `LIMIT $${values.push(limit)}`;
  const condition = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const result = await pool.query(
    `SELECT o.id, o.order_number, o.shift_order_number, o.order_type, o.status, o.subtotal, o.delivery_fee,
            o.payment_method, o.note, o.total, o.delivery_address, o.created_at,
            o.assigned_at, o.completed_at, o.cancelled_at, o.cancellation_reason,
            o.driver_id, o.printed_at, d.name AS driver_name, d.phone AS driver_phone,
            c.name AS customer_name, c.phone, u.username AS created_by_name
     FROM orders o LEFT JOIN customers c ON c.id=o.customer_id
     JOIN users u ON u.id=o.created_by
     LEFT JOIN delivery_drivers d ON d.id=o.driver_id ${condition}
     ORDER BY o.created_at DESC ${limitClause}`,
    values
  );
  if (!result.rowCount) return [];
  const orderIds = result.rows.map((row) => row.id);
  const itemsResult = await pool.query(
    `SELECT order_id, product_id, product_name, size_key, quantity, unit_price, line_total
     FROM order_items WHERE order_id = ANY($1::bigint[]) ORDER BY id`,
    [orderIds]
  );
  const itemsByOrder = new Map();
  for (const item of itemsResult.rows) {
    const list = itemsByOrder.get(String(item.order_id)) || [];
    list.push({
      id: item.product_id ? Number(item.product_id) : null,
      name: item.product_name,
      size: item.size_key,
      sizeLabel: SIZE_LABELS[item.size_key],
      quantity: Number(item.quantity),
      price: Number(item.unit_price),
      lineTotal: Number(item.line_total),
    });
    itemsByOrder.set(String(item.order_id), list);
  }
  return result.rows.map((row) => ({
    id: row.order_number,
    displayNumber: row.shift_order_number === null ? row.order_number : String(row.shift_order_number),
    customer: row.customer_name || "عميل تيك أوي",
    phone: row.phone || "",
    address: row.delivery_address,
    type: row.order_type,
    status: row.status,
    subtotal: Number(row.subtotal),
    deliveryFee: Number(row.delivery_fee),
    paymentMethod: row.payment_method,
    paymentLabel: PAYMENT_METHODS[row.payment_method],
    total: Number(row.total),
    note: row.note,
    createdAt: row.created_at,
    createdBy: row.created_by_name,
    driverId: row.driver_id === null ? null : Number(row.driver_id),
    driverName: row.driver_name,
    driverPhone: row.driver_phone,
    printedAt: row.printed_at,
    assignedAt: row.assigned_at,
    completedAt: row.completed_at,
    cancelledAt: row.cancelled_at,
    cancellationReason: row.cancellation_reason,
    items: itemsByOrder.get(String(row.id)) || [],
  }));
}

async function advanceAssignedOrderStatuses() {
  await pool.query(
    `UPDATE orders
     SET status = 'مكتمل', completed_at = NOW()
     WHERE status = 'في الطريق'
       AND order_type IN ('delivery', 'reservation')
       AND driver_id IS NOT NULL
       AND assigned_at <= NOW() - INTERVAL '30 minutes'`
  );
}

app.get("/api/orders/count", requireUser, requirePage("pos"), asyncRoute(async (_req, res) => {
  await advanceAssignedOrderStatuses();
  const result = await pool.query("SELECT COUNT(*)::int AS count FROM orders WHERE status NOT IN ('مكتمل', 'ملغي')");
  res.json({ count: result.rows[0].count });
}));

app.get("/api/orders", requireUser, requirePage("orders"), asyncRoute(async (_req, res) => {
  await advanceAssignedOrderStatuses();
  res.json({ orders: await fetchOrders({ hideOldCompleted: true }) });
}));

app.get("/api/order-report", requireUser, requirePage("order-report"), asyncRoute(async (_req, res) => {
  await advanceAssignedOrderStatuses();
  res.json({ orders: await fetchOrders({ lastMonth: true, limit: null }) });
}));

const printingOrderNumbers = new Set();
app.post("/api/orders/:orderNumber/print", requireUser, requirePage("pos"), asyncRoute(async (req, res) => {
  const orderNumber = trimText(req.params.orderNumber, 24, "رقم الطلب");
  if (printingOrderNumbers.has(orderNumber)) fail(409, "تجري طباعة هذا الطلب بالفعل.");
  const encodedPdf = typeof req.body.pdfData === "string" &&
    req.body.pdfData.match(/^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/)?.[1];
  if (!encodedPdf || encodedPdf.length > 11_000_000) fail(400, "ملف الإيصال غير صالح أو يتجاوز الحجم المسموح.");
  const pdfBuffer = Buffer.from(encodedPdf, "base64");
  if (pdfBuffer.length < 5 || pdfBuffer.length > 8 * 1024 * 1024 || pdfBuffer.subarray(0, 5).toString() !== "%PDF-") {
    fail(400, "تعذر التحقق من ملف الإيصال.");
  }

  printingOrderNumbers.add(orderNumber);
  let temporaryDirectory = "";
  try {
    if (process.platform !== "win32") fail(501, "الإرسال المباشر للطابعات المحددة متاح حاليًا على Windows فقط.");
    const config = await loadRestaurantConfig();
    const printerJobs = [
      { label: "طابعة الكاشير", name: config.printer.cashierPrinter },
      ...(config.printer.secondPrinterEnabled
        ? [{ label: "الطابعة الثانية", name: config.printer.secondPrinter }]
        : []),
    ];
    if (!printerJobs[0].name) fail(400, "حدد طابعة الكاشير من صفحة الإعدادات قبل طباعة الطلب.");
    await validateInstalledPrinters(config.printer);

    const existing = await pool.query("SELECT printed_at FROM orders WHERE order_number = $1", [orderNumber]);
    if (!existing.rowCount) fail(404, "الطلب غير موجود.");
    if (existing.rows[0].printed_at) fail(409, "تمت طباعة هذا الطلب من قبل.");
    const order = (await fetchOrders({ limit: 500 })).find((entry) => entry.id === orderNumber);
    if (!order) fail(404, "الطلب غير موجود.");

    await mkdir(PRINT_JOBS_DIR, { recursive: true });
    temporaryDirectory = await mkdtemp(path.join(PRINT_JOBS_DIR, "job-"));
    const pdfPath = path.join(temporaryDirectory, "receipt.pdf");
    await writeFile(pdfPath, pdfBuffer, { flag: "wx" });
    const outcomes = await Promise.allSettled(printerJobs.map(({ name }) => printPdf(pdfPath, {
      printer: name,
      silent: true,
      scale: "fit",
    })));
    const failures = outcomes.flatMap((outcome, index) =>
      outcome.status === "rejected" ? [{ ...printerJobs[index], error: outcome.reason }] : []
    );
    if (failures.length) {
      failures.forEach((failure) => console.error(`تعذرت طباعة الطلب ${orderNumber} على ${failure.name}:`, failure.error));
      const failedNames = failures.map((failure) => failure.label).join(" و");
      const successfulNames = outcomes.flatMap((outcome, index) =>
        outcome.status === "fulfilled" ? [printerJobs[index].label] : []
      );
      const partialMessage = successfulNames.length
        ? ` أُرسل الطلب بالفعل إلى ${successfulNames.join(" و")}؛ قد يؤدي تكرار الطباعة إلى نسخة إضافية هناك.`
        : "";
      fail(502, `تعذرت الطباعة على ${failedNames}. تحقق من اتصال الطابعة وإعدادها ثم أعد المحاولة.${partialMessage}`);
    }

    const marked = await pool.query(
      "UPDATE orders SET printed_at = NOW() WHERE order_number = $1 AND printed_at IS NULL RETURNING printed_at",
      [orderNumber]
    );
    if (!marked.rowCount) fail(409, "أُرسل الطلب للطباعة لكن تعذر تحديث حالة الطباعة؛ تحقق من سجل الطلب.");
    order.printedAt = marked.rows[0].printed_at;
    res.json({ order, printers: printerJobs.map(({ name }) => name) });
  } finally {
    printingOrderNumbers.delete(orderNumber);
    if (temporaryDirectory) {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}));

app.patch("/api/orders/:orderNumber/driver", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const orderNumber = trimText(req.params.orderNumber, 24, "رقم الطلب");
  const driverId = numberValue(req.body.driverId, "سائق التوصيل", { min: 1, integer: true });
  const driver = await pool.query("SELECT id FROM delivery_drivers WHERE id = $1", [driverId]);
  if (!driver.rowCount) fail(404, "سائق التوصيل غير موجود.");
  await inTransaction(async (client) => {
    const result = await client.query(
      `UPDATE orders
       SET driver_id = $1, status = 'في الطريق',
           assigned_at = COALESCE(assigned_at, NOW()), completed_at = NULL
       WHERE order_number = $2
         AND order_type IN ('delivery', 'reservation')
         AND status NOT IN ('مكتمل', 'ملغي')
       RETURNING id`,
      [driverId, orderNumber]
    );
    if (!result.rowCount) {
      const exists = await client.query("SELECT id, order_type, status FROM orders WHERE order_number = $1", [orderNumber]);
      if (!exists.rowCount) fail(404, "الطلب غير موجود.");
      if (!["delivery", "reservation"].includes(exists.rows[0].order_type)) {
        fail(400, "يمكن إسناد سائق إلى طلبات الدليفري والحجز فقط.");
      }
      fail(409, "لا يمكن إسناد طلب مكتمل أو ملغي.");
    }
  });
  const updated = (await fetchOrders({ limit: 500 })).find((entry) => entry.id === orderNumber);
  res.json({ order: updated });
}));

app.delete("/api/orders/:orderNumber/driver", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const orderNumber = trimText(req.params.orderNumber, 24, "رقم الطلب");
  const result = await pool.query(
    `UPDATE orders
     SET driver_id = NULL, status = 'قيد التحضير', assigned_at = NULL, completed_at = NULL
     WHERE order_number = $1
       AND order_type IN ('delivery', 'reservation')
       AND driver_id IS NOT NULL
       AND status = 'في الطريق'
     RETURNING id`,
    [orderNumber]
  );
  if (!result.rowCount) {
    const exists = await pool.query("SELECT id FROM orders WHERE order_number = $1", [orderNumber]);
    if (!exists.rowCount) fail(404, "الطلب غير موجود.");
    fail(409, "لا يوجد إسناد نشط يمكن إلغاؤه لهذا الطلب.");
  }
  const updated = (await fetchOrders({ limit: 500 })).find((entry) => entry.id === orderNumber);
  res.json({ order: updated });
}));

app.patch("/api/orders/:orderNumber/status", requireUser, requirePage("orders"), asyncRoute(async (req, res) => {
  const orderNumber = trimText(req.params.orderNumber, 24, "رقم الطلب");
  const status = req.body.status;
  if (!["قيد التحضير", "جاهز", "مكتمل", "ملغي"].includes(status)) fail(400, "حالة الطلب غير صالحة.");
  const cancellationReason = status === "ملغي"
    ? trimText(req.body.reason, 240, "سبب الإلغاء")
    : "";
  await inTransaction(async (client) => {
    const result = await client.query("SELECT id, status FROM orders WHERE order_number=$1 FOR UPDATE", [orderNumber]);
    if (!result.rowCount) fail(404, "الطلب غير موجود.");
    const order = result.rows[0];
    if (order.status === status) return;
    if (order.status === "ملغي") fail(409, "لا يمكن تعديل حالة طلب ملغي.");
    if (status === "ملغي" && ["مكتمل", "ملغي"].includes(order.status)) {
      fail(409, "لا يمكن إلغاء طلب مكتمل أو ملغي بالفعل.");
    }
    await client.query(
      `UPDATE orders SET status=$1,
         completed_at=CASE WHEN $1::varchar='مكتمل' THEN NOW() ELSE NULL END,
         cancelled_at=CASE WHEN $1::varchar='ملغي' THEN NOW() ELSE NULL END,
         cancellation_reason=CASE WHEN $1::varchar='ملغي' THEN $2 ELSE '' END
       WHERE id=$3`,
      [status, cancellationReason, order.id]
    );
  });
  const orders = await fetchOrders({ limit: 500 });
  res.json({ order: orders.find((order) => order.id === orderNumber) });
}));

app.get("/api/customers", requireUser, requirePage("pos", "customers"), asyncRoute(async (req, res) => {
  const rawPhone = trimText(String(req.query.phone || ""), 30, "رقم الهاتف");
  const phone = normalizePhoneDigits(rawPhone);
  if (!/^\d{3,15}$/.test(phone)) fail(400, "أدخل 3 أرقام على الأقل للبحث.");
  const result = await pool.query(
    `SELECT c.id, c.name, c.phone, c.created_at,
            COALESCE((SELECT json_agg(json_build_object('address', a.address, 'deliveryFee', a.delivery_fee) ORDER BY a.created_at DESC) FROM customer_addresses a WHERE a.customer_id=c.id), '[]'::json) AS addresses,
            COUNT(o.id)::int AS order_count, COALESCE(SUM(o.total) FILTER (WHERE o.status <> 'ملغي'), 0) AS total_spent
     FROM customers c LEFT JOIN orders o ON o.customer_id=c.id
     WHERE c.phone LIKE $1 || '%'
     GROUP BY c.id ORDER BY c.phone LIMIT 30`,
    [phone]
  );
  const customers = result.rows.map((row) => ({
    id: Number(row.id), name: row.name, phone: row.phone,
    addresses: row.addresses, orderCount: Number(row.order_count), totalSpent: Number(row.total_spent),
    createdAt: row.created_at,
  }));
  if (customers.length === 1 && req.query.summary !== "true") {
    customers[0].orders = await fetchOrders({ customerId: customers[0].id, limit: 500 });
  }
  res.json({ customers });
}));

app.get("/api/expenses", requireUser, requirePage("expenses"), asyncRoute(async (req, res) => {
  const activeShift = await getCurrentShiftRow() || await ensureActiveShift();
  const result = await pool.query(
    `SELECT e.id, e.name, e.category, e.amount, e.payment, e.note, e.created_at, u.username AS created_by_name
     FROM expenses e JOIN users u ON u.id=e.created_by
     WHERE e.shift_id = $1
     ORDER BY e.created_at DESC`,
    [activeShift.id]
  );
  res.json({ expenses: result.rows.map((row) => ({
    id: Number(row.id), name: row.name, category: row.category, amount: Number(row.amount),
    payment: row.payment, note: row.note, createdAt: row.created_at, createdBy: row.created_by_name,
  })) });
}));

app.get("/api/expenses/archive", requireUser, requirePage("expenses"), asyncRoute(async (_req, res) => {
  const activeShift = await getCurrentShiftRow() || await ensureActiveShift();
  const result = await pool.query(
    `SELECT e.id, e.name, e.category, e.amount, e.payment, e.note, e.created_at, u.username AS created_by_name
     FROM expenses e JOIN users u ON u.id=e.created_by
     WHERE e.shift_id IS DISTINCT FROM $1
     ORDER BY e.created_at DESC, e.id DESC`,
    [activeShift.id]
  );
  res.json({ expenses: result.rows.map((row) => ({
    id: Number(row.id), name: row.name, category: row.category, amount: Number(row.amount),
    payment: row.payment, note: row.note, createdAt: row.created_at, createdBy: row.created_by_name,
  })) });
}));

app.get("/api/shifts", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const result = await pool.query(
    `SELECT s.id, s.opened_by, s.closed_by, s.opened_at, s.closed_at, s.printed_at, s.sales_total, s.cash_total,
            s.cash_wallet_total, s.visa_total, s.expenses_total, s.cancelled_total, s.opening_cash_total,
            s.cash_expenses_total, s.net_total,
            open_user.username AS opened_by_name,
            close_user.username AS closed_by_name
     FROM shifts s
     LEFT JOIN users open_user ON open_user.id = s.opened_by
     LEFT JOIN users close_user ON close_user.id = s.closed_by
     ORDER BY s.opened_at DESC LIMIT 200`
  );
  res.json({ shifts: result.rows.map((row) => ({
    id: Number(row.id),
    openedBy: row.opened_by_name || "—",
    closedBy: row.closed_by_name || "—",
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    printedAt: row.printed_at,
    durationMinutes: row.closed_at
      ? Math.max(0, Math.round((new Date(row.closed_at) - new Date(row.opened_at)) / 60000))
      : Math.max(0, Math.round((Date.now() - new Date(row.opened_at)) / 60000)),
    salesTotal: Number(row.sales_total),
    cashTotal: Number(row.cash_total),
    cashWalletTotal: Number(row.cash_wallet_total),
    visaTotal: Number(row.visa_total),
    expensesTotal: Number(row.expenses_total),
    cancelledTotal: Number(row.cancelled_total),
    openingCashTotal: Number(row.opening_cash_total),
    cashExpensesTotal: Number(row.cash_expenses_total),
    netTotal: Number(row.net_total),
  })) });
}));

app.get("/api/shifts/active", requireUser, asyncRoute(async (req, res) => {
  if (req.user.role !== "cashier") fail(403, "تسجيل عهدة الدرج متاح لحساب الكاشير فقط.");
  const current = await getCurrentShiftRow() || await ensureActiveShift();
  const entry = await pool.query(
    "SELECT amount FROM shift_cash_float_entries WHERE shift_id = $1 AND cashier_id = $2",
    [current.id, req.user.id]
  );
  res.json({
    shift: { id: Number(current.id), openedAt: current.opened_at },
    openingCash: entry.rowCount ? Number(entry.rows[0].amount) : null,
  });
}));

app.post("/api/shifts/opening-cash", requireUser, asyncRoute(async (req, res) => {
  if (req.user.role !== "cashier") fail(403, "تسجيل عهدة الدرج متاح لحساب الكاشير فقط.");
  const amount = numberValue(req.body.amount, "عهدة الدرج", { min: 0, max: 10000000 });
  const current = await getCurrentShiftRow() || await ensureActiveShift();
  const entry = await pool.query(
    `INSERT INTO shift_cash_float_entries (shift_id, cashier_id, amount)
     VALUES ($1, $2, $3)
     ON CONFLICT (shift_id, cashier_id)
     DO UPDATE SET amount = EXCLUDED.amount, entered_at = NOW()
     RETURNING amount`,
    [current.id, req.user.id, amount]
  );
  res.json({ shiftId: Number(current.id), openingCash: Number(entry.rows[0].amount) });
}));

app.get("/api/shifts/current", requireUser, requireAdmin, asyncRoute(async (_req, res) => {
  const current = await getCurrentShiftRow() || await ensureActiveShift();
  const summary = await summarizeShiftRange(current.opened_at, current.id, new Date());
  res.json({ shift: {
    id: Number(current.id),
    openedAt: current.opened_at,
    closedAt: current.closed_at,
    active: current.closed_at === null,
    ...summary,
  } });
}));

app.post("/api/shifts/close", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const closedShift = await inTransaction(async (client) => {
    const activeShiftResult = await client.query(
      "SELECT * FROM shifts WHERE closed_at IS NULL ORDER BY opened_at DESC LIMIT 1 FOR UPDATE"
    );
    if (!activeShiftResult.rowCount) fail(404, "لا توجد وردية نشطة حاليًا.");
    const current = activeShiftResult.rows[0];
    const summary = await summarizeShiftRange(current.opened_at, current.id, new Date(), client);
    const update = await client.query(
      `UPDATE shifts
       SET closed_by = $1, closed_at = NOW(), sales_total = $2, cash_total = $3,
          cash_wallet_total = $4, visa_total = $5, expenses_total = $6, cancelled_total = $7,
          opening_cash_total = $8, cash_expenses_total = $9, net_total = $10
      WHERE id = $11 AND closed_at IS NULL RETURNING *`,
      [req.user.id, summary.salesTotal, summary.cashTotal, summary.cashWalletTotal, summary.visaTotal,
       summary.expensesTotal, summary.cancelledTotal, summary.openingCashTotal, summary.cashExpensesTotal,
       summary.netTotal, current.id]
    );
    if (!update.rowCount) fail(409, "الوردية الحالية كانت مغلقة بالفعل.");
    const next = await client.query(
      "INSERT INTO shifts (opened_by, opened_at) VALUES ($1, NOW()) RETURNING *",
      [req.user.id]
    );
    return { closed: update.rows[0], next: next.rows[0], summary };
  });
  res.json({
    shift: {
      id: Number(closedShift.closed.id),
      openedAt: closedShift.closed.opened_at,
      closedAt: closedShift.closed.closed_at,
      active: false,
      ...closedShift.summary,
    },
    newShift: {
      id: Number(closedShift.next.id),
      openedAt: closedShift.next.opened_at,
      active: true,
    },
  });
}));

const printingShiftIds = new Set();
app.post("/api/shifts/:id/print", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const shiftId = numberValue(req.params.id, "رقم الوردية", { min: 1, integer: true });
  if (printingShiftIds.has(shiftId)) fail(409, "تجري طباعة ملخص هذه الوردية بالفعل.");
  const encodedPdf = typeof req.body.pdfData === "string" &&
    req.body.pdfData.match(/^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/)?.[1];
  if (!encodedPdf || encodedPdf.length > 11_000_000) fail(400, "ملف ملخص الوردية غير صالح أو يتجاوز الحجم المسموح.");
  const pdfBuffer = Buffer.from(encodedPdf, "base64");
  if (pdfBuffer.length < 5 || pdfBuffer.length > 8 * 1024 * 1024 || pdfBuffer.subarray(0, 5).toString() !== "%PDF-") {
    fail(400, "تعذر التحقق من ملف ملخص الوردية.");
  }

  printingShiftIds.add(shiftId);
  let temporaryDirectory = "";
  try {
    if (process.platform !== "win32") fail(501, "الإرسال المباشر للطابعات المحددة متاح حاليًا على Windows فقط.");
    const config = await loadRestaurantConfig();
    const printerJobs = [
      { label: "طابعة الكاشير", name: config.printer.cashierPrinter },
      ...(config.printer.secondPrinterEnabled
        ? [{ label: "الطابعة الثانية", name: config.printer.secondPrinter }]
        : []),
    ];
    if (!printerJobs[0].name) fail(400, "حدد طابعة الكاشير من صفحة الإعدادات قبل طباعة ملخص الوردية.");
    await validateInstalledPrinters(config.printer);

    const existing = await pool.query("SELECT closed_at, printed_at FROM shifts WHERE id = $1", [shiftId]);
    if (!existing.rowCount) fail(404, "الوردية غير موجودة.");
    if (!existing.rows[0].closed_at) fail(409, "لا يمكن طباعة ملخص وردية لم يتم إنهاؤها.");
    if (existing.rows[0].printed_at) fail(409, "تمت طباعة ملخص هذه الوردية من قبل.");

    await mkdir(PRINT_JOBS_DIR, { recursive: true });
    temporaryDirectory = await mkdtemp(path.join(PRINT_JOBS_DIR, "shift-job-"));
    const pdfPath = path.join(temporaryDirectory, "shift-summary.pdf");
    await writeFile(pdfPath, pdfBuffer, { flag: "wx" });
    const outcomes = await Promise.allSettled(printerJobs.map(({ name }) => printPdf(pdfPath, {
      printer: name,
      silent: true,
      scale: "fit",
    })));
    const failures = outcomes.flatMap((outcome, index) =>
      outcome.status === "rejected" ? [{ ...printerJobs[index], error: outcome.reason }] : []
    );
    if (failures.length) {
      failures.forEach((failure) => console.error(`تعذرت طباعة ملخص الوردية ${shiftId} على ${failure.name}:`, failure.error));
      const failedNames = failures.map((failure) => failure.label).join(" و");
      const successfulNames = outcomes.flatMap((outcome, index) =>
        outcome.status === "fulfilled" ? [printerJobs[index].label] : []
      );
      const partialMessage = successfulNames.length
        ? ` أُرسل الملخص بالفعل إلى ${successfulNames.join(" و")}؛ قد يؤدي تكرار الطباعة إلى نسخة إضافية هناك.`
        : "";
      fail(502, `أُغلقت الوردية لكن تعذرت طباعة الملخص على ${failedNames}. تحقق من الطابعة ثم أعد المحاولة من سجل الورديات.${partialMessage}`);
    }

    const marked = await pool.query(
      "UPDATE shifts SET printed_at = NOW() WHERE id = $1 AND printed_at IS NULL RETURNING printed_at",
      [shiftId]
    );
    if (!marked.rowCount) fail(409, "أُرسل الملخص للطباعة لكن تعذر تحديث حالة الطباعة؛ تحقق من سجل الوردية.");
    res.json({ shiftId, printedAt: marked.rows[0].printed_at, printers: printerJobs.map(({ name }) => name) });
  } finally {
    printingShiftIds.delete(shiftId);
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}));

app.post("/api/expenses", requireUser, requirePage("expenses"), asyncRoute(async (req, res) => {
  const name = trimText(req.body.name, 100, "اسم المصروف");
  const category = req.body.category === undefined ? "أخرى" : trimText(req.body.category, 40, "التصنيف");
  const payment = req.body.payment === undefined ? "نقدي" : trimText(req.body.payment, 30, "طريقة الدفع");
  const note = trimText(req.body.note ?? "", 240, "الملاحظات", { required: false });
  const amount = numberValue(req.body.amount, "المبلغ", { min: 0.01 });
  const activeShift = await getCurrentShiftRow() || await ensureActiveShift();
  const result = await pool.query(
    `INSERT INTO expenses (name, category, amount, payment, note, created_by, shift_id, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     RETURNING id, name, category, amount, payment, note, created_at`,
    [name, category, amount, payment, note, req.user.id, activeShift.id]
  );
  const row = result.rows[0];
  res.status(201).json({ expense: {
    id: Number(row.id), name: row.name, category: row.category, amount: Number(row.amount),
    payment: row.payment, note: row.note, createdAt: row.created_at, createdBy: req.user.username,
  } });
}));

app.delete("/api/expenses/:id", requireUser, requireAdmin, asyncRoute(async (req, res) => {
  const id = numberValue(req.params.id, "المصروف", { min: 1, integer: true });
  const result = await pool.query("DELETE FROM expenses WHERE id=$1 RETURNING id", [id]);
  if (!result.rowCount) fail(404, "المصروف غير موجود.");
  res.json({ ok: true });
}));

app.get("/api/reports", requireUser, requirePage("reports"), asyncRoute(async (req, res) => {
  const period = req.query.period || "today";
  if (!["today", "week", "month", "all"].includes(period)) fail(400, "الفترة المحددة غير صالحة.");
  const periodDays = period === "today" ? 0 : period === "week" ? 6 : period === "month" ? 29 : null;
  const since = periodDays === null ? null : new Date(Date.now() - periodDays * 86400000).toISOString();
  const params = since ? [since] : [];
  const condition = since ? "AND created_at >= $1::timestamptz" : "";
  const cancelledCondition = since ? "AND cancelled_at >= $1::timestamptz" : "";
  const [salesResult, cancelledResult, expenseResult, typesResult, dailyResult, productSalesResult, productCategoriesResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*) FILTER (WHERE status <> 'ملغي')::int AS order_count,
              COALESCE(SUM(total),0) AS sales
       FROM orders WHERE TRUE ${condition}`,
      params
    ),
    pool.query(
      `SELECT COALESCE(SUM(total),0) AS cancelled_total
       FROM orders WHERE status = 'ملغي' ${cancelledCondition}`,
      params
    ),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS expenses FROM expenses WHERE TRUE ${condition}`, params),
    pool.query(
      `SELECT order_type, COUNT(*)::int AS count FROM orders
       WHERE status <> 'ملغي' ${condition} GROUP BY order_type`,
      params
    ),
    pool.query(
      `SELECT created_at::date AS day, COALESCE(SUM(total),0) AS sales
       FROM orders WHERE status <> 'ملغي' AND created_at >= NOW() - INTERVAL '6 days'
       GROUP BY created_at::date ORDER BY day`
    ),
    pool.query(
      `SELECT oi.product_name, COALESCE(p.category, 'غير مصنف') AS category,
              SUM(oi.quantity)::int AS quantity
       FROM order_items oi
       JOIN orders o ON o.id = oi.order_id
       LEFT JOIN products p ON p.id = oi.product_id
       WHERE o.status <> 'ملغي' ${since ? "AND o.created_at >= $1::timestamptz" : ""}
       GROUP BY oi.product_name, COALESCE(p.category, 'غير مصنف')`,
      params
    ),
    pool.query("SELECT name FROM product_categories ORDER BY name"),
  ]);
  const typeCounts = { takeaway: 0, delivery: 0, reservation: 0 };
  for (const row of typesResult.rows) typeCounts[row.order_type] = Number(row.count);
  res.json({
    sales: Number(salesResult.rows[0].sales),
    orderCount: Number(salesResult.rows[0].order_count),
    cancelledTotal: Number(cancelledResult.rows[0].cancelled_total),
    expenses: Number(expenseResult.rows[0].expenses),
    typeCounts,
    dailySales: dailyResult.rows.map((row) => ({ date: String(row.day).slice(0, 10), sales: Number(row.sales) })),
    productSales: productSalesResult.rows.map((row) => ({
      name: row.product_name,
      category: row.category,
      quantity: Number(row.quantity),
    })),
    productCategories: productCategoriesResult.rows.map((row) => row.name),
  });
}));

app.use("/api", requireUser);
app.get("/uploads/products/:filename", requireUser, (req, res, next) => {
  if (!/^[a-f0-9-]{36}\.(?:png|jpg|webp)$/.test(req.params.filename)) return next();
  res.setHeader("Cache-Control", "private, max-age=86400");
  return res.sendFile(path.join(PRODUCT_IMAGES_DIR, req.params.filename), (error) => { if (error) next(error); });
});
app.get("/uploads/restaurant/:filename", requireUser, (req, res, next) => {
  if (!/^[a-f0-9-]{36}\.(?:png|jpg|webp)$/.test(req.params.filename)) return next();
  res.setHeader("Cache-Control", "private, max-age=86400");
  return res.sendFile(path.join(RESTAURANT_LOGOS_DIR, req.params.filename), (error) => { if (error) next(error); });
});
app.get(["/", "/index.html"], (req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, "index.html"));
});
app.get(["/styles.css", "/app.js"], (req, res, next) => {
  const name = req.path.slice(1);
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(__dirname, name), (error) => { if (error) next(error); });
});
app.get("/vendor/jspdf.umd.min.js", (_req, res, next) => {
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(path.join(__dirname, "node_modules", "jspdf", "dist", "jspdf.umd.min.js"), (error) => { if (error) next(error); });
});
app.get("/vendor/html2canvas.min.js", (_req, res, next) => {
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.sendFile(path.join(__dirname, "node_modules", "html2canvas", "dist", "html2canvas.min.js"), (error) => { if (error) next(error); });
});
app.get("/assets/:asset", (req, res, next) => {
  if (!["nourix-mark.svg", "nourix-food.svg"].includes(req.params.asset)) return next();
  res.setHeader("Cache-Control", "public, max-age=86400");
  return res.sendFile(path.join(__dirname, "assets", req.params.asset), (error) => { if (error) next(error); });
});
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  return res.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.code === "23505") return res.status(409).json({ error: "البيانات مسجلة بالفعل." });
  if (error.code === "23503") return res.status(400).json({ error: "تعذر حفظ البيانات المرتبطة." });
  console.error("API error:", error);
  const status = Number.isInteger(error.status) ? error.status : 500;
  const message = status === 501 ? error.message : status >= 500 ? "حدث خطأ في الخادم. حاول مرة أخرى." : error.message;
  return res.status(status).json({ error: message });
});

let server;
let orderLifecycleInterval;
let backupInterval;
let backupInProgress;
let pendingRestore = false;
async function start() {
  try {
    await prepareBackupDirectory();
    await restorePendingDatabaseBackup();
    pool = new Database();
    const schema = await readFile(path.join(__dirname, "schema.sql"), "utf8");
    await pool.query(schema);
    await ensureActiveShift();
    await loadRestaurantConfig();
    await advanceAssignedOrderStatuses();
    orderLifecycleInterval = setInterval(() => {
      advanceAssignedOrderStatuses().catch((error) => console.error("تعذر تحديث حالات الطلبات المسندة:", error));
    }, 15_000);
    backupInterval = setInterval(() => {
      createDatabaseBackup("auto").catch((error) => console.error("تعذر إنشاء النسخة الاحتياطية اليومية:", error));
    }, 24 * 60 * 60 * 1000);
    const recentAutomaticBackup = (await listDatabaseBackups())
      .find((backup) => backup.automatic && Date.now() - new Date(backup.createdAt).getTime() < 24 * 60 * 60 * 1000);
    if (!recentAutomaticBackup) {
      createDatabaseBackup("auto").catch((error) => console.error("تعذر إنشاء النسخة الاحتياطية التلقائية:", error));
    }
    server = app.listen(PORT, "127.0.0.1");
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    console.log(`Nourix POS يعمل على http://localhost:${PORT}`);
    return server;
  } catch (error) {
    console.error("تعذر تشغيل قاعدة البيانات المحلية:", error);
    if (server?.listening) {
      await new Promise((resolve) => server.close(resolve));
    }
    if (pool) {
      try {
        await pool.end();
      } catch (cleanupError) {
        console.error("تعذر إغلاق قاعدة البيانات بعد فشل بدء التشغيل:", cleanupError);
      }
      pool = null;
    }
    server = null;
    throw error;
  }
}

async function shutdown() {
  clearInterval(orderLifecycleInterval);
  clearInterval(backupInterval);
  if (backupInProgress) await backupInProgress;
  if (!server) {
    if (pool) await pool.end();
    return;
  }
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error("تعذر بدء التطبيق:", error);
    process.exitCode = 1;
  });
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { start, shutdown };
