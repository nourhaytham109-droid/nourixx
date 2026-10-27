const ORDER_TYPES = { takeaway: "تيك أوي", delivery: "دليفري", reservation: "حجز" };
const SIZES = { small: "صغير", medium: "وسط", large: "كبير" };
const PAYMENT_METHODS = { cash: "نقدي", cash_wallet: "محفظة كاش", visa: "فيزا" };
const DELIVERY_FEES = Array.from({ length: 9 }, (_, index) => 10 + index * 5);
const PAGE_LABELS = {
  pos: "نقطة البيع", orders: "الطلبات", "order-report": "تقرير الطلبات", reports: "التقارير",
  expenses: "المصاريف", menu: "المنيو", customers: "العملاء", users: "المستخدمون", drivers: "الدليفري", shifts: "الوردية", settings: "الإعدادات",
};
const DEFAULT_CASHIER_PAGES = ["pos", "orders", "order-report", "reports", "expenses", "menu", "customers"];
const normalizePhoneDigits = (value) => String(value ?? "")
  .replace(/[٠-٩۰-۹]/g, (digit) => String(digit.charCodeAt(0) - (digit.charCodeAt(0) >= 0x6f0 ? 0x6f0 : 0x660)))
  .replace(/\D/g, "");
const state = {
  page: "pos",
  category: "الكل",
  search: "",
  orderType: "takeaway",
  cart: new Map(),
  deliveryFee: null,
  customerAddresses: [],
  addressOwnerPhone: "",
  customerLookupTimeout: null,
  customerNameAutofilled: false,
  theme: localStorage.getItem("mathaq-theme") === "dark" ? "dark" : "light",
  products: [],
  productCategories: [],
  orders: [],
  activeOrderCount: 0,
  orderReportOrders: [],
  orderReportRange: { from: "", to: "" },
  expenses: [],
  archivedExpenses: [],
  drivers: [],
  activeDriverId: "",
  currentDriverSummary: null,
  customers: [],
  users: [],
  currentShift: null,
  reportProductSales: [],
  reportCategories: [],
  user: null,
  restaurant: null,
  submittingOrder: false,
  drafts: [{ id: 1 }],
  activeDraftId: 1,
  nextDraftId: 2,
};
const formatter = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const dateLocale = "ar-EG-u-nu-latn";
const money = (amount) => `${formatter.format(Number(amount) || 0)} ج.م`;
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const dateKey = (date = new Date()) => {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
};
const dateLabel = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(dateLocale, { day: "numeric", month: "short", year: "numeric" }).format(date);
};
const dateTimeLabel = (value) => {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(dateLocale, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(date);
};

function applyTheme(theme = state.theme) {
  state.theme = theme === "dark" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.theme === "dark" ? "#141d22" : "#f3f9fb");
  const button = document.querySelector("#theme-toggle");
  if (button) {
    const isDark = state.theme === "dark";
    button.textContent = isDark ? "☼" : "☾";
    button.title = isDark ? "تفعيل الوضع النهاري" : "تفعيل الوضع الداكن";
    button.setAttribute("aria-label", button.title);
  }

  localStorage.setItem("mathaq-theme", state.theme);
}

function openCancelOrder(orderNumber) {
  const form = document.querySelector("#cancel-order-form");
  form.reset();
  form.elements.orderNumber.value = orderNumber;
  document.querySelector("#cancel-order-number").textContent = `طلب رقم ${displayOrderNumber(orderNumber)}`;
  document.querySelector("#cancel-order-modal").classList.remove("hidden");
  form.elements.reason.focus();
}

async function cancelOrder(orderNumber, reason) {
  await api(`/orders/${encodeURIComponent(orderNumber)}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status: "ملغي", reason }),
  });
  await refreshCurrentOrderPage();
  showToast(`تم إلغاء الطلب ${displayOrderNumber(orderNumber)}`);
}

async function renderSettings() {
  const result = await api("/settings");
  const form = document.querySelector("#settings-form");
  const settings = result.settings;
  form.elements.restaurantName.value = settings.restaurantName;
  form.elements.phone1.value = settings.phone1;
  form.elements.phone2.value = settings.phone2;
  form.elements.address.value = settings.address || "";
  form.elements.paperWidthMm.value = String(settings.printer.paperWidthMm);
  form.elements.cashierPrinter.value = settings.printer.cashierPrinter || "";
  form.elements.secondPrinter.value = settings.printer.secondPrinter || "";
  form.elements.secondPrinterEnabled.checked = Boolean(settings.printer.secondPrinterEnabled);
  form.elements.secondPrinter.disabled = !form.elements.secondPrinterEnabled.checked;
  form.elements.logo.value = "";
  form.elements.removeLogo.checked = false;
  form.elements.removeLogo.closest("label").classList.toggle("hidden", !settings.logoUrl);
  updateRestaurantLogoPreview(form, settings.logoUrl || "");
  await refreshSystemPrinters(settings.printer);
  await renderBackups();
}

async function renderBackups() {
  const result = await api("/backups");
  const list = document.querySelector("#backup-list");
  const empty = document.querySelector("#backups-empty");
  list.innerHTML = result.backups.map((backup) => `
    <article class="backup-row">
      <div><strong>${backup.automatic ? "نسخة تلقائية" : "نسخة يدوية"} · ${dateTimeLabel(backup.createdAt)}</strong>
        <small>${formatter.format(Math.ceil(backup.size / 1024))} كيلوبايت</small></div>
      <div class="backup-row-actions">
        <a class="secondary-button" href="/api/backups/${encodeURIComponent(backup.filename)}" download>تنزيل</a>
        <button class="secondary-button" type="button" data-restore-backup="${escapeHtml(backup.filename)}">استعادة</button>
      </div>
    </article>`).join("");
  empty.classList.toggle("hidden", result.backups.length > 0);
}

async function submitBackupRestore(archive, label) {
  if (!window.confirm(`سيتم استبدال بيانات البرنامج ببيانات "${label}" بعد إعادة تشغيله. سيتم حفظ نسخة أمان من البيانات الحالية. هل تريد المتابعة؟`)) {
    return;
  }
  const status = document.querySelector("#backup-status");
  status.textContent = "جارٍ التحقق من النسخة وحفظ نسخة أمان...";
  try {
    const result = await api("/backups/restore", {
      method: "POST",
      body: archive,
      headers: { "Content-Type": "application/octet-stream" },
    });
    status.textContent = result.message;
    showToast("تم تجهيز الاستعادة. أعد تشغيل البرنامج لإتمامها.");
  } catch (error) {
    status.textContent = error.message;
    showToast(error.message);
  }
}

function setPrinterOptions(select, printers, selected, placeholder) {
  const missing = selected && !printers.includes(selected);
  select.innerHTML = [
    `<option value="">${escapeHtml(placeholder)}</option>`,
    ...(missing ? [`<option value="${escapeHtml(selected)}">${escapeHtml(selected)} — غير متاحة</option>`] : []),
    ...printers.map((printer) => `<option value="${escapeHtml(printer)}">${escapeHtml(printer)}</option>`),
  ].join("");
  select.value = selected || "";
}

async function refreshSystemPrinters(savedSettings = {}) {
  const form = document.querySelector("#settings-form");
  const status = document.querySelector("#printer-status");
  const cashierSelection = form.elements.cashierPrinter.value || savedSettings.cashierPrinter || "";
  const secondSelection = form.elements.secondPrinter.value || savedSettings.secondPrinter || "";
  status.textContent = "جارٍ تحميل الطابعات المثبتة على Windows...";
  try {
    const result = await api("/printers");
    setPrinterOptions(form.elements.cashierPrinter, result.printers, cashierSelection, "اختر طابعة الكاشير");
    setPrinterOptions(form.elements.secondPrinter, result.printers, secondSelection, "اختر الطابعة الثانية");
    status.textContent = result.printers.length
      ? `تم العثور على ${formatter.format(result.printers.length)} طابعة.${result.defaultPrinter ? ` الافتراضية: ${result.defaultPrinter}.` : ""}`
      : "لم يتم العثور على طابعات مثبتة. ثبّت الطابعة في Windows ثم حدّث القائمة.";
  } catch (error) {
    setPrinterOptions(form.elements.cashierPrinter, [], cashierSelection, "اختر طابعة الكاشير");
    setPrinterOptions(form.elements.secondPrinter, [], secondSelection, "اختر الطابعة الثانية");
    status.textContent = error.message;
  }
}

async function api(path, options = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: "same-origin",
      ...options,
      cache: "no-store",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
  } catch (error) {
    if (error instanceof TypeError) throw new Error("تعذر الاتصال بالخادم.");
    throw error;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("رد الخادم غير صالح.");
  }
  if (!response.ok) {
    if (response.status === 401 && state.user) showLogin("انتهت الجلسة. سجّل الدخول مرة أخرى.");
    throw new Error(payload.error || "تعذر تنفيذ الطلب.");
  }
  return payload;
}

function showToast(message) {
  const toast = document.querySelector("#toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(showToast.timeout);
  showToast.timeout = setTimeout(() => toast.classList.remove("show"), 2800);
}

function showOrderConfirmation(orderId) {
  const confirmation = document.querySelector("#order-confirmation");
  document.querySelector("#confirmed-order-number").textContent = orderNumberLabel(orderId);
  confirmation.classList.remove("hidden");
  clearTimeout(showOrderConfirmation.timeout);
  showOrderConfirmation.timeout = setTimeout(() => confirmation.classList.add("hidden"), 2000);
}

function showLogin(message = "") {
  state.user = null;
  state.currentShift = null;
  state.cart.clear();
  document.querySelector("#setup-screen").classList.add("hidden");
  document.querySelector("#app-shell").classList.add("hidden");
  document.querySelector("#login-screen").classList.remove("hidden");
  const shiftButton = document.querySelector("#finish-shift-btn");
  if (shiftButton) {
    shiftButton.classList.add("hidden");
    shiftButton.disabled = true;
    shiftButton.textContent = "انهاء الورديه";
  }
  const error = document.querySelector("#login-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function showSetup(message = "") {
  document.querySelector("#app-shell").classList.add("hidden");
  document.querySelector("#login-screen").classList.add("hidden");
  document.querySelector("#setup-screen").classList.remove("hidden");
  const error = document.querySelector("#setup-error");
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function applyRestaurant(restaurant) {
  state.restaurant = restaurant;
  const name = restaurant?.restaurantName || "Nourix";
  document.title = `${name} | إدارة المطعم`;
  document.querySelector("#brand-restaurant-name").textContent = name;
  document.querySelector(".brand[aria-label]")?.setAttribute("aria-label", `${name} - الصفحة الرئيسية`);
  const logo = document.querySelector(".brand .brand-logo-icon");
  if (logo) {
    logo.src = restaurant?.logoUrl || "/assets/nourix-mark.svg?v=2";
    logo.alt = restaurant?.logoUrl ? `شعار ${name}` : "";
  }
}

async function signIn(username, password) {
  const result = await api("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) });
  state.user = result.user;
  const restaurant = await api("/restaurant");
  applyRestaurant(restaurant.restaurant);
  document.querySelector("#setup-screen").classList.add("hidden");
  document.querySelector("#login-screen").classList.add("hidden");
  document.querySelector("#app-shell").classList.remove("hidden");
  document.querySelector("#profile-username").textContent = state.user.username;
  document.querySelector("#profile-avatar").textContent = state.user.username.slice(0, 1).toUpperCase();
  document.querySelector("#profile-role").textContent = state.user.role === "admin" ? "مدير النظام" : "كاشير";
  document.querySelectorAll(".admin-only").forEach((element) => element.classList.toggle("hidden", state.user.role !== "admin"));
  updatePageAccess();
  if (state.user.role === "admin") await fetchCurrentShift();
  renderDate();
  renderCustomerFields();
  renderCart();
  await goToPage(firstAccessiblePage());
  if (state.user.role === "cashier") await promptCashFloat();
}

async function refreshCoreData() {
  const productsPath = state.user?.role === "admin" ? "/products?all=true" : "/products";
  const [products, orderCount] = await Promise.all([api(productsPath), api("/orders/count")]);
  state.products = products.products.filter((product) => product.active);
  state.activeOrderCount = orderCount.count;
  removeUnavailableCartItems();
  renderProducts();
  renderOrderCount();
  renderCart();
}

async function refreshOrders() {
  const result = await api("/orders");
  const changed = JSON.stringify(state.orders) !== JSON.stringify(result.orders);
  state.orders = result.orders;
  state.activeOrderCount = result.orders.filter((order) => order.status !== "مكتمل" && order.status !== "ملغي").length;
  renderOrderCount();
  return changed;
}

function firstAccessiblePage() {
  return ["pos", "orders", "order-report", "reports", "expenses", "menu", "customers", "users", "drivers", "settings"]
    .find((page) => canAccessPage(page)) || "pos";
}

function canAccessPage(page) {
  return state.user?.role === "admin" || state.user?.pagePermissions?.includes(page);
}

function updatePageAccess() {
  document.querySelectorAll(".nav-item[data-page]").forEach((item) => {
    item.classList.toggle("hidden", !canAccessPage(item.dataset.page));
  });
  const shiftButton = document.querySelector("#finish-shift-btn");
  if (shiftButton) shiftButton.classList.toggle("hidden", state.user?.role !== "admin");
}

function removeUnavailableCartItems() {
  for (const [key, item] of state.cart) {
    if (!state.products.some((product) => product.id === item.productId && product.active)) state.cart.delete(key);
  }
}

function renderDate() {
  document.querySelector("#current-date").textContent = new Intl.DateTimeFormat(dateLocale, { weekday: "long", day: "numeric", month: "long" }).format(new Date());
}

async function goToPage(page) {
  if (!canAccessPage(page)) return showToast("ليس لديك صلاحية لعرض هذه الصفحة.");
  state.page = page;
  document.querySelectorAll(".page").forEach((element) => element.classList.toggle("active", element.id === `page-${page}`));
  document.querySelectorAll(".nav-item").forEach((element) => element.classList.toggle("active", element.dataset.page === page));
  const label = PAGE_LABELS[page];
  document.querySelector("#page-title").textContent = label;
  document.querySelector("#breadcrumb-current").textContent = label;
  document.querySelector("#sidebar").classList.remove("open");
  try {
    if (page === "pos") await refreshCoreData();
    if (page === "orders") {
      await refreshOrders();
      renderOrders();
    }
    if (page === "order-report") await refreshOrderReport();
    if (page === "reports") await renderReports();
    if (page === "expenses") await renderExpenses();
    if (page === "menu") await renderMenu();
    if (page === "users") await renderUsers();
    if (page === "drivers") await renderDrivers();
    if (page === "shifts") {
      if (state.user?.role === "admin") await fetchCurrentShift();
      await renderShifts();
    }
    if (page === "settings") await renderSettings();
  } catch (error) {
    showToast(error.message);
  }
}

async function fetchCurrentShift() {
  const result = await api("/shifts/current");
  state.currentShift = result.shift;
  const button = document.querySelector("#finish-shift-btn");
  if (button) {
    button.textContent = `انهاء الورديه${state.currentShift?.netTotal ? ` — ${money(state.currentShift.netTotal)}` : ""}`;
    button.disabled = !state.currentShift;
  }
  return result.shift;
}

async function renderShifts() {
  const stats = document.querySelector("#shift-summary-stats");
  if (stats) {
    const current = state.currentShift || { salesTotal: 0, cashTotal: 0, cashWalletTotal: 0, visaTotal: 0, expensesTotal: 0, netTotal: 0 };
    stats.innerHTML = `
      <div class="stat-card"><span>إجمالي المبيعات</span><strong>${money(current.salesTotal)}</strong></div>
      <div class="stat-card"><span>النقدي</span><strong>${money(current.cashTotal)}</strong></div>
      <div class="stat-card"><span>محفظة كاش</span><strong>${money(current.cashWalletTotal)}</strong></div>
      <div class="stat-card"><span>الفيزا</span><strong>${money(current.visaTotal)}</strong></div>
      <div class="stat-card"><span>المصاريف</span><strong>${money(current.expensesTotal)}</strong></div>
      <div class="stat-card"><span>الطلبات الملغاة</span><strong>${money(current.cancelledTotal)}</strong></div>
      <div class="stat-card"><span>عهدة الدرج</span><strong>${money(current.openingCashTotal)}</strong></div>
      <div class="stat-card accent"><span>صافي الوردية</span><strong>${money(current.netTotal)}</strong></div>
    `;
  }
  const table = document.querySelector("#shifts-table");
  const empty = document.querySelector("#shifts-empty");
  if (!table) return;
  try {
    const result = await api("/shifts");
    const rows = result.shifts || [];
    table.innerHTML = rows.map((shift) => `
      <tr>
        <td>${dateTimeLabel(shift.openedAt)}</td>
        <td>${shift.closedAt ? dateTimeLabel(shift.closedAt) : "-"}</td>
        <td>${money(shift.salesTotal)}</td>
        <td>${money(shift.cashTotal)}</td>
        <td>${money(shift.cashWalletTotal)}</td>
        <td>${money(shift.visaTotal)}</td>
        <td>${money(shift.expensesTotal)}</td>
        <td>${money(shift.cancelledTotal)}</td>
        <td>${money(shift.openingCashTotal)}</td>
        <td>${money(shift.netTotal)}</td>
        <td>${escapeHtml(shift.openedBy)} / ${escapeHtml(shift.closedBy || "—")}</td>
        <td>${shift.closedAt ? shift.printedAt ? "تمت الطباعة" : `<button class="secondary-button" type="button" data-print-shift="${shift.id}">طباعة الملخص</button>` : "وردية نشطة"}</td>
      </tr>`).join("");
    empty.classList.toggle("hidden", rows.length > 0);
  } catch (error) {
    table.innerHTML = "";
    empty.classList.remove("hidden");
    empty.textContent = error.message;
  }
}

function shiftReceiptDocument(shift, paperWidthMm) {
  const restaurant = state.restaurant || {};
  const name = restaurant.restaurantName || "Nourix";
  const phones = [restaurant.phone1, restaurant.phone2].filter(Boolean);
  const logo = restaurant.logoUrl || "";
  const address = restaurant.address || "";
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><base href="${escapeHtml(location.origin)}/"><style>
    *{box-sizing:border-box}html,body{width:${paperWidthMm}mm;margin:0;padding:0;background:#fff;color:#202820;font:14px Arial,sans-serif}.receipt{width:${paperWidthMm - 6}mm;margin:3mm auto}.brand{text-align:center;border-bottom:1px dashed #9aa39a;padding-bottom:10px}.brand img{display:block;max-width:35mm;max-height:22mm;margin:0 auto 6px;object-fit:contain}.brand h1{font-size:20px;margin:3px 0}.brand p{margin:3px 0;color:#657065}.title{text-align:center;font-size:17px;font-weight:bold;margin:12px 0}.meta{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px 0;border-bottom:1px dashed #9aa39a}.meta div{display:grid;gap:4px}.meta span{color:#737b73;font-size:11px}.row{display:flex;justify-content:space-between;gap:8px;padding:7px 2px;border-bottom:1px solid #e5e8e4}.total{font-weight:bold;font-size:17px;border-top:1px dashed #9aa39a;margin-top:8px;padding-top:10px}.due{margin-top:12px;padding:10px;border:1px solid #9aa39a;border-radius:6px;font-size:18px;font-weight:bold;text-align:center}.footer{text-align:center;margin-top:14px;color:#737b73;font-size:11px}
  </style></head><body><main class="receipt">
    <header class="brand">${logo ? `<img src="${escapeHtml(logo)}" alt="شعار ${escapeHtml(name)}" />` : ""}<h1>${escapeHtml(name)}</h1>${phones.map((phone) => `<p dir="ltr">${escapeHtml(phone)}</p>`).join("")}${address ? `<p>${escapeHtml(address)}</p>` : ""}</header>
    <div class="title">ملخص إقفال الوردية</div>
    <section class="meta"><div><span>رقم الوردية</span><strong>${formatter.format(shift.id)}</strong></div><div><span>مدة الوردية</span><strong>${formatter.format(shift.durationMinutes || 0)} دقيقة</strong></div><div><span>بداية الوردية</span><strong>${dateTimeLabel(shift.startedAt || shift.openedAt)}</strong></div><div><span>نهاية الوردية</span><strong>${dateTimeLabel(shift.endedAt || shift.closedAt)}</strong></div><div><span>طُبع في</span><strong>${dateTimeLabel(new Date().toISOString())}</strong></div></section>
    <div class="row"><span>إجمالي المبيعات</span><strong>${money(shift.salesTotal)}</strong></div>
    <div class="row"><span>نقدي</span><strong>${money(shift.cashTotal)}</strong></div>
    <div class="row"><span>محفظة كاش</span><strong>${money(shift.cashWalletTotal)}</strong></div>
    <div class="row"><span>فيزا</span><strong>${money(shift.visaTotal)}</strong></div>
    <div class="row"><span>إجمالي المصاريف</span><strong>${money(shift.expensesTotal)}</strong></div>
    <div class="row"><span>إجمالي الطلبات الملغاة</span><strong>${money(shift.cancelledTotal)}</strong></div>
    <div class="row"><span>عهدة الدرج</span><strong>${money(shift.openingCashTotal)}</strong></div>
    <div class="due">صافي الوردية: ${money(shift.netTotal)}</div>
    <footer class="footer">تم حفظ ملخص الوردية في سجل الورديات</footer></main></body></html>`;
}

async function createShiftSummaryPdf(shift) {
  if (!window.html2canvas || !window.jspdf?.jsPDF) {
    throw new Error("تعذر تحميل مكوّنات إعداد طباعة ملخص الوردية. أعد تحميل البرنامج.");
  }
  const paperWidthMm = state.restaurant?.printer?.paperWidthMm || 80;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${paperWidthMm}mm;height:100vh;border:0;background:#fff;`;
  const frameLoaded = new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener("error", () => reject(new Error("تعذر تجهيز ملخص الوردية للطباعة.")), { once: true });
  });
  frame.srcdoc = shiftReceiptDocument(shift, paperWidthMm);
  document.body.append(frame);
  try {
    await frameLoaded;
    const receipt = frame.contentDocument.querySelector(".receipt");
    if (!receipt) throw new Error("تعذر تجهيز محتوى ملخص الوردية.");
    await Promise.all([...frame.contentDocument.images].map((image) => image.decode()));
    await frame.contentDocument.fonts.ready;
    const widthPx = frame.contentWindow.innerWidth;
    const receiptHeightMm = receipt.getBoundingClientRect().height / widthPx * paperWidthMm;
    if (!Number.isFinite(receiptHeightMm) || receiptHeightMm <= 0 || receiptHeightMm > 4000) {
      throw new Error("حجم ملخص الوردية غير صالح للطباعة.");
    }
    const canvas = await window.html2canvas(receipt, {
      backgroundColor: "#ffffff",
      logging: false,
      scale: 2,
      useCORS: true,
    });
    const pdf = new window.jspdf.jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: [paperWidthMm, receiptHeightMm + 6],
      compress: true,
    });
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.94), "JPEG", 3, 3, paperWidthMm - 6, receiptHeightMm);
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
      reader.addEventListener("error", () => reject(new Error("تعذر إنشاء ملف ملخص الوردية.")), { once: true });
      reader.readAsDataURL(pdf.output("blob"));
    });
  } finally {
    frame.remove();
  }
}

async function printShiftSummary(shift) {
  const pdfData = await createShiftSummaryPdf(shift);
  const result = await api(`/shifts/${encodeURIComponent(shift.id)}/print`, {
    method: "POST",
    body: JSON.stringify({ pdfData }),
  });
  showToast(`تم إرسال ملخص الوردية إلى ${result.printers.join(" و")}`);
}

async function promptCashFloat() {
  const result = await api("/shifts/active");
  const modal = document.querySelector("#cash-float-modal");
  const form = document.querySelector("#cash-float-form");
  const input = form.elements.amount;
  const hint = document.querySelector("#cash-float-hint");
  const error = document.querySelector("#cash-float-error");
  input.value = result.openingCash === null ? "" : String(result.openingCash);
  hint.textContent = result.openingCash === null
    ? "سجّل المبلغ الموجود في درج الكاشير قبل بدء البيع."
    : `العهدة المسجلة لهذه الوردية ${money(result.openingCash)}. يمكنك تعديلها الآن.`;
  error.textContent = "";
  error.classList.add("hidden");
  modal.classList.remove("hidden");
  input.focus();
  await new Promise((resolve) => {
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      error.textContent = "";
      error.classList.add("hidden");
      try {
        await api("/shifts/opening-cash", {
          method: "POST",
          body: JSON.stringify({ amount: Number(input.value) }),
        });
        modal.classList.add("hidden");
        form.onsubmit = null;
        resolve();
      } catch (requestError) {
        error.textContent = requestError.message;
        error.classList.remove("hidden");
      } finally {
        button.disabled = false;
      }
    };
  });
}

async function finishShift() {
  try {
    const summary = await fetchCurrentShift();
    const message = [
      "ملخص الورديه:",
      `إجمالي المبيعات: ${money(summary.salesTotal)}`,
      `النقدي: ${money(summary.cashTotal)}`,
      `محفظة كاش: ${money(summary.cashWalletTotal)}`,
      `الفيزا: ${money(summary.visaTotal)}`,
      `المصاريف: ${money(summary.expensesTotal)}`,
      `إجمالي الطلبات الملغاة: ${money(summary.cancelledTotal)}`,
      `عهدة الدرج: ${money(summary.openingCashTotal)}`,
      `صافي الوردية: ${money(summary.netTotal)}`,
    ].join("\n");
    const confirmed = window.confirm(`${message}\n\nهل تريد إنهاء الورديه وتسجيل بداية ورودية جديدة؟`);
    if (!confirmed) return;
    const result = await api("/shifts/close", { method: "POST" });
    state.currentShift = result.shift;
    await fetchCurrentShift();
    try {
      await printShiftSummary(result.shift);
      showToast(`تم إنهاء الوردية وطباعة الملخص. صافي الوردية: ${money(result.shift.netTotal)}`);
    } catch (printError) {
      showToast(`تم إنهاء الوردية، لكن تعذرت طباعة الملخص: ${printError.message}`);
    }
    if (state.page === "shifts") await renderShifts();
  } catch (error) {
    showToast(error.message);
  }
}

document.querySelector("#shifts-table").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-print-shift]");
  if (!button) return;
  button.disabled = true;
  try {
    const result = await api("/shifts");
    const shift = result.shifts.find((entry) => entry.id === Number(button.dataset.printShift));
    if (!shift) throw new Error("الوردية غير موجودة في السجل.");
    const printData = {
      ...shift,
      startedAt: shift.openedAt,
      endedAt: shift.closedAt,
    };
    await printShiftSummary(printData);
    await renderShifts();
  } catch (error) {
    showToast(error.message);
    button.disabled = false;
  }
});

function renderProducts() {
  const categories = ["الكل", ...new Set(state.products.map((product) => product.category))];
  if (!categories.includes(state.category)) state.category = "الكل";
  document.querySelector("#categories").innerHTML = categories.map((category) =>
    `<button class="category-button ${state.category === category ? "active" : ""}" data-category="${escapeHtml(category)}">${escapeHtml(category)}</button>`
  ).join("");
  const visibleProducts = state.products.filter((product) =>
    product.active &&
    (state.category === "الكل" || product.category === state.category) &&
    `${product.name} ${product.description}`.toLocaleLowerCase().includes(state.search.trim().toLocaleLowerCase())
  );
  document.querySelector("#product-grid").innerHTML = visibleProducts.length ? visibleProducts.map((product) => `
    <article class="product-card">
      <div class="product-image">${product.imageUrl ? `<img src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy" />` : `<span class="product-image-placeholder">لا توجد صورة</span>`}</div>
      <div class="product-info">
        <h3>${escapeHtml(product.name)}</h3><div class="product-description">${escapeHtml(product.description)}</div>
        <div class="size-options">${Object.entries(SIZES).map(([size, label]) => `
          <button class="size-option" data-select-size="${product.id}" data-size="${size}" aria-label="إضافة ${escapeHtml(product.name)} حجم ${label}">
            <span>${label}</span><strong>${money(product.sizePrices?.[size] ?? product.price)}</strong>
          </button>`).join("")}
        </div>
      </div>
    </article>`).join("") : `<div class="no-products">مفيش أصناف مطابقة للبحث.</div>`;
}

function renderCustomerFields() {
  const container = document.querySelector("#customer-fields");
  const nameRequired = state.orderType !== "takeaway";
  const phoneRequired = state.orderType !== "takeaway";
  const extra = state.orderType === "delivery" ? `
    <div class="delivery-address-fields">
      <label>العناوين المسجلة
        <select id="saved-customer-address" aria-label="العناوين المسجلة">
          <option value="">اختر عنوانًا مسجلًا</option>
        </select>
      </label>
      <label>إضافة عنوان جديد *
        <input id="customer-address" maxlength="240" placeholder="اكتب عنوانًا جديدًا للتوصيل" aria-label="إضافة عنوان جديد" required autocomplete="street-address">
      </label>
    </div>
    <small class="saved-address-hint" id="saved-address-hint">اكتب رقم العميل لعرض عناوينه المحفوظة ورسومها.</small>
    <label>سعر التوصيل
      <select id="delivery-fee-select" aria-label="سعر التوصيل">
        <option value="">اختر سعر التوصيل</option>
        ${DELIVERY_FEES.map((fee) => `<option value="${fee}">${formatter.format(fee)} ج.م</option>`).join("")}
        <option value="custom">سعر مخصص</option>
      </select>
    </label>
    <input id="delivery-fee-custom" class="hidden" type="number" min="0" max="1000000" step="0.01" aria-label="سعر توصيل مخصص" placeholder="اكتب سعر التوصيل بالجنيه" value="${state.deliveryFee !== null && !DELIVERY_FEES.includes(state.deliveryFee) ? state.deliveryFee : ""}">` : "";
  container.innerHTML = `
    <input id="customer-name" maxlength="100" placeholder="اسم العميل${nameRequired ? " *" : " (اختياري)"}" aria-label="اسم العميل" ${nameRequired ? "required" : ""}>
    <input id="customer-phone" type="tel" maxlength="30" placeholder="رقم الهاتف${phoneRequired ? " *" : " (اختياري)"}" aria-label="رقم الهاتف" ${phoneRequired ? "required" : ""}>
    <small class="customer-lookup-hint">الاسم والعناوين المسجلة تظهر تلقائيًا بعد كتابة الرقم.</small>
    ${extra}`;
  const phoneInput = document.querySelector("#customer-phone");
  const nameInput = document.querySelector("#customer-name");
  phoneInput.addEventListener("blur", lookupOrderCustomer);
  nameInput.addEventListener("input", () => { state.customerNameAutofilled = false; });
  phoneInput.addEventListener("input", () => {
    clearTimeout(state.customerLookupTimeout);
    if (state.customerNameAutofilled) {
      nameInput.value = "";
      state.customerNameAutofilled = false;
    }
    state.customerAddresses = [];
    state.addressOwnerPhone = "";
    const savedAddressSelect = document.querySelector("#saved-customer-address");
    if (savedAddressSelect) savedAddressSelect.innerHTML = `<option value="">اكتب رقم العميل لعرض عناوينه</option>`;
    const address = document.querySelector("#customer-address");
    if (address) {
      address.value = "";
      address.required = true;
      clearDeliveryFee();
    }
    const savedAddressHint = document.querySelector("#saved-address-hint");
    if (savedAddressHint) savedAddressHint.textContent = "اكتب رقم العميل لعرض عناوينه المحفوظة ورسومها.";
    if (normalizePhoneDigits(phoneInput.value).length >= 7) {
      state.customerLookupTimeout = setTimeout(() => { void lookupOrderCustomer(); }, 350);
    }
  });
  const savedAddressSelect = document.querySelector("#saved-customer-address");
  savedAddressSelect?.addEventListener("change", () => {
    const saved = state.customerAddresses.find((entry) => entry.address === savedAddressSelect.value);
    const newAddressInput = document.querySelector("#customer-address");
    newAddressInput.required = !saved;
    if (!saved) return;
    newAddressInput.value = "";
    setDeliveryFee(saved.deliveryFee);
  });
  const address = document.querySelector("#customer-address");
  address?.addEventListener("input", () => {
    if (savedAddressSelect) savedAddressSelect.value = "";
    address.required = true;
    clearDeliveryFee();
  });
  const feeSelect = document.querySelector("#delivery-fee-select");
  feeSelect?.addEventListener("change", () => {
    const custom = feeSelect.value === "custom";
    const customInput = document.querySelector("#delivery-fee-custom");
    customInput.classList.toggle("hidden", !custom);
    customInput.required = custom;
    if (!feeSelect.value) {
      state.deliveryFee = null;
      customInput.value = "";
    } else if (custom) {
      customInput.value = state.deliveryFee !== null && !DELIVERY_FEES.includes(state.deliveryFee) ? String(state.deliveryFee) : "";
      customInput.focus();
      if (!customInput.value) state.deliveryFee = null;
    } else {
      state.deliveryFee = Number(feeSelect.value);
    }
    renderCart();
  });
  document.querySelector("#delivery-fee-custom")?.addEventListener("input", (event) => {
    state.deliveryFee = Number(event.target.value) || 0;
    renderCart();
  });
  if (state.orderType === "delivery" && state.deliveryFee !== null) setDeliveryFee(state.deliveryFee);
}

function capturePosDraft() {
  const existing = state.drafts.find((draft) => draft.id === state.activeDraftId) || {};
  const customerName = document.querySelector("#customer-name");
  const customerPhone = document.querySelector("#customer-phone");
  const address = document.querySelector("#customer-address");
  const savedAddress = document.querySelector("#saved-customer-address");
  const feeSelect = document.querySelector("#delivery-fee-select");
  const customFee = document.querySelector("#delivery-fee-custom");
  return {
    ...existing,
    id: state.activeDraftId,
    cart: new Map(state.cart),
    orderType: state.orderType,
    deliveryFee: state.deliveryFee,
    customerAddresses: [...state.customerAddresses],
    addressOwnerPhone: state.addressOwnerPhone,
    customerNameAutofilled: state.customerNameAutofilled,
    customerName: customerName?.value || "",
    customerPhone: customerPhone?.value || "",
    address: address?.value || "",
    savedAddress: savedAddress?.value || "",
    feeSelect: feeSelect?.value ?? (state.deliveryFee === null ? "" : String(state.deliveryFee)),
    customFee: customFee?.value || "",
    paymentMethod: document.querySelector("#payment-method").value,
    note: document.querySelector("#order-note").value,
  };
}

function restorePosDraft(draft) {
  state.activeDraftId = draft.id;
  state.cart = new Map(draft.cart || []);
  state.orderType = draft.orderType || "takeaway";
  state.deliveryFee = draft.deliveryFee ?? null;
  state.customerAddresses = [...(draft.customerAddresses || [])];
  state.addressOwnerPhone = draft.addressOwnerPhone || "";
  state.customerNameAutofilled = Boolean(draft.customerNameAutofilled);
  clearTimeout(state.customerLookupTimeout);
  document.querySelectorAll(".order-type").forEach((button) => {
    button.classList.toggle("active", button.dataset.type === state.orderType);
  });
  renderCustomerFields();
  document.querySelector("#customer-name").value = draft.customerName || "";
  document.querySelector("#customer-phone").value = draft.customerPhone || "";
  const address = document.querySelector("#customer-address");
  if (address) address.value = draft.address || "";
  const savedAddress = document.querySelector("#saved-customer-address");
  if (savedAddress) {
    savedAddress.innerHTML = `<option value="">اختر عنوانًا مسجلًا</option>${state.customerAddresses.map((entry) =>
      `<option value="${escapeHtml(entry.address)}">${escapeHtml(entry.address)} — توصيل ${money(entry.deliveryFee)}</option>`
    ).join("")}`;
    savedAddress.value = draft.savedAddress || "";
    if (address) address.required = !savedAddress.value;
  }
  const feeSelect = document.querySelector("#delivery-fee-select");
  const customFee = document.querySelector("#delivery-fee-custom");
  if (feeSelect && customFee) {
    feeSelect.value = draft.feeSelect ?? (state.deliveryFee === null ? "" : DELIVERY_FEES.includes(state.deliveryFee) ? String(state.deliveryFee) : "custom");
    customFee.value = draft.customFee || "";
    customFee.classList.toggle("hidden", feeSelect.value !== "custom");
    customFee.required = feeSelect.value === "custom";
  }
  document.querySelector("#payment-method").value = draft.paymentMethod || "cash";
  document.querySelector("#order-note").value = draft.note || "";
  renderPosDraftTabs();
  renderCart();
}

function renderPosDraftTabs() {
  const container = document.querySelector("#pos-order-tabs");
  container.innerHTML = `${state.drafts.map((draft, index) => `
    <span class="pos-order-tab-wrap">
      <button type="button" role="tab" aria-selected="${draft.id === state.activeDraftId}" class="pos-order-tab ${draft.id === state.activeDraftId ? "active" : ""}" data-pos-draft="${draft.id}">
        طلب ${formatter.format(index + 1)}
      </button>
      ${state.drafts.length > 1 ? `<button type="button" class="pos-order-close" data-close-pos-draft="${draft.id}" aria-label="حذف طلب ${formatter.format(index + 1)}" title="حذف هذا الطلب">×</button>` : ""}
    </span>`).join("")}
    <button type="button" class="pos-order-add" id="add-pos-order" aria-label="فتح طلب جديد" title="فتح طلب جديد">＋</button>`;
}

function switchPosDraft(id) {
  const current = capturePosDraft();
  state.drafts = state.drafts.map((draft) => draft.id === current.id ? current : draft);
  const selected = state.drafts.find((draft) => draft.id === id);
  if (!selected) return;
  restorePosDraft(selected);
}

function addPosDraft() {
  const current = capturePosDraft();
  state.drafts = state.drafts.map((draft) => draft.id === current.id ? current : draft);
  const draft = { id: state.nextDraftId++, cart: new Map(), orderType: "takeaway", deliveryFee: null };
  state.drafts.push(draft);
  restorePosDraft(draft);
}

function removePosDraft(id) {
  if (state.drafts.length <= 1) return;
  const current = capturePosDraft();
  state.drafts = state.drafts.map((draft) => draft.id === current.id ? current : draft);
  const index = state.drafts.findIndex((draft) => draft.id === id);
  if (index < 0) return;
  state.drafts.splice(index, 1);
  if (state.activeDraftId === id) {
    const nextDraft = state.drafts[Math.min(index, state.drafts.length - 1)];
    restorePosDraft(nextDraft);
  } else {
    renderPosDraftTabs();
  }
}

function setDeliveryFee(fee) {
  const amount = Number(fee);
  if (!Number.isFinite(amount) || amount < 0) return;
  state.deliveryFee = amount;
  const select = document.querySelector("#delivery-fee-select");
  const custom = document.querySelector("#delivery-fee-custom");
  if (!select || !custom) return;
  const regular = DELIVERY_FEES.includes(amount);
  select.value = regular ? String(amount) : "custom";
  custom.classList.toggle("hidden", regular);
  custom.required = !regular;
  custom.value = regular ? "" : String(amount);
  renderCart();
}

function clearDeliveryFee() {
  state.deliveryFee = null;
  const select = document.querySelector("#delivery-fee-select");
  const custom = document.querySelector("#delivery-fee-custom");
  if (select) select.value = "";
  if (custom) {
    custom.value = "";
    custom.classList.add("hidden");
    custom.required = false;
  }
  renderCart();
}

async function lookupOrderCustomer() {
  clearTimeout(state.customerLookupTimeout);
  const lookupDraftId = state.activeDraftId;
  const phoneInput = document.querySelector("#customer-phone");
  const phone = normalizePhoneDigits(phoneInput?.value);
  if (phone.length < 7) return;
  try {
    const result = await api(`/customers?phone=${encodeURIComponent(phone)}&summary=true`);
    if (state.activeDraftId !== lookupDraftId || normalizePhoneDigits(phoneInput.value) !== phone) return;
    const exact = result.customers.find((customer) => normalizePhoneDigits(customer.phone) === phone);
    if (!exact) return;
    state.addressOwnerPhone = phone;
    const name = document.querySelector("#customer-name");
    if (name && !name.value) {
      name.value = exact.name;
      state.customerNameAutofilled = true;
    }
    state.customerAddresses = exact.addresses;
    const addressSelect = document.querySelector("#saved-customer-address");
    const addressHint = document.querySelector("#saved-address-hint");
    if (addressSelect) {
      addressSelect.innerHTML = `<option value="">اختر عنوانًا مسجلًا</option>${exact.addresses.map((entry) =>
        `<option value="${escapeHtml(entry.address)}">${escapeHtml(entry.address)} — توصيل ${money(entry.deliveryFee)}</option>`
      ).join("")}`;
      if (exact.addresses.length === 1 && !document.querySelector("#customer-address")?.value.trim()) {
        addressSelect.value = exact.addresses[0].address;
        setDeliveryFee(exact.addresses[0].deliveryFee);
      }
    }
    if (addressHint) addressHint.textContent = exact.addresses.length
      ? `تم العثور على ${formatter.format(exact.addresses.length)} عنوان مسجل. رسوم التوصيل تظهر بجانب كل عنوان.`
      : "لا توجد عناوين محفوظة لهذا العميل؛ اكتب عنوانًا جديدًا.";
  } catch (error) {
    showToast(error.message);
  }
}

function cartSubtotal() {
  return [...state.cart.values()].reduce((sum, item) => {
    const product = state.products.find((entry) => entry.id === item.productId);
    return sum + (product ? (product.sizePrices?.[item.size] ?? product.price) * item.quantity : 0);
  }, 0);
}

function renderCart() {
  const entries = [...state.cart.entries()].filter(([, item]) => state.products.some((product) => product.id === item.productId));
  const itemCount = entries.reduce((sum, [, item]) => sum + item.quantity, 0);
  const subtotal = cartSubtotal();
  const deliveryFee = state.orderType === "delivery" && entries.length ? state.deliveryFee : 0;
  document.querySelector("#cart-count").textContent = formatter.format(itemCount);
  document.querySelector("#cart-items").innerHTML = entries.length ? entries.map(([key, item]) => {
    const product = state.products.find((entry) => entry.id === item.productId);
    const price = product.sizePrices?.[item.size] ?? product.price;
    return `<div class="cart-item">
      ${product.imageUrl ? `<img class="cart-product-image" src="${escapeHtml(product.imageUrl)}" alt="" />` : `<span class="cart-product-placeholder" aria-hidden="true"></span>`}
      <div><div class="cart-item-name">${escapeHtml(product.name)} · ${SIZES[item.size]}</div><div class="cart-item-price">${money(price * item.quantity)}</div></div>
      <div class="quantity-control"><button data-quantity="${escapeHtml(key)}" data-change="-1" aria-label="تقليل الكمية">−</button><span>${formatter.format(item.quantity)}</span><button data-quantity="${escapeHtml(key)}" data-change="1" aria-label="زيادة الكمية" ${item.quantity >= 500 ? "disabled" : ""}>+</button></div>
    </div>`;
  }).join("") : `<div class="empty-cart"><div class="empty-icon">＋</div><strong>الطلب لسه فاضي</strong><span>اختار أصناف من القائمة وابدأ طلب جديد</span></div>`;
  document.querySelector("#subtotal").textContent = money(subtotal);
  document.querySelector("#delivery-fee").textContent = money(deliveryFee);
  document.querySelector(".delivery-row").classList.toggle("hidden", state.orderType !== "delivery");
  document.querySelector("#total").textContent = money(subtotal + deliveryFee);
  const checkoutDisabled = entries.length === 0 || state.submittingOrder;
  document.querySelector("#checkout-print-btn").disabled = checkoutDisabled;
}

function addToCart(id, size, change = 1) {
  const product = state.products.find((item) => item.id === id);
  if (!product) return;
  const key = `${id}:${size}`;
  const previous = state.cart.get(key)?.quantity || 0;
  const quantity = previous + change;
  if (quantity > 500) return showToast("الحد الأقصى للكمية في الصنف الواحد هو 500.");
  if (quantity <= 0) state.cart.delete(key);
  else state.cart.set(key, { productId: id, size, quantity });
  renderCart();
}

function resetOrderCustomerFields() {
  clearTimeout(state.customerLookupTimeout);
  state.customerAddresses = [];
  state.addressOwnerPhone = "";
  state.customerNameAutofilled = false;
  state.deliveryFee = null;
  document.querySelector("#customer-name").value = "";
  document.querySelector("#customer-phone").value = "";
  const address = document.querySelector("#customer-address");
  if (address) {
    address.value = "";
    address.required = true;
  }
  const savedAddress = document.querySelector("#saved-customer-address");
  if (savedAddress) savedAddress.innerHTML = `<option value="">اختر عنوانًا مسجلًا</option>`;
  const addressHint = document.querySelector("#saved-address-hint");
  if (addressHint) addressHint.textContent = "اكتب رقم العميل لعرض عناوينه المحفوظة ورسومها.";
  const deliveryFeeSelect = document.querySelector("#delivery-fee-select");
  if (deliveryFeeSelect) deliveryFeeSelect.value = "";
  const customDeliveryFee = document.querySelector("#delivery-fee-custom");
  if (customDeliveryFee) {
    customDeliveryFee.value = "";
    customDeliveryFee.classList.add("hidden");
    customDeliveryFee.required = false;
  }
}

async function createOrder({ printAfterCreate = false } = {}) {
  if (!state.cart.size || state.submittingOrder) return;
  const name = document.querySelector("#customer-name")?.value.trim() || "";
  const phone = document.querySelector("#customer-phone")?.value.trim() || "";
  const newAddress = document.querySelector("#customer-address")?.value.trim() || "";
  const savedAddress = document.querySelector("#saved-customer-address")?.value || "";
  const address = newAddress || savedAddress;
  const deliveryFeeInput = document.querySelector("#delivery-fee-select")?.value;
  const customDeliveryFee = document.querySelector("#delivery-fee-custom");
  const deliveryFee = state.orderType === "delivery"
    ? (deliveryFeeInput === "custom"
      ? (customDeliveryFee.value.trim() ? Number(customDeliveryFee.value) : Number.NaN)
      : (deliveryFeeInput ? Number(deliveryFeeInput) : Number.NaN))
    : 0;
  const paymentMethod = document.querySelector("#payment-method").value;
  if ((state.orderType !== "takeaway" && (!name || !phone)) ||
      (Boolean(name) !== Boolean(phone)) ||
      (state.orderType === "delivery" && !address) ||
      (state.orderType === "delivery" && (
        !Number.isFinite(deliveryFee) || deliveryFee < 0 ||
        (deliveryFeeInput === "custom" && (!customDeliveryFee.value.trim() || !customDeliveryFee.reportValidity()))
      )) ||
      !Object.hasOwn(PAYMENT_METHODS, paymentMethod)) {
    showToast(state.orderType === "delivery" && !Number.isFinite(deliveryFee)
      ? "اختر سعر التوصيل أو أدخل سعرًا مخصصًا."
      : "من فضلك أدخل كل البيانات المطلوبة للطلب.");
    return;
  }
  if (printAfterCreate && !state.restaurant?.printer?.cashierPrinter) {
    showToast("حدد طابعة الكاشير من صفحة الإعدادات قبل تأكيد الطلب وطباعته.");
    return;
  }
  state.submittingOrder = true;
  renderCart();
  try {
    const result = await api("/orders", {
      method: "POST",
      body: JSON.stringify({
        type: state.orderType,
        customerName: name,
        phone,
        address,
        deliveryFee,
        paymentMethod,
        note: document.querySelector("#order-note").value.trim(),
        items: [...state.cart.values()].map((item) => ({ productId: item.productId, size: item.size, quantity: item.quantity })),
      }),
    });
    state.cart.clear();
    resetOrderCustomerFields();
    document.querySelector("#payment-method").value = "cash";
    document.querySelector("#order-note").value = "";
    const clearedDraft = capturePosDraft();
    state.drafts = state.drafts.map((draft) => draft.id === state.activeDraftId ? clearedDraft : draft);
    showOrderConfirmation(result.order.displayNumber ?? result.order.id);
    await refreshCoreData();
    renderCart();
    renderPosDraftTabs();
    if (printAfterCreate) {
      await goToPage("orders");
      await printOrder(result.order);
    }
  } catch (error) {
    showToast(error.message);
    try {
      await refreshCoreData();
    } catch (refreshError) {
      showToast(refreshError.message);
    }
  } finally {
    state.submittingOrder = false;
    renderCart();
  }
}

function renderOrderCount() {
  document.querySelector("#nav-order-count").textContent = formatter.format(state.activeOrderCount);
}

function statusClass(status) {
  return { "جاهز": "ready", "في الطريق": "in-transit", "مكتمل": "complete", "ملغي": "cancelled" }[status] || "";
}

function orderNumberLabel(orderNumber) {
  return String(orderNumber || "").trim().replace(/^#/, "").replace(/^0+(?=\d)/, "") || "0";
}

function orderLabel(order) {
  return orderNumberLabel(order.displayNumber ?? order.id);
}

function displayOrderNumber(orderId) {
  const order = findOrder(orderId);
  return order ? orderLabel(order) : orderNumberLabel(orderId);
}

let openOrderActionsMenu = null;
let openOrderActionsDropdown = null;
let orderActionsCloseTimer = null;

function closeOrderActionsMenu() {
  clearTimeout(orderActionsCloseTimer);
  orderActionsCloseTimer = null;
  if (!openOrderActionsMenu) return;
  const menu = openOrderActionsMenu;
  const dropdown = openOrderActionsDropdown;
  menu.classList.remove("open");
  menu.querySelector(".order-actions-trigger")?.setAttribute("aria-expanded", "false");
  if (dropdown) {
    dropdown.classList.remove("is-portal");
    dropdown.removeAttribute("style");
    menu.append(dropdown);
  }
  openOrderActionsMenu = null;
  openOrderActionsDropdown = null;
}

function openOrderActionsMenuAt(menu) {
  clearTimeout(orderActionsCloseTimer);
  orderActionsCloseTimer = null;
  if (openOrderActionsMenu && openOrderActionsMenu !== menu) closeOrderActionsMenu();
  const dropdown = menu.querySelector(".order-actions-dropdown");
  const trigger = menu.querySelector(".order-actions-trigger");
  if (!dropdown || !trigger) return;
  openOrderActionsMenu = menu;
  openOrderActionsDropdown = dropdown;
  menu.classList.add("open");
  trigger.setAttribute("aria-expanded", "true");
  dropdown.classList.add("is-portal");
  dropdown.style.display = "grid";
  dropdown.style.visibility = "hidden";
  document.body.append(dropdown);
  const triggerRect = trigger.getBoundingClientRect();
  const menuRect = dropdown.getBoundingClientRect();
  const left = Math.max(8, Math.min(triggerRect.right - menuRect.width, window.innerWidth - menuRect.width - 8));
  const below = triggerRect.bottom + 4;
  const top = below + menuRect.height <= window.innerHeight - 8
    ? below
    : Math.max(8, triggerRect.top - menuRect.height - 4);
  Object.assign(dropdown.style, {
    position: "fixed",
    left: `${left}px`,
    right: "auto",
    top: `${top}px`,
    display: "grid",
    visibility: "visible",
  });
}

function scheduleOrderActionsClose() {
  clearTimeout(orderActionsCloseTimer);
  orderActionsCloseTimer = setTimeout(() => closeOrderActionsMenu(), 220);
}

function whatsappInvoiceUrl(order) {
  const phone = normalizePhoneDigits(order.phone);
  if (!/^\d{7,15}$/.test(phone)) return "";
  const whatsappPhone = phone.startsWith("0") ? `20${phone.slice(1)}` : phone;
  const items = order.items.map((item) =>
    `- ${item.name} (${item.sizeLabel || SIZES[item.size] || "وسط"}) × ${formatter.format(item.quantity)}: ${money(item.lineTotal)}`
  );
  const lines = [
    state.restaurant?.restaurantName || "فاتورة الطلب",
    `رقم الطلب: ${orderLabel(order)}`,
    `العميل: ${order.customer}`,
    `نوع الطلب: ${ORDER_TYPES[order.type] || "تيك أوي"}`,
    `التاريخ: ${dateTimeLabel(order.createdAt)}`,
    `الحالة: ${order.status}`,
    "",
    "تفاصيل الطلب:",
    ...items,
    `قيمة الأصناف: ${money(order.subtotal)}`,
    ...(Number(order.deliveryFee) ? [`رسوم التوصيل: ${money(order.deliveryFee)}`] : []),
    `الإجمالي: ${money(order.total)}`,
    `طريقة الدفع: ${PAYMENT_METHODS[order.paymentMethod] || "—"}`,
    ...(order.address ? [`العنوان: ${order.address}`] : []),
    ...(order.note ? [`ملاحظات: ${order.note}`] : []),
    ...(order.status === "ملغي" && order.cancellationReason ? [`سبب الإلغاء: ${order.cancellationReason}`] : []),
  ];
  return `https://api.whatsapp.com/send?phone=${whatsappPhone}&text=${encodeURIComponent(lines.join("\n"))}`;
}

function orderDetailsRow(order, colSpan = 9) {
  const items = order.items.map((item) => `
    <div class="order-detail-item">
      <span>${escapeHtml(item.name)} <small>${escapeHtml(item.sizeLabel || SIZES[item.size] || "وسط")} × ${formatter.format(item.quantity)}</small></span>
      <strong>${money(item.lineTotal)}</strong>
    </div>`).join("");
  return `<tr class="order-details-row hidden"><td colspan="${colSpan}"><div class="order-details">
    <div class="order-details-heading"><strong>تفاصيل الطلب ${escapeHtml(orderLabel(order))}</strong><span class="status-badge ${statusClass(order.status)}">${escapeHtml(order.status)}</span></div>
    <div class="order-details-grid">
      <section><h4>الأصناف</h4>${items || `<span class="product-description">لا توجد أصناف مسجلة</span>`}</section>
      <section class="order-detail-meta">
        <div><span>رقم الهاتف</span><strong dir="ltr">${escapeHtml(order.phone || "—")}</strong></div>
        <div><span>طريقة الدفع</span><strong>${escapeHtml(PAYMENT_METHODS[order.paymentMethod] || "—")}</strong></div>
        <div><span>العنوان</span><strong>${escapeHtml(order.address || "—")}</strong></div>
        <div><span>السائق</span><strong>${escapeHtml(order.driverName || "غير مسند")}</strong></div>
        <div><span>قيمة الأصناف</span><strong>${money(order.subtotal)}</strong></div>
        <div><span>رسوم التوصيل</span><strong>${money(order.deliveryFee)}</strong></div>
        <div class="order-detail-total"><span>الإجمالي</span><strong>${money(order.total)}</strong></div>
        <div><span>ملاحظات</span><strong>${escapeHtml(order.note || "—")}</strong></div>
        ${order.status === "ملغي" ? `<div class="order-cancellation-reason"><span>سبب الإلغاء</span><strong>${escapeHtml(order.cancellationReason || "لم يتم تسجيل سبب الإلغاء")}</strong></div>` : ""}
      </section>
    </div>
  </div></td></tr>`;
}

function orderRow(order, options = {}) {
  const { includeActions = true, compact = false } = options;
  const status = escapeHtml(order.status);
  const label = orderLabel(order);
  const invoiceUrl = whatsappInvoiceUrl(order);
  if (compact) {
    return `<tr data-order-id="${escapeHtml(order.id)}">
      <td class="order-id">${escapeHtml(label)}</td>
      <td>${escapeHtml(order.customer)}</td>
      <td><span class="type-badge">${ORDER_TYPES[order.type] || "تيك أوي"}</span></td>
      <td>${dateTimeLabel(order.createdAt)}</td>
      <td><strong>${money(order.total)}</strong></td>
      <td><span class="status-badge ${statusClass(order.status)}">${status}</span></td>
    </tr>`;
  }
  return `<tr data-order-id="${escapeHtml(order.id)}">
    <td class="order-id">${escapeHtml(label)}</td>
    <td><div class="customer-cell"><span class="mini-avatar">${escapeHtml(order.customer.slice(0, 1))}</span>${escapeHtml(order.customer)}${order.phone ? `<small>${escapeHtml(order.phone)}</small>` : ""}</div></td>
    <td><span class="type-badge">${ORDER_TYPES[order.type] || "تيك أوي"}</span></td>
    <td>${dateTimeLabel(order.createdAt)}</td>
    <td><span class="status-badge ${statusClass(order.status)}">${status}</span></td>
    <td>${escapeHtml(order.driverName || (["delivery", "reservation"].includes(order.type) ? "غير مسند" : "—"))}</td>
    <td>${escapeHtml(order.createdBy || "—")}</td>
    <td><button class="order-expand-button" type="button" data-toggle-order-details aria-label="عرض تفاصيل الطلب ${escapeHtml(label)}" aria-expanded="false">⌄</button></td>
    ${includeActions ? `<td class="row-actions">
      <a class="whatsapp-invoice-button ${invoiceUrl ? "" : "disabled"}" ${invoiceUrl ? `href="${escapeHtml(invoiceUrl)}" target="_blank" rel="noopener noreferrer"` : 'aria-disabled="true" tabindex="-1"'} aria-label="إرسال فاتورة الطلب ${escapeHtml(label)} عبر واتساب" title="${invoiceUrl ? "إرسال الفاتورة عبر واتساب" : "لا يوجد رقم هاتف صالح لهذا الطلب"}">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.2 11.8a8.2 8.2 0 0 1-12.1 7.1L3 20l1.2-4.8a8.2 8.2 0 1 1 16-3.4Z"/><path d="M8.2 7.7c.2-.5.4-.5.7-.5h.5c.2 0 .4.1.5.4l.8 1.8c.1.2.1.4 0 .6l-.6.8c-.2.2-.2.4 0 .6.5.9 1.3 1.6 2.2 2.1.2.1.4.1.6-.1l.8-1c.2-.2.4-.2.6-.1l1.8.8c.2.1.4.3.4.5 0 .4-.2 1.3-.8 1.8-.5.5-1.3.8-2.1.7-1-.1-2.4-.7-3.9-2-1.2-1-2.1-2.4-2.4-3.3-.3-.9 0-1.8.4-2.3Z"/></svg>
        واتساب
      </a>
      <div class="order-actions-menu">
        <button class="order-actions-trigger" type="button" aria-haspopup="true">الإجراءات <span>⌄</span></button>
        <div class="order-actions-dropdown">
          ${order.type === "takeaway" && !["مكتمل", "ملغي"].includes(order.status) ? `<button type="button" data-complete-order="${escapeHtml(order.id)}">تم التسليم</button>` : ""}
          ${!["مكتمل", "ملغي"].includes(order.status) ? `<button type="button" data-cancel-order="${escapeHtml(order.id)}">إلغاء الطلب</button>` : ""}
          ${["delivery", "reservation"].includes(order.type) && state.user?.role === "admin" && !["مكتمل", "ملغي"].includes(order.status)
    ? order.driverId
      ? `<button type="button" data-unassign-order="${escapeHtml(order.id)}">إلغاء السائق</button>`
      : `<button type="button" data-assign-order="${escapeHtml(order.id)}">إسناد إلى سائق</button>`
    : ""}
        </div>
      </div>
    </td>` : ""}
  </tr>${orderDetailsRow(order, includeActions ? 9 : 8)}`;
}

function renderOrderTable(selector, orders, options = {}) {
  const table = document.querySelector(selector);
  const expandedOrderIds = new Set([...table.querySelectorAll("[data-toggle-order-details][aria-expanded='true']")]
    .map((button) => button.closest("[data-order-id]")?.dataset.orderId)
    .filter(Boolean));
  table.innerHTML = orders.map((order) => orderRow(order, options)).join("");
  table.querySelectorAll("[data-order-id]").forEach((row) => {
    if (!expandedOrderIds.has(row.dataset.orderId)) return;
    const button = row.querySelector("[data-toggle-order-details]");
    const detailsRow = row.nextElementSibling;
    if (!button || !detailsRow?.classList.contains("order-details-row")) return;
    button.setAttribute("aria-expanded", "true");
    button.textContent = "⌃";
    detailsRow.classList.remove("hidden");
  });
}

function renderOrders() {
  closeOrderActionsMenu();
  const query = document.querySelector("#order-search").value.trim().toLocaleLowerCase();
  const phoneQuery = normalizePhoneDigits(query);
  const orderQuery = query.replace(/^#/, "").replace(/^0+(?=\d)/, "");
  const filter = document.querySelector("#order-filter").value;
  const filtered = state.orders.filter((order) =>
    (filter === "all" || order.status === filter) &&
    (!query || orderLabel(order).toLocaleLowerCase().includes(orderQuery) ||
      (phoneQuery.length >= 4 && normalizePhoneDigits(order.phone).includes(phoneQuery)))
  );
  renderOrderTable("#orders-table", filtered);
  document.querySelector("#orders-empty").classList.toggle("hidden", filtered.length > 0);
  const active = state.orders.filter((order) => order.status !== "مكتمل" && order.status !== "ملغي").length;
  const completed = state.orders.filter((order) => order.status === "مكتمل").length;
  const todaySales = state.orders.filter((order) => dateKey(new Date(order.createdAt)) === dateKey() && order.status !== "ملغي").reduce((sum, order) => sum + order.total, 0);
  renderStats("#order-stats", [
    ["كل الطلبات", formatter.format(state.orders.length), "↗", ""],
    ["طلبات نشطة", formatter.format(active), "◷", "orange"],
    ["طلبات مكتملة", formatter.format(completed), "✓", "blue"],
    ["مبيعات اليوم", money(todaySales), "ج.م", "purple"],
  ]);
}

async function refreshOrderReport({ render = true } = {}) {
  const result = await api("/order-report");
  const changed = JSON.stringify(state.orderReportOrders) !== JSON.stringify(result.orders);
  state.orderReportOrders = result.orders;
  if (render) renderOrderReport();
  return changed;
}

function renderOrderReport() {
  closeOrderActionsMenu();
  const query = document.querySelector("#order-report-search").value.trim().toLocaleLowerCase();
  const phoneQuery = normalizePhoneDigits(query);
  const orderQuery = query.replace(/^#/, "").replace(/^0+(?=\d)/, "");
  const type = document.querySelector("#order-report-type").value;
  const payment = document.querySelector("#order-report-payment").value;
  const status = document.querySelector("#order-report-status").value;
  const { from, to } = state.orderReportRange;
  const fromDate = from ? new Date(from) : null;
  const toDate = to ? new Date(to) : null;
  const fromTime = fromDate && Number.isFinite(fromDate.getTime()) ? fromDate.getTime() : Number.NEGATIVE_INFINITY;
  const toTime = toDate && Number.isFinite(toDate.getTime()) ? toDate.getTime() + 59_999 : Number.POSITIVE_INFINITY;
  const filtered = state.orderReportOrders.filter((order) => {
    const createdAt = new Date(order.createdAt).getTime();
    return (type === "all" || order.type === type) &&
      (payment === "all" || order.paymentMethod === payment) &&
      (status === "all" || order.status === status) &&
      createdAt >= fromTime && createdAt <= toTime &&
      (!query || orderLabel(order).toLocaleLowerCase().includes(orderQuery) ||
        (phoneQuery.length >= 4 && normalizePhoneDigits(order.phone).includes(phoneQuery)));
  });
  renderOrderTable("#order-report-table", filtered, { includeActions: false });
  document.querySelector("#order-report-empty").classList.toggle("hidden", filtered.length > 0);
  const active = filtered.filter((order) => order.status !== "مكتمل" && order.status !== "ملغي").length;
  const completed = filtered.filter((order) => order.status === "مكتمل").length;
  const total = filtered.filter((order) => order.status !== "ملغي").reduce((sum, order) => sum + order.total, 0);
  renderStats("#order-report-stats", [
    ["طلبات مطابقة", formatter.format(filtered.length), "▤", ""],
    ["طلبات نشطة", formatter.format(active), "◷", "orange"],
    ["طلبات مكتملة", formatter.format(completed), "✓", "blue"],
    ["إجمالي الطلبات المطابقة", money(total), "ج.م", "purple"],
  ]);
}

function findOrder(orderNumber) {
  return state.orders.find((order) => order.id === orderNumber) ||
    state.orderReportOrders.find((order) => order.id === orderNumber);
}

function renderCurrentOrderPage() {
  if (state.page === "order-report") renderOrderReport();
  else renderOrders();
}

async function refreshCurrentOrderPage() {
  if (state.page === "order-report") {
    const changed = await refreshOrderReport({ render: false });
    if (changed) renderOrderReport();
    return;
  }
  const changed = await refreshOrders();
  if (changed) renderOrders();
}

function receiptDocument(order, paperWidthMm) {
  const restaurantName = state.restaurant?.restaurantName || "Nourix";
  const restaurantPhones = [state.restaurant?.phone1, state.restaurant?.phone2].filter(Boolean);
  const restaurantAddress = state.restaurant?.address || "";
  const restaurantLogo = state.restaurant?.logoUrl || "";
  const items = order.items.map((item) => `<tr><td>${escapeHtml(item.name)}<small>${escapeHtml(item.sizeLabel || SIZES[item.size] || "وسط")}</small></td><td>${formatter.format(item.quantity)}</td><td>${money(item.lineTotal)}</td></tr>`).join("");
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><base href="${escapeHtml(location.origin)}/"><style>
    *{box-sizing:border-box}html,body{width:${paperWidthMm}mm;margin:0;padding:0;background:#fff;color:#202820;font:14px Arial,sans-serif}.receipt{width:${paperWidthMm - 6}mm;margin:3mm auto}.brand{text-align:center;border-bottom:1px dashed #9aa39a;padding-bottom:10px}.brand img{display:block;max-width:35mm;max-height:22mm;margin:0 auto 6px;object-fit:contain}.brand h1{font-size:20px;margin:3px 0}.brand p{margin:3px 0;color:#657065}.head{display:flex;justify-content:space-between;gap:10px;padding:12px 0;border-bottom:1px dashed #9aa39a}.meta{display:grid;grid-template-columns:1fr 1fr;gap:9px;padding:12px 0}.meta div{display:grid;gap:4px}.meta span,small{color:#737b73;font-size:11px}table{width:100%;border-collapse:collapse}th,td{text-align:right;padding:8px 3px;border-bottom:1px solid #e5e8e4}th{font-size:11px;color:#697269}td small{display:block;margin-top:4px}.totals{margin-top:10px}.totals div{display:flex;justify-content:space-between;padding:6px 0}.total{border-top:1px dashed #9aa39a;margin-top:7px;padding-top:10px!important;font-weight:bold;font-size:17px}.note{margin-top:12px;padding:10px;background:#f3f5f2;border-radius:6px}.footer{text-align:center;margin-top:16px;color:#737b73;font-size:11px}
  </style></head><body><main class="receipt">
    <header class="brand">${restaurantLogo ? `<img class="restaurant-logo" src="${escapeHtml(restaurantLogo)}" alt="شعار ${escapeHtml(restaurantName)}" />` : ""}<h1>${escapeHtml(restaurantName)}</h1>${restaurantPhones.map((phone) => `<p dir="ltr">${escapeHtml(phone)}</p>`).join("")}${restaurantAddress ? `<p>${escapeHtml(restaurantAddress)}</p>` : ""}<p>تفاصيل الطلب</p></header>
    <section class="head"><strong>طلب رقم ${escapeHtml(orderLabel(order))}</strong><span>${dateTimeLabel(order.createdAt)}</span></section>
    <section class="meta"><div><span>العميل</span><strong>${escapeHtml(order.customer)}</strong></div><div><span>الهاتف</span><strong dir="ltr">${escapeHtml(order.phone || "—")}</strong></div><div><span>نوع الطلب</span><strong>${escapeHtml(ORDER_TYPES[order.type] || "تيك أوي")}</strong></div><div><span>طريقة الدفع</span><strong>${escapeHtml(PAYMENT_METHODS[order.paymentMethod] || "—")}</strong></div>${order.address ? `<div style="grid-column:1/-1"><span>العنوان</span><strong>${escapeHtml(order.address)}</strong></div>` : ""}${order.driverName ? `<div><span>السائق</span><strong>${escapeHtml(order.driverName)}</strong></div>` : ""}</section>
    <table><thead><tr><th>الصنف</th><th>العدد</th><th>السعر</th></tr></thead><tbody>${items}</tbody></table>
    <section class="totals"><div><span>قيمة الأصناف</span><strong>${money(order.subtotal)}</strong></div>${Number(order.deliveryFee) ? `<div><span>رسوم التوصيل</span><strong>${money(order.deliveryFee)}</strong></div>` : ""}<div class="total"><span>الإجمالي</span><strong>${money(order.total)}</strong></div></section>
    ${order.note ? `<div class="note"><strong>ملاحظات:</strong> ${escapeHtml(order.note)}</div>` : ""}
    <footer class="footer">شكرًا لطلبك من ${escapeHtml(restaurantName)}</footer></main></body></html>`;
}

async function createReceiptPdf(order) {
  if (!window.html2canvas || !window.jspdf?.jsPDF) {
    throw new Error("تعذر تحميل مكوّنات إعداد ملف الطباعة. أعد تحميل البرنامج.");
  }
  const paperWidthMm = state.restaurant?.printer?.paperWidthMm || 80;
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${paperWidthMm}mm;height:100vh;border:0;background:#fff;`;
  const frameLoaded = new Promise((resolve, reject) => {
    frame.addEventListener("load", resolve, { once: true });
    frame.addEventListener("error", () => reject(new Error("تعذر تجهيز معاينة الإيصال للطباعة.")), { once: true });
  });
  frame.srcdoc = receiptDocument(order, paperWidthMm);
  document.body.append(frame);
  try {
    await frameLoaded;
    const receipt = frame.contentDocument.querySelector(".receipt");
    if (!receipt) throw new Error("تعذر تجهيز محتوى الإيصال.");
    await Promise.all([...frame.contentDocument.images].map((image) => image.decode()));
    await frame.contentDocument.fonts.ready;
    const widthPx = frame.contentWindow.innerWidth;
    const receiptHeightMm = receipt.getBoundingClientRect().height / widthPx * paperWidthMm;
    if (!Number.isFinite(receiptHeightMm) || receiptHeightMm <= 0 || receiptHeightMm > 4000) {
      throw new Error("حجم الإيصال غير صالح للطباعة.");
    }
    const canvas = await window.html2canvas(receipt, {
      backgroundColor: "#ffffff",
      logging: false,
      scale: 2,
      useCORS: true,
    });
    const pdf = new window.jspdf.jsPDF({
      orientation: "portrait",
      unit: "mm",
      format: [paperWidthMm, receiptHeightMm + 6],
      compress: true,
    });
    pdf.addImage(canvas.toDataURL("image/jpeg", 0.94), "JPEG", 3, 3, paperWidthMm - 6, receiptHeightMm);
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
      reader.addEventListener("error", () => reject(new Error("تعذر إنشاء ملف الإيصال.")), { once: true });
      reader.readAsDataURL(pdf.output("blob"));
    });
    return dataUrl;
  } finally {
    frame.remove();
  }
}

async function printOrder(order) {
  try {
    const pdfData = await createReceiptPdf(order);
    const result = await api(`/orders/${encodeURIComponent(order.id)}/print`, {
      method: "POST",
      body: JSON.stringify({ pdfData }),
    });
    state.orders = state.orders.map((item) => item.id === result.order.id ? result.order : item);
    renderOrders();
    showToast(`تم إرسال الطلب إلى ${result.printers.join(" و")}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function openDriverAssignment(order) {
  try {
    const result = await api("/delivery-drivers");
    state.drivers = result.drivers;
    document.querySelector("#assign-driver-order").textContent = `اختيار السائق للطلب رقم ${orderLabel(order)}`;
    const list = document.querySelector("#assign-driver-list");
    list.innerHTML = state.drivers.length ? state.drivers.map((driver) => `
      <button type="button" class="driver-assignment-option ${driver.id === order.driverId ? "selected" : ""}" data-assign-driver="${driver.id}">
        <span class="driver-assignment-avatar">${escapeHtml(driver.name.slice(0, 1))}</span>
        <span><strong>${escapeHtml(driver.name)}</strong><small dir="ltr">${escapeHtml(driver.phone)}</small></span>
        ${driver.id === order.driverId ? `<span class="driver-assigned-check">✓</span>` : ""}
      </button>`).join("") : `<div class="table-empty">لا يوجد سائقون مسجلون. أضف سائقًا من صفحة سائقو التوصيل أولًا.</div>`;
    list.dataset.orderNumber = order.id;
    document.querySelector("#assign-driver-modal").classList.remove("hidden");
  } catch (error) {
    showToast(error.message);
  }
}

async function assignDriver(orderNumber, driverId) {
  try {
    const result = await api(`/orders/${encodeURIComponent(orderNumber)}/driver`, {
      method: "PATCH",
      body: JSON.stringify({ driverId }),
    });
    state.orders = state.orders.map((order) => order.id === result.order.id ? result.order : order);
    state.orderReportOrders = state.orderReportOrders.map((order) => order.id === result.order.id ? result.order : order);
    closeModal("assign-driver-modal");
    renderCurrentOrderPage();
    showToast(`تم إسناد الطلب ${displayOrderNumber(orderNumber)} إلى ${result.order.driverName}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function unassignDriver(orderNumber) {
  try {
    await api(`/orders/${encodeURIComponent(orderNumber)}/driver`, { method: "DELETE" });
    await refreshCurrentOrderPage();
    showToast(`تم إلغاء إسناد الطلب ${displayOrderNumber(orderNumber)}`);
  } catch (error) {
    showToast(error.message);
  }
}

async function completeTakeawayOrder(orderNumber) {
  try {
    await api(`/orders/${encodeURIComponent(orderNumber)}/status`, {
      method: "PATCH",
      body: JSON.stringify({ status: "مكتمل" }),
    });
    await refreshCurrentOrderPage();
    showToast(`تم تسليم الطلب ${displayOrderNumber(orderNumber)}`);
  } catch (error) {
    showToast(error.message);
  }
}

function renderStats(selector, stats) {
  document.querySelector(selector).innerHTML = stats.map(([label, value, icon, color]) => `
    <article class="stat-card"><div><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(value)}</div></div><span class="stat-icon ${color}">${escapeHtml(icon)}</span></article>
  `).join("");
}

async function renderReports() {
  const result = await api(`/reports?period=${encodeURIComponent(document.querySelector("#report-period").value)}`);
  state.reportProductSales = result.productSales;
  state.reportCategories = [...new Set([
    ...result.productCategories,
    ...result.productSales.map((product) => product.category),
  ])];
  const categorySelect = document.querySelector("#top-products-category");
  const selectedCategory = categorySelect.value;
  categorySelect.innerHTML = `<option value="all">كل الفئات</option>${state.reportCategories.map((category) =>
    `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`
  ).join("")}`;
  categorySelect.value = state.reportCategories.includes(selectedCategory) ? selectedCategory : "all";
  renderStats("#report-stats", [
    ["إجمالي المبيعات", money(result.sales), "↗", ""],
    ["عدد الطلبات", formatter.format(result.orderCount), "▤", "blue"],
    ["إجمالي المصاريف", money(result.expenses), "↙", "orange"],
    ["إجمالي الطلبات الملغاة", money(result.cancelledTotal), "×", "orange"],
    ["صافي الدخل", money(result.sales - result.expenses - result.cancelledTotal), "◈", "purple"],
  ]);
  const days = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const day = new Date();
    day.setDate(day.getDate() - offset);
    const key = dateKey(day);
    const item = result.dailySales.find((sales) => sales.date === key);
    days.push({ key, value: item?.sales || 0, label: new Intl.DateTimeFormat(dateLocale, { weekday: "short" }).format(day) });
  }
  const maximum = Math.max(1, ...days.map((day) => day.value));
  document.querySelector("#sales-chart").innerHTML = days.map((day, index) => `
    <div class="chart-column"><div class="bar ${index === days.length - 1 ? "today" : ""}" style="height:${Math.max(4, (day.value / maximum) * 145)}px">${day.value ? `<small class="bar-value">${formatter.format(day.value)}</small>` : ""}</div><span>${day.label}</span></div>
  `).join("");
  const types = Object.entries(ORDER_TYPES).map(([type, label]) => [type, label, result.typeCounts[type] || 0]);
  const maxCount = Math.max(1, ...types.map(([, , count]) => count));
  document.querySelector("#type-breakdown").innerHTML = types.map(([type, label, count]) => `
    <div class="breakdown-line"><div class="breakdown-line-head"><span>${label}</span><strong>${formatter.format(count)} طلب</strong></div><div class="progress-track"><div class="progress-fill ${type}" style="width:${(count / maxCount) * 100}%"></div></div></div>
  `).join("");
  document.querySelector("#report-order-total").textContent = formatter.format(result.orderCount);
  renderTopProductsChart();
}

function renderTopProductsChart() {
  const category = document.querySelector("#top-products-category").value;
  const products = state.reportProductSales
    .filter((product) => category === "all" || product.category === category)
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name, "ar"))
    .slice(0, 10);
  const maximum = Math.max(1, ...products.map((product) => product.quantity));
  const colors = ["#18a8c9", "#f0a43c", "#8d78d6", "#37a879", "#e36b78", "#4b8fd1", "#d27ab5", "#849b45", "#e17c3c", "#5a9ca1"];
  document.querySelector("#top-products-chart").innerHTML = products.map((product, index) => `
    <div class="top-product-row" title="${escapeHtml(product.name)} — ${formatter.format(product.quantity)} قطعة">
      <div class="top-product-label"><strong>${escapeHtml(product.name)}</strong><small>${escapeHtml(product.category)}</small></div>
      <div class="top-product-track"><div class="top-product-bar" style="width:${(product.quantity / maximum) * 100}%;background:${colors[index % colors.length]}"></div></div>
      <strong class="top-product-quantity">${formatter.format(product.quantity)} <small>قطعة</small></strong>
    </div>
  `).join("");
  document.querySelector("#top-products-empty").classList.toggle("hidden", products.length > 0);
}

async function renderExpenses() {
  const response = await api("/expenses");
  state.expenses = response.expenses;
  renderExpenseTable();
}

async function renderArchivedExpenses() {
  const response = await api("/expenses/archive");
  state.archivedExpenses = response.expenses;
  renderArchivedExpenseTable();
}

function expenseDateTimeLabel(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(dateLocale, {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
}

function renderArchivedExpenseTable() {
  const query = document.querySelector("#archived-expense-search").value.trim().toLocaleLowerCase();
  const filtered = state.archivedExpenses.filter((expense) =>
    expense.name.toLocaleLowerCase().includes(query)
  );
  document.querySelector("#archived-expenses-table").innerHTML = filtered.map((expense) => `
    <tr>
      <td class="expense-name">${escapeHtml(expense.name)}${expense.note ? `<div class="product-description">${escapeHtml(expense.note)}</div>` : ""}</td>
      <td>${expenseDateTimeLabel(expense.createdAt)}</td>
      <td class="expense-amount">${money(expense.amount)}</td>
      <td>${escapeHtml(expense.createdBy)}</td>
    </tr>`).join("");
  document.querySelector("#archived-expenses-empty").classList.toggle("hidden", filtered.length > 0);
}

function renderExpenseTable() {
  const query = document.querySelector("#expense-search").value.trim().toLocaleLowerCase();
  const filtered = state.expenses.filter((expense) => `${expense.name} ${expense.category} ${expense.payment}`.toLocaleLowerCase().includes(query));
  const today = state.expenses.filter((expense) => dateKey(new Date(expense.createdAt)) === dateKey()).reduce((sum, expense) => sum + expense.amount, 0);
  const monthStart = dateKey(new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const month = state.expenses.filter((expense) => dateKey(new Date(expense.createdAt)) >= monthStart).reduce((sum, expense) => sum + expense.amount, 0);
  const total = state.expenses.reduce((sum, expense) => sum + expense.amount, 0);
  renderStats("#expense-stats", [
    ["مصروفات اليوم بالوردية الحالية", money(today), "↙", "orange"],
    ["مصروفات الشهر بالوردية الحالية", money(month), "▤", "blue"],
    ["إجمالي مصاريف الوردية الحالية", money(total), "◈", "purple"],
    ["عدد عمليات الوردية الحالية", formatter.format(state.expenses.length), "＋", ""],
  ]);
  document.querySelector("#expenses-table").innerHTML = filtered.map((expense) => `
    <tr><td class="expense-name">${escapeHtml(expense.name)}${expense.note ? `<div class="product-description">${escapeHtml(expense.note)}</div>` : ""}</td><td><span class="expense-category">${escapeHtml(expense.category)}</span></td><td>${dateTimeLabel(expense.createdAt)}</td><td>${escapeHtml(expense.payment)}</td><td class="expense-amount">${money(expense.amount)}</td><td>${escapeHtml(expense.createdBy)}</td><td>${state.user.role === "admin" ? `<button class="delete-button" data-delete-expense="${expense.id}" aria-label="حذف ${escapeHtml(expense.name)}">×</button>` : ""}</td></tr>
  `).join("");
  document.querySelector("#expenses-empty").classList.toggle("hidden", filtered.length > 0);
}

async function renderMenu() {
  const [result, categoryResult] = await Promise.all([
    api(`/products${state.user.role === "admin" ? "?all=true" : ""}`),
    api("/product-categories"),
  ]);
  state.products = result.products;
  state.productCategories = categoryResult.categories;
  updateProductCategorySelect();
  removeUnavailableCartItems();
  renderProducts();
  renderCart();
  const query = document.querySelector("#menu-search").value.trim().toLocaleLowerCase();
  const filtered = state.products.filter((product) =>
    `${product.name} ${product.category} ${product.description}`.toLocaleLowerCase().includes(query)
  );
  const activeCount = state.products.filter((product) => product.active).length;
  renderStats("#menu-stats", [
    ["عدد الأصناف", formatter.format(state.products.length), "▣", ""],
    ["متاحة في نقطة البيع", formatter.format(activeCount), "✓", "blue"],
    ["مخفية", formatter.format(state.products.length - activeCount), "◉", "purple"],
  ]);
  document.querySelector("#menu-table").innerHTML = filtered.map((product) => `
    <tr><td>${product.imageUrl ? `<img class="menu-product-thumb" src="${escapeHtml(product.imageUrl)}" alt="${escapeHtml(product.name)}" loading="lazy" />` : `<span class="menu-product-thumb menu-product-placeholder">—</span>`}</td>
      <td><strong>${escapeHtml(product.name)}</strong><small class="size-price-summary">${escapeHtml(product.description)}</small></td>
      <td>${escapeHtml(product.category)}</td>
      <td><small class="size-price-summary">${Object.entries(SIZES).map(([size, label]) => `${label}: ${money(product.sizePrices?.[size] ?? product.price)}`).join(" · ")}</small></td>
      <td><span class="status-badge ${product.active ? "complete" : "cancelled"}">${product.active ? "متاح" : "مخفي"}</span></td>
      <td>${state.user.role === "admin" ? `<button class="text-button" data-edit-product="${product.id}" type="button">تعديل</button>` : ""}</td></tr>
  `).join("");
  document.querySelector("#menu-empty").classList.toggle("hidden", filtered.length > 0);
}

function updateProductCategorySelect(selectedName = "") {
  const select = document.querySelector("#product-form").elements.category;
  if (!select) return;
  select.innerHTML = `<option value="">اختر فئة</option>${state.productCategories.map((category) =>
    `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`
  ).join("")}`;
  select.value = selectedName;
}

function renderProductCategoryList() {
  document.querySelector("#product-category-list").innerHTML = state.productCategories.length
    ? state.productCategories.map((category) => `
      <div class="product-category-row">
        <strong>${escapeHtml(category)}</strong>
        <div><button class="text-button" type="button" data-edit-category="${escapeHtml(category)}">تعديل</button>
        <button class="delete-button" type="button" data-delete-category="${escapeHtml(category)}" aria-label="حذف فئة ${escapeHtml(category)}">حذف</button></div>
      </div>`).join("")
    : `<div class="table-empty">لا توجد فئات مسجلة.</div>`;
}

function resetProductCategoryForm() {
  const form = document.querySelector("#product-category-form");
  form.reset();
  form.elements.originalName.value = "";
  document.querySelector("#product-category-submit").textContent = "إضافة الفئة";
  document.querySelector("#product-category-cancel-edit").classList.add("hidden");
}

async function openProductCategoryModal() {
  try {
    const result = await api("/product-categories");
    state.productCategories = result.categories;
    updateProductCategorySelect();
    renderProductCategoryList();
    resetProductCategoryForm();
    document.querySelector("#product-category-modal").classList.remove("hidden");
    document.querySelector("#product-category-form").elements.name.focus();
  } catch (error) {
    showToast(error.message);
  }
}

function renderCustomerResults(customers, message = "") {
  const container = document.querySelector("#customer-results");
  if (!customers.length) {
    container.innerHTML = `<div class="customer-placeholder">${escapeHtml(message || "لم يتم العثور على عميل بهذا الرقم.")}</div>`;
    return;
  }
  if (customers.length > 1 || !customers[0].orders) {
    container.innerHTML = `<div class="customer-results-list">${customers.map((customer) => `
      <button class="customer-result" data-customer-phone="${escapeHtml(customer.phone)}">
        <span class="mini-avatar">${escapeHtml(customer.name.slice(0, 1))}</span>
        <span><strong>${escapeHtml(customer.name)}</strong><small>${escapeHtml(customer.phone)}</small></span>
        <span class="customer-result-total">${formatter.format(customer.orderCount)} طلب · ${money(customer.totalSpent)}</span>
      </button>`).join("")}</div>`;
    if (customers.length === 1 && !customers[0].orders) openCustomer(customers[0].phone);
    return;
  }
  const customer = customers[0];
  container.innerHTML = `
    <div class="customer-profile">
      <div class="customer-profile-head"><div class="customer-big-avatar">${escapeHtml(customer.name.slice(0, 1))}</div><div><h2>${escapeHtml(customer.name)}</h2><p>${escapeHtml(customer.phone)}</p></div></div>
      <div class="customer-addresses"><strong>العناوين المسجلة ورسوم التوصيل</strong><span>${customer.addresses.length ? customer.addresses.map((entry) => `${escapeHtml(entry.address)} — ${money(entry.deliveryFee)}`).join(" · ") : "لا توجد عناوين مسجلة"}</span></div>
      <div class="stats-row customer-stats">
        <article class="stat-card"><div><div class="stat-label">عدد الطلبات</div><div class="stat-value">${formatter.format(customer.orderCount)}</div></div><span class="stat-icon">▤</span></article>
        <article class="stat-card"><div><div class="stat-label">إجمالي قيمة الطلبات غير الملغاة</div><div class="stat-value">${money(customer.totalSpent)}</div></div><span class="stat-icon blue">ج.م</span></article>
      </div>
      <div class="table-card"><div class="table-title"><div><h3>سجل الطلبات</h3><p>تفاصيل كل طلب وتاريخه وحالته</p></div></div>
        <div class="table-wrap"><table><thead><tr><th>رقم الطلب</th><th>التاريخ والوقت</th><th>النوع</th><th>الأصناف والتفاصيل</th><th>القيمة</th><th>الحالة</th><th>بواسطة</th></tr></thead>
          <tbody>${customer.orders.map((order) => `<tr>
            <td class="order-id">${escapeHtml(orderLabel(order))}</td><td>${dateTimeLabel(order.createdAt)}</td>
            <td>${ORDER_TYPES[order.type]}</td>
            <td class="customer-order-items">${order.items.map((item) => `${escapeHtml(item.name)} (${escapeHtml(item.sizeLabel || SIZES[item.size] || "وسط")}) × ${formatter.format(item.quantity)}`).join("<br>")}${order.address ? `<small>${escapeHtml(order.address)} · توصيل: ${money(order.deliveryFee)}</small>` : ""}</td>
            <td><strong>${money(order.total)}</strong><small>${PAYMENT_METHODS[order.paymentMethod] || "—"}</small></td><td><span class="status-badge ${statusClass(order.status)}">${escapeHtml(order.status)}</span>${order.note ? `<small class="customer-order-note">${escapeHtml(order.note)}</small>` : ""}</td><td>${escapeHtml(order.createdBy)}</td>
          </tr>`).join("")}</tbody></table></div>
          ${customer.orders.length ? "" : `<div class="table-empty">لا توجد طلبات مسجلة لهذا العميل.</div>`}
      </div>
    </div>`;
}

async function openCustomer(phone) {
  try {
    document.querySelector("#customer-search").value = phone;
    const result = await api(`/customers?phone=${encodeURIComponent(phone)}`);
    renderCustomerResults(result.customers);
  } catch (error) {
    showToast(error.message);
  }
}

async function renderUsers() {
  const result = await api("/users");
  state.users = result.users;
  document.querySelector("#users-table").innerHTML = state.users.map((user) => `
    <tr><td><strong>${escapeHtml(user.username)}</strong></td>
      <td><span class="type-badge">${user.role === "admin" ? "مدير" : "كاشير"}</span></td>
      <td>${user.role === "admin" ? "كل الصفحات" : (user.pagePermissions || []).map((page) => PAGE_LABELS[page]).filter(Boolean).join("، ") || "لا توجد صفحات"}</td>
      <td><span class="status-badge ${user.active ? "complete" : "cancelled"}">${user.active ? "نشط" : "موقوف"}</span></td>
      <td>${dateLabel(user.createdAt)}</td>
      <td class="user-row-actions"><button class="text-button" data-edit-user="${user.id}" type="button">تعديل</button>${user.id !== state.user?.id ? `<button class="delete-button" data-delete-user="${user.id}" type="button">حذف</button>` : ""}</td></tr>
  `).join("");
}

async function renderDrivers() {
  const result = await api("/delivery-drivers");
  state.drivers = result.drivers;
  const select = document.querySelector("#delivery-driver-select");
  const previousSelection = state.activeDriverId || select.value;
  select.replaceChildren(new Option("اختر سائقًا", ""));
  for (const driver of state.drivers) select.add(new Option(`${driver.name} — ${driver.phone}`, String(driver.id)));
  const selected = state.drivers.find((driver) => String(driver.id) === previousSelection) || state.drivers[0];
  select.value = selected ? String(selected.id) : "";
  state.activeDriverId = select.value;
  document.querySelector("#edit-driver-open").disabled = !selected;
  document.querySelector("#delivery-workspace").classList.toggle("hidden", !selected);
  document.querySelector("#delivery-driver-placeholder").classList.toggle("hidden", Boolean(selected));
  if (selected) await loadDriverDetails(selected.id);
  else {
    document.querySelector("#delivery-driver-name").textContent = "—";
    document.querySelector("#delivery-driver-phone").textContent = "—";
  }
}

async function loadDriverDetails(driverId = state.activeDriverId) {
  if (!driverId) return;
  const result = await api(`/delivery-drivers/${encodeURIComponent(driverId)}/summary`);
  state.currentDriverSummary = result;
  document.querySelector("#delivery-driver-name").textContent = result.driver.name;
  document.querySelector("#delivery-driver-phone").textContent = result.driver.phone;
  document.querySelector("#delivery-driver-avatar").textContent = result.driver.name.slice(0, 1);
  renderStats("#delivery-stats", [
    ["عدد الطلبات المسندة", formatter.format(result.summary.orderCount), "▤", "blue"],
    ["مستحق المطعم المتبقي", money(result.summary.remaining), "ج.م", "orange"],
    ["مستحق السائق", money(result.summary.driverDue), "↗", ""],
    ["إجمالي التحصيل", money(result.summary.collected), "✓", "purple"],
  ]);
  document.querySelector("#delivery-collections-table").innerHTML = result.collections.map((collection) => `
    <tr><td><strong>${money(collection.amount)}</strong></td><td>${dateTimeLabel(collection.createdAt)}</td><td>${escapeHtml(collection.collectedBy)}</td></tr>
  `).join("");
  document.querySelector("#delivery-collections-empty").classList.toggle("hidden", result.collections.length > 0);
  renderDeliveryOrders();
}

function renderDeliveryOrders() {
  const result = state.currentDriverSummary;
  if (!result) return;
  const query = document.querySelector("#delivery-order-search").value.trim().toLocaleLowerCase();
  const phoneQuery = normalizePhoneDigits(query);
  const orderQuery = query.replace(/^#/, "").replace(/^0+(?=\d)/, "");
  const orders = result.orders.filter((order) =>
    !query || orderLabel(order).toLocaleLowerCase().includes(orderQuery) ||
    (phoneQuery.length >= 4 && normalizePhoneDigits(order.phone).includes(phoneQuery))
  );
  document.querySelector("#delivery-orders-table").innerHTML = orders.map((order) => `
    <tr>
      <td class="order-id">${escapeHtml(orderLabel(order))}</td>
      <td><div class="customer-cell"><span class="mini-avatar">${escapeHtml(order.customer.slice(0, 1))}</span>${escapeHtml(order.customer)}${order.phone ? `<small>${escapeHtml(order.phone)}</small>` : ""}</div></td>
      <td><span class="type-badge">${ORDER_TYPES[order.type] || "دليفري"}</span></td>
      <td>${dateTimeLabel(order.createdAt)}</td>
      <td><span class="status-badge ${statusClass(order.status)}">${escapeHtml(order.status)}</span></td>
      <td><strong>${money(order.total)}</strong></td>
      <td>${escapeHtml(order.createdBy || "—")}</td>
      <td><button class="order-expand-button" type="button" data-toggle-delivery-details aria-label="عرض تفاصيل الطلب ${escapeHtml(orderLabel(order))}" aria-expanded="false">⌄</button></td>
    </tr>${orderDetailsRow(order, 8)}
  `).join("");
  document.querySelector("#delivery-orders-empty").classList.toggle("hidden", orders.length > 0);
}

async function loadLoginUsers() {
  const select = document.querySelector("#login-username");
  try {
    const result = await api("/auth/users");
    select.replaceChildren(new Option("اختر اسم الدخول", ""));
    for (const user of result.users) select.add(new Option(user.username, user.username));
  } catch (error) {
    select.replaceChildren(new Option("تعذر تحميل المستخدمين", ""));
    console.error("تعذر تحميل قائمة المستخدمين:", error);
  }
}

function openUserModal(user = null) {
  const form = document.querySelector("#user-form");
  form.reset();
  const editing = Boolean(user);
  form.elements.id.value = user?.id || "";
  form.elements.username.value = user?.username || "";
  form.elements.role.value = user?.role || "cashier";
  form.elements.active.value = String(user?.active ?? true);
  form.elements.password.value = "";
  form.elements.password.required = !editing;
  form.elements.password.placeholder = editing ? "اتركها فارغة دون تغيير" : "";
  const permissions = new Set(user?.pagePermissions || DEFAULT_CASHIER_PAGES);
  form.querySelectorAll('input[name="pagePermissions"]').forEach((input) => {
    input.checked = permissions.has(input.value);
  });
  document.querySelector("#user-page-permissions").classList.toggle("hidden", form.elements.role.value !== "cashier");
  document.querySelector("#user-password-hint").textContent = editing ? "(اختياري عند التعديل)" : "";
  document.querySelector("#user-active-field").classList.toggle("hidden", !editing);
  document.querySelector("#user-modal-title").textContent = editing ? "تعديل حساب المستخدم" : "إضافة حساب جديد";
  document.querySelector("#user-save-button").textContent = editing ? "حفظ التعديلات" : "إنشاء الحساب";
  document.querySelector("#user-modal").classList.remove("hidden");
}

document.querySelector("#user-form").elements.role.addEventListener("change", (event) => {
  document.querySelector("#user-page-permissions").classList.toggle("hidden", event.currentTarget.value !== "cashier");
});

function openDriverModal(driver = null) {
  const form = document.querySelector("#driver-form");
  const editing = Boolean(driver);
  form.reset();
  form.elements.id.value = driver?.id || "";
  form.elements.name.value = driver?.name || "";
  form.elements.phone.value = driver?.phone || "";
  document.querySelector("#driver-modal-title").textContent = editing ? "تعديل بيانات السائق" : "إضافة سائق توصيل";
  document.querySelector("#driver-save-button").textContent = editing ? "حفظ التعديلات" : "حفظ السائق";
  document.querySelector("#driver-delete-button").classList.toggle("hidden", !editing);
  document.querySelector("#driver-modal").classList.remove("hidden");
  form.elements.name.focus();
}

document.querySelector("#user-form").elements.password.addEventListener("input", (event) => {
  event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "");
});

function openExpenseModal() {
  const form = document.querySelector("#expense-form");
  form.reset();
  document.querySelector("#expense-modal").classList.remove("hidden");
  form.elements.name.focus();
}

function closeModal(id) {
  if (id === "product-modal") {
    const form = document.querySelector("#product-form");
    if (form.dataset.previewUrl) URL.revokeObjectURL(form.dataset.previewUrl);
    delete form.dataset.previewUrl;
  }
  document.querySelector(`#${id}`).classList.add("hidden");
}

function updateProductImagePreview(source = "") {
  const preview = document.querySelector("#product-image-preview");
  const image = document.querySelector("#product-image-preview-img");
  const placeholder = document.querySelector("#product-image-preview-empty");
  preview.classList.toggle("hidden", !source);
  image.classList.toggle("hidden", !source);
  placeholder.classList.toggle("hidden", Boolean(source));
  image.src = source;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)));
    reader.addEventListener("error", () => reject(new Error("تعذر قراءة صورة الصنف.")));
    reader.readAsDataURL(file);
  });
}

function updateRestaurantLogoPreview(form, source) {
  const preview = form.querySelector(".restaurant-logo-preview");
  if (!preview) return;
  const image = preview.querySelector(".restaurant-logo-preview-image");
  const placeholder = preview.querySelector(".restaurant-logo-preview-empty");
  const hasImage = Boolean(source);
  image.classList.toggle("hidden", !hasImage);
  placeholder.classList.toggle("hidden", hasImage);
  if (hasImage) image.src = source;
  else image.removeAttribute("src");
  preview.classList.remove("hidden");
}

function validateRestaurantLogoFile(input) {
  const file = input.files[0];
  if (!file) return true;
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 3 * 1024 * 1024) {
    input.value = "";
    showToast("اختر شعارًا بصيغة PNG أو JPG أو WebP بحجم لا يتجاوز 3 ميجابايت.");
    return false;
  }
  return true;
}

function previewRestaurantLogo(form, file) {
  if (form.dataset.logoPreviewUrl) URL.revokeObjectURL(form.dataset.logoPreviewUrl);
  delete form.dataset.logoPreviewUrl;
  if (!file) {
    const currentLogo = form === document.querySelector("#settings-form") && !form.elements.removeLogo.checked
      ? state.restaurant?.logoUrl
      : "";
    updateRestaurantLogoPreview(form, currentLogo || "");
    return;
  }
  form.dataset.logoPreviewUrl = URL.createObjectURL(file);
  updateRestaurantLogoPreview(form, form.dataset.logoPreviewUrl);
}

function openProductModal(product = null) {
  const form = document.querySelector("#product-form");
  if (form.dataset.previewUrl) URL.revokeObjectURL(form.dataset.previewUrl);
  delete form.dataset.previewUrl;
  form.reset();
  updateProductCategorySelect(product?.category || "");
  form.elements.id.value = product?.id || "";
  form.elements.name.value = product?.name || "";
  form.elements.priceSmall.value = product?.sizePrices?.small ?? product?.price ?? "";
  form.elements.priceMedium.value = product?.sizePrices?.medium ?? product?.price ?? "";
  form.elements.priceLarge.value = product?.sizePrices?.large ?? product?.price ?? "";
  form.elements.description.value = product?.description || "";
  form.elements.active.value = String(product?.active ?? true);
  form.dataset.currentImageUrl = product?.imageUrl || "";
  updateProductImagePreview(product?.imageUrl || "");
  document.querySelector("#product-modal-title").textContent = product ? "تعديل بيانات الصنف" : "إضافة صنف للمنيو";
  document.querySelector("#product-modal").classList.remove("hidden");
}

document.querySelector("#login-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector("button[type=submit]");
  button.disabled = true;
  try {
    await signIn(form.elements.username.value.trim(), form.elements.password.value);
    form.reset();
  } catch (error) {
    form.elements.password.value = "";
    showLogin(error.message);
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#setup-form").elements.password.addEventListener("input", (event) => {
  event.currentTarget.value = event.currentTarget.value.replace(/\D/g, "");
});
document.querySelector("#setup-form").elements.logo.addEventListener("change", (event) => {
  const input = event.currentTarget;
  if (!validateRestaurantLogoFile(input)) return previewRestaurantLogo(input.form, null);
  previewRestaurantLogo(input.form, input.files[0]);
});
document.querySelector("#setup-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const logoFile = form.elements.logo.files[0];
    await api("/setup", {
      method: "POST",
      body: JSON.stringify({
        restaurantName: form.elements.restaurantName.value.trim(),
        phone1: form.elements.phone1.value.trim(),
        phone2: form.elements.phone2.value.trim(),
        address: form.elements.address.value.trim(),
        username: form.elements.username.value.trim(),
        password: form.elements.password.value,
        printer: { paperWidthMm: 80 },
        ...(logoFile ? { logoData: await readFileAsDataUrl(logoFile) } : {}),
      }),
    });
    if (form.dataset.logoPreviewUrl) URL.revokeObjectURL(form.dataset.logoPreviewUrl);
    const username = form.elements.username.value.trim();
    const password = form.elements.password.value;
    form.reset();
    await signIn(username, password);
  } catch (error) {
    showSetup(error.message);
  } finally {
    button.disabled = false;
  }
});

const sidebar = document.querySelector("#sidebar");
document.querySelectorAll(".nav-item").forEach((button) => button.addEventListener("click", () => {
  sidebar.classList.add("nav-collapsed");
  button.blur();
  goToPage(button.dataset.page);
}));
sidebar.addEventListener("pointerleave", () => sidebar.classList.remove("nav-collapsed"));
document.querySelector("#mobile-menu").addEventListener("click", () => document.querySelector("#sidebar").classList.toggle("open"));
document.querySelector("#theme-toggle").addEventListener("click", () => {
  applyTheme(state.theme === "dark" ? "light" : "dark");
});
document.querySelector("#help-btn").addEventListener("click", () => {
  document.querySelector("#contact-modal").classList.remove("hidden");
  document.querySelector("#contact-modal-ok").focus();
});
document.querySelector("#contact-modal-ok").addEventListener("click", () => closeModal("contact-modal"));
document.querySelector("#finish-shift-btn").addEventListener("click", finishShift);
document.querySelectorAll("[data-go]").forEach((button) => button.addEventListener("click", () => goToPage(button.dataset.go)));
document.querySelector("#logout-btn").addEventListener("click", async () => {
  try { await api("/auth/logout", { method: "POST", body: "{}" }); } catch (error) { showToast(error.message); }
  showLogin();
});
document.querySelector("#logout-profile").addEventListener("click", () => document.querySelector("#logout-btn").click());
document.querySelector("#product-search").addEventListener("input", (event) => { state.search = event.target.value; renderProducts(); });
document.querySelector("#categories").addEventListener("click", (event) => {
  const button = event.target.closest("[data-category]");
  if (button) { state.category = button.dataset.category; renderProducts(); }
});
document.querySelector("#product-grid").addEventListener("click", (event) => {
  const sizeButton = event.target.closest("[data-select-size]");
  if (sizeButton) {
    const id = Number(sizeButton.dataset.selectSize);
    addToCart(id, sizeButton.dataset.size);
  }
});
document.querySelector(".order-types").addEventListener("click", (event) => {
  const button = event.target.closest("[data-type]");
  if (!button) return;
  const draft = capturePosDraft();
  draft.orderType = button.dataset.type;
  state.drafts = state.drafts.map((entry) => entry.id === state.activeDraftId ? draft : entry);
  restorePosDraft(draft);
});
document.querySelector("#pos-order-tabs").addEventListener("click", (event) => {
  const closeButton = event.target.closest("[data-close-pos-draft]");
  if (closeButton) {
    removePosDraft(Number(closeButton.dataset.closePosDraft));
    return;
  }
  const addButton = event.target.closest("#add-pos-order");
  if (addButton) {
    addPosDraft();
    return;
  }
  const tab = event.target.closest("[data-pos-draft]");
  if (tab) switchPosDraft(Number(tab.dataset.posDraft));
});
document.querySelector("#cart-items").addEventListener("click", (event) => {
  const button = event.target.closest("[data-quantity]");
  if (!button) return;
  const [id, size] = button.dataset.quantity.split(":");
  addToCart(Number(id), size, Number(button.dataset.change));
});
document.querySelector("#clear-cart").addEventListener("click", () => { state.cart.clear(); renderCart(); });
document.querySelector("#checkout-print-btn").addEventListener("click", () => createOrder({ printAfterCreate: true }));
document.querySelector("#order-search").addEventListener("input", renderOrders);
document.querySelector("#order-filter").addEventListener("change", renderOrders);
document.querySelector("#order-report-search").addEventListener("input", renderOrderReport);
["#order-report-type", "#order-report-payment", "#order-report-status"]
  .forEach((selector) => document.querySelector(selector).addEventListener("change", renderOrderReport));
document.querySelector("#order-report-apply").addEventListener("click", () => {
  const from = document.querySelector("#order-report-from").value;
  const to = document.querySelector("#order-report-to").value;
  const fromTime = from ? new Date(from).getTime() : Number.NEGATIVE_INFINITY;
  const toTime = to ? new Date(to).getTime() : Number.POSITIVE_INFINITY;
  if (from && to && fromTime > toTime) {
    showToast("وقت البداية يجب أن يكون قبل وقت النهاية.");
    return;
  }
  state.orderReportRange = { from, to };
  renderOrderReport();
});
document.querySelector("#order-report-clear").addEventListener("click", () => {
  document.querySelector("#order-report-search").value = "";
  document.querySelector("#order-report-type").value = "all";
  document.querySelector("#order-report-payment").value = "all";
  document.querySelector("#order-report-status").value = "all";
  document.querySelector("#order-report-from").value = "";
  document.querySelector("#order-report-to").value = "";
  state.orderReportRange = { from: "", to: "" };
  renderOrderReport();
});
["#orders-table", "#order-report-table"].forEach((selector) => document.querySelector(selector).addEventListener("click", (event) => {
  const detailsButton = event.target.closest("[data-toggle-order-details]");
  if (detailsButton) {
    const detailsRow = detailsButton.closest("tr").nextElementSibling;
    const expanded = detailsButton.getAttribute("aria-expanded") === "true";
    detailsButton.setAttribute("aria-expanded", String(!expanded));
    detailsButton.textContent = expanded ? "⌄" : "⌃";
    detailsRow?.classList.toggle("hidden", expanded);
    return;
  }
}));
document.addEventListener("pointerover", (event) => {
  if (event.target.closest(".order-actions-dropdown.is-portal")) {
    clearTimeout(orderActionsCloseTimer);
    orderActionsCloseTimer = null;
    return;
  }
  const trigger = event.target.closest(".order-actions-trigger");
  if (trigger) openOrderActionsMenuAt(trigger.closest(".order-actions-menu"));
});
document.addEventListener("pointerout", (event) => {
  if (!openOrderActionsMenu) return;
  const trigger = event.target.closest(".order-actions-trigger");
  const dropdown = event.target.closest(".order-actions-dropdown.is-portal");
  if (trigger || dropdown) scheduleOrderActionsClose();
});
document.addEventListener("focusin", (event) => {
  const trigger = event.target.closest(".order-actions-trigger");
  if (trigger) openOrderActionsMenuAt(trigger.closest(".order-actions-menu"));
  else if (event.target.closest(".order-actions-dropdown.is-portal")) {
    clearTimeout(orderActionsCloseTimer);
    orderActionsCloseTimer = null;
  }
});
document.addEventListener("focusout", (event) => {
  if (!event.target.closest(".order-actions-trigger, .order-actions-dropdown.is-portal")) return;
  if (event.relatedTarget?.closest?.(".order-actions-trigger, .order-actions-dropdown.is-portal")) return;
  scheduleOrderActionsClose();
});
document.addEventListener("click", (event) => {
  const trigger = event.target.closest(".order-actions-trigger");
  if (trigger) {
    openOrderActionsMenuAt(trigger.closest(".order-actions-menu"));
    return;
  }
  const assignButton = event.target.closest("[data-assign-order]");
  if (assignButton) {
    const order = findOrder(assignButton.dataset.assignOrder);
    closeOrderActionsMenu();
    if (order) openDriverAssignment(order);
    return;
  }
  const completeButton = event.target.closest("[data-complete-order]");
  if (completeButton) {
    closeOrderActionsMenu();
    void completeTakeawayOrder(completeButton.dataset.completeOrder);
    return;
  }
  const cancelButton = event.target.closest("[data-cancel-order]");
  if (cancelButton) {
    closeOrderActionsMenu();
    openCancelOrder(cancelButton.dataset.cancelOrder);
    return;
  }
  const unassignButton = event.target.closest("[data-unassign-order]");
  if (unassignButton) {
    closeOrderActionsMenu();
    void unassignDriver(unassignButton.dataset.unassignOrder);
    return;
  }
  if (openOrderActionsMenu &&
      !event.target.closest(".order-actions-menu") &&
      !event.target.closest(".order-actions-dropdown.is-portal")) {
    closeOrderActionsMenu();
  }
});
window.addEventListener("scroll", closeOrderActionsMenu, true);
window.addEventListener("resize", closeOrderActionsMenu);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeOrderActionsMenu();
});
document.querySelector("#assign-driver-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-assign-driver]");
  if (!button) return;
  assignDriver(document.querySelector("#assign-driver-list").dataset.orderNumber, Number(button.dataset.assignDriver));
});
document.querySelector("#report-period").addEventListener("change", renderReports);
document.querySelector("#top-products-category").addEventListener("change", renderTopProductsChart);
document.querySelector("#add-expense-open").addEventListener("click", openExpenseModal);
document.querySelector("#expense-close").addEventListener("click", () => closeModal("expense-modal"));
document.querySelector("#expense-cancel").addEventListener("click", () => closeModal("expense-modal"));
document.querySelector("#cancel-order-close").addEventListener("click", () => closeModal("cancel-order-modal"));
document.querySelector("#cancel-order-dismiss").addEventListener("click", () => closeModal("cancel-order-modal"));
document.querySelector("#cancel-order-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    await cancelOrder(form.elements.orderNumber.value, form.elements.reason.value.trim());
    closeModal("cancel-order-modal");
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
});
document.querySelectorAll("[data-close]").forEach((button) => button.addEventListener("click", () => closeModal(button.dataset.close)));
document.querySelectorAll(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => {
  if (event.target === backdrop) closeModal(backdrop.id);
}));
document.querySelector("#expense-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  try {
    await api("/expenses", {
      method: "POST",
      body: JSON.stringify({
        name: String(data.get("name")).trim(),
        amount: Number(data.get("amount")),
        note: String(data.get("note")).trim(),
      }),
    });
    closeModal("expense-modal");
    await renderExpenses();
    showToast("تم تسجيل المصروف بنجاح");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#expense-search").addEventListener("input", renderExpenseTable);
document.querySelector("#archived-expenses-open").addEventListener("click", async () => {
  try {
    await renderArchivedExpenses();
    document.querySelector("#archived-expenses-modal").classList.remove("hidden");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#archived-expense-search").addEventListener("input", renderArchivedExpenseTable);
document.querySelector("#expenses-table").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-expense]");
  if (!button) return;
  try {
    await api(`/expenses/${button.dataset.deleteExpense}`, { method: "DELETE" });
    await renderExpenses();
    showToast("تم حذف المصروف");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#menu-search").addEventListener("input", renderMenu);
document.querySelector("#add-product-open").addEventListener("click", () => openProductModal());
document.querySelector("#manage-product-categories").addEventListener("click", openProductCategoryModal);
document.querySelector("#product-category-cancel-edit").addEventListener("click", resetProductCategoryForm);
document.querySelector("#product-category-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const originalName = form.elements.originalName.value;
  const name = form.elements.name.value.trim();
  try {
    await api(originalName
      ? `/product-categories/${encodeURIComponent(originalName)}`
      : "/product-categories", {
      method: originalName ? "PUT" : "POST",
      body: JSON.stringify({ name }),
    });
    await renderMenu();
    renderProductCategoryList();
    resetProductCategoryForm();
    showToast(originalName ? "تم تعديل الفئة" : "تمت إضافة الفئة");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#product-category-list").addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-category]");
  if (editButton) {
    const form = document.querySelector("#product-category-form");
    form.elements.originalName.value = editButton.dataset.editCategory;
    form.elements.name.value = editButton.dataset.editCategory;
    document.querySelector("#product-category-submit").textContent = "حفظ التعديل";
    document.querySelector("#product-category-cancel-edit").classList.remove("hidden");
    form.elements.name.focus();
    return;
  }
  const deleteButton = event.target.closest("[data-delete-category]");
  if (!deleteButton || !window.confirm(`هل تريد حذف فئة «${deleteButton.dataset.deleteCategory}»؟`)) return;
  try {
    await api(`/product-categories/${encodeURIComponent(deleteButton.dataset.deleteCategory)}`, { method: "DELETE" });
    await renderMenu();
    renderProductCategoryList();
    showToast("تم حذف الفئة");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#menu-table").addEventListener("click", (event) => {
  const editButton = event.target.closest("[data-edit-product]");
  if (editButton) openProductModal(state.products.find((product) => product.id === Number(editButton.dataset.editProduct)));
});
document.querySelector("#product-form").elements.image.addEventListener("change", (event) => {
  const form = document.querySelector("#product-form");
  const file = event.currentTarget.files[0];
  if (!file) {
    updateProductImagePreview(form.dataset.currentImageUrl || "");
    return;
  }
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 3 * 1024 * 1024) {
    event.currentTarget.value = "";
    updateProductImagePreview("");
    showToast("اختر صورة PNG أو JPG أو WebP بحجم لا يتجاوز 3 ميجابايت.");
    return;
  }
  if (form.dataset.previewUrl) URL.revokeObjectURL(form.dataset.previewUrl);
  form.dataset.previewUrl = URL.createObjectURL(file);
  updateProductImagePreview(form.dataset.previewUrl);
});
document.querySelector("#product-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const product = {
    name: form.elements.name.value.trim(),
    category: form.elements.category.value.trim(),
    price: Number(form.elements.priceMedium.value),
    sizePrices: {
      small: Number(form.elements.priceSmall.value),
      medium: Number(form.elements.priceMedium.value),
      large: Number(form.elements.priceLarge.value),
    },
    description: form.elements.description.value.trim(),
    active: form.elements.active.value === "true",
  };
  const id = form.elements.id.value;
  try {
    const imageFile = form.elements.image.files[0];
    if (imageFile) product.imageData = await readFileAsDataUrl(imageFile);
    await api(id ? `/products/${id}` : "/products", { method: id ? "PUT" : "POST", body: JSON.stringify(product) });
    closeModal("product-modal");
    await renderMenu();
    showToast("تم حفظ بيانات الصنف");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#customer-search-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const phone = document.querySelector("#customer-search").value.trim();
  try {
    const result = await api(`/customers?phone=${encodeURIComponent(phone)}`);
    renderCustomerResults(result.customers);
  } catch (error) {
    renderCustomerResults([], error.message);
  }
});
document.querySelector("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    const logoFile = form.elements.logo.files[0];
    if (!validateRestaurantLogoFile(form.elements.logo)) return;
    const result = await api("/settings", {
      method: "PATCH",
      body: JSON.stringify({
        restaurantName: form.elements.restaurantName.value.trim(),
        phone1: form.elements.phone1.value.trim(),
        phone2: form.elements.phone2.value.trim(),
        address: form.elements.address.value.trim(),
        printer: {
          paperWidthMm: Number(form.elements.paperWidthMm.value),
          cashierPrinter: form.elements.cashierPrinter.value,
          secondPrinterEnabled: form.elements.secondPrinterEnabled.checked,
          secondPrinter: form.elements.secondPrinter.value,
        },
        removeLogo: form.elements.removeLogo.checked,
        ...(logoFile ? { logoData: await readFileAsDataUrl(logoFile) } : {}),
      }),
    });
    applyRestaurant(result.settings);
    if (form.dataset.logoPreviewUrl) URL.revokeObjectURL(form.dataset.logoPreviewUrl);
    delete form.dataset.logoPreviewUrl;
    form.elements.logo.value = "";
    form.elements.removeLogo.checked = false;
    form.elements.removeLogo.closest("label").classList.toggle("hidden", !result.settings.logoUrl);
    updateRestaurantLogoPreview(form, result.settings.logoUrl || "");
    showToast("تم حفظ إعدادات المطعم");
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#settings-form").elements.logo.addEventListener("change", (event) => {
  const input = event.currentTarget;
  if (!validateRestaurantLogoFile(input)) return previewRestaurantLogo(input.form, null);
  input.form.elements.removeLogo.checked = false;
  previewRestaurantLogo(input.form, input.files[0]);
});
document.querySelector("#settings-form").elements.removeLogo.addEventListener("change", (event) => {
  if (event.currentTarget.checked) {
    document.querySelector("#settings-form").elements.logo.value = "";
    previewRestaurantLogo(event.currentTarget.form, null);
  } else {
    previewRestaurantLogo(event.currentTarget.form, null);
  }
});
document.querySelector("#settings-form").elements.secondPrinterEnabled.addEventListener("change", (event) => {
  const secondPrinter = document.querySelector("#settings-form").elements.secondPrinter;
  secondPrinter.disabled = !event.currentTarget.checked;
});
document.querySelector("#create-backup").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await api("/backups", { method: "POST", body: "{}" });
    await renderBackups();
    showToast(`تم إنشاء النسخة الاحتياطية (${formatter.format(Math.ceil(result.backup.size / 1024))} كيلوبايت).`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#restore-backup-file").addEventListener("change", async (event) => {
  const input = event.currentTarget;
  const file = input.files[0];
  if (!file) return;
  if (file.size > 512 * 1024 * 1024) {
    showToast("حجم النسخة الاحتياطية يتجاوز الحد المسموح.");
    input.value = "";
    return;
  }
  await submitBackupRestore(file, file.name);
  input.value = "";
});
document.querySelector("#backup-list").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-restore-backup]");
  if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(`/api/backups/${encodeURIComponent(button.dataset.restoreBackup)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) throw new Error("تعذر تنزيل النسخة المحددة للاستعادة.");
    const archive = await response.blob();
    await submitBackupRestore(archive, button.dataset.restoreBackup);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#refresh-printers").addEventListener("click", () => {
  void refreshSystemPrinters();
});
document.querySelector("#customer-results").addEventListener("click", (event) => {
  const button = event.target.closest("[data-customer-phone]");
  if (button) openCustomer(button.dataset.customerPhone);
});
document.querySelector("#add-user-open").addEventListener("click", () => openUserModal());
document.querySelector("#add-driver-open").addEventListener("click", () => {
  openDriverModal();
});
document.querySelector("#edit-driver-open").addEventListener("click", () => {
  const driver = state.drivers.find((entry) => String(entry.id) === state.activeDriverId);
  if (driver) openDriverModal(driver);
});
document.querySelector("#delivery-driver-select").addEventListener("change", async (event) => {
  state.activeDriverId = event.target.value;
  const selected = Boolean(state.activeDriverId);
  document.querySelector("#edit-driver-open").disabled = !selected;
  document.querySelector("#delivery-workspace").classList.toggle("hidden", !selected);
  document.querySelector("#delivery-driver-placeholder").classList.toggle("hidden", selected);
  if (!selected) return;
  try {
    await loadDriverDetails(state.activeDriverId);
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelectorAll("[data-delivery-view]").forEach((button) => button.addEventListener("click", () => {
  const view = button.dataset.deliveryView;
  document.querySelectorAll("[data-delivery-view]").forEach((item) => item.classList.toggle("active", item === button));
  document.querySelector("#delivery-settlements-view").classList.toggle("hidden", view !== "settlements");
  document.querySelector("#delivery-orders-view").classList.toggle("hidden", view !== "orders");
}));
document.querySelector("#delivery-order-search").addEventListener("input", renderDeliveryOrders);
document.querySelector("#delivery-orders-table").addEventListener("click", (event) => {
  const button = event.target.closest("[data-toggle-delivery-details]");
  if (!button) return;
  const detailsRow = button.closest("tr").nextElementSibling;
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  button.textContent = expanded ? "⌄" : "⌃";
  detailsRow?.classList.toggle("hidden", expanded);
});
document.querySelector("#delivery-collection-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!state.activeDriverId || !form.reportValidity()) return;
  try {
    const result = await api(`/delivery-drivers/${encodeURIComponent(state.activeDriverId)}/collections`, {
      method: "POST",
      body: JSON.stringify({ amount: Number(form.elements.amount.value) }),
    });
    form.reset();
    await loadDriverDetails();
    showToast(`تم حفظ تحصيل ${money(result.collection.amount)} بنجاح`);
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#driver-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const id = form.elements.id.value;
  try {
    await api(id ? `/delivery-drivers/${encodeURIComponent(id)}` : "/delivery-drivers", {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify({
        name: form.elements.name.value.trim(),
        phone: form.elements.phone.value.trim(),
      }),
    });
    closeModal("driver-modal");
    await renderDrivers();
    showToast(id ? "تم تحديث بيانات السائق بنجاح" : "تمت إضافة سائق التوصيل بنجاح");
  } catch (error) {
    showToast(error.message);
  }
});
document.querySelector("#driver-delete-button").addEventListener("click", async () => {
  const driverId = document.querySelector("#driver-form").elements.id.value;
  const driver = state.drivers.find((candidate) => String(candidate.id) === driverId);
  if (!driver || !window.confirm(`هل تريد حذف السائق "${driver.name}"؟`)) return;
  const button = document.querySelector("#driver-delete-button");
  button.disabled = true;
  try {
    await api(`/delivery-drivers/${encodeURIComponent(driverId)}`, { method: "DELETE" });
    closeModal("driver-modal");
    await renderDrivers();
    showToast(`تم حذف السائق ${driver.name}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});
document.querySelector("#users-table").addEventListener("click", (event) => {
  if (state.user?.role !== "admin") return;
  const deleteButton = event.target.closest("[data-delete-user]");
  if (deleteButton) {
    const user = state.users.find((candidate) => candidate.id === Number(deleteButton.dataset.deleteUser));
    if (user) void deleteUser(user);
    return;
  }
  const editButton = event.target.closest("[data-edit-user]");
  if (!editButton) return;
  const user = state.users.find((candidate) => candidate.id === Number(editButton.dataset.editUser));
  if (user) openUserModal(user);
});

async function deleteUser(user) {
  if (user.id === state.user?.id) {
    showToast("لا يمكنك حذف حسابك أثناء تسجيل الدخول.");
    return;
  }
  if (!window.confirm(`هل تريد حذف المستخدم "${user.username}"؟`)) return;
  try {
    await api(`/users/${encodeURIComponent(user.id)}`, { method: "DELETE" });
    await renderUsers();
    showToast(`تم حذف المستخدم ${user.username}`);
  } catch (error) {
    showToast(error.message);
  }
}
document.querySelector("#user-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const editing = Boolean(form.elements.id.value);
  const payload = {
    username: form.elements.username.value.trim(),
    role: form.elements.role.value,
    pagePermissions: form.elements.role.value === "cashier"
      ? [...form.querySelectorAll('input[name="pagePermissions"]:checked')].map((input) => input.value)
      : [],
  };
  if (payload.role === "cashier" && payload.pagePermissions.length === 0) {
    showToast("اختر صفحة واحدة على الأقل للحساب.");
    return;
  }
  if (editing) {
    payload.active = form.elements.active.value === "true";
    if (form.elements.password.value) payload.password = form.elements.password.value;
  } else {
    payload.password = form.elements.password.value;
  }
  try {
    await api(editing ? `/users/${encodeURIComponent(form.elements.id.value)}` : "/users", {
      method: editing ? "PATCH" : "POST",
      body: JSON.stringify(payload),
    });
    closeModal("user-modal");
    await renderUsers();
    showToast(editing ? "تم تحديث الحساب بنجاح" : "تم إنشاء الحساب بنجاح");
  } catch (error) {
    showToast(error.message);
  }
});

async function initialize() {
  renderDate();
  try {
    const setup = await api("/setup/status");
    if (setup.needsSetup) {
      showSetup();
      return;
    }
    await loadLoginUsers();
    const result = await api("/auth/me");
    state.user = result.user;
    const restaurant = await api("/restaurant");
    applyRestaurant(restaurant.restaurant);
    document.querySelector("#app-shell").classList.remove("hidden");
    document.querySelector("#setup-screen").classList.add("hidden");
    document.querySelector("#login-screen").classList.add("hidden");
    document.querySelector("#profile-username").textContent = state.user.username;
    document.querySelector("#profile-avatar").textContent = state.user.username.slice(0, 1).toUpperCase();
    document.querySelector("#profile-role").textContent = state.user.role === "admin" ? "مدير النظام" : "كاشير";
    document.querySelectorAll(".admin-only").forEach((element) => element.classList.toggle("hidden", state.user.role !== "admin"));
    updatePageAccess();
    await goToPage(firstAccessiblePage());
    renderCustomerFields();
    renderCart();
    renderPosDraftTabs();
  } catch (error) {
    if (error.message !== "سجّل الدخول للمتابعة." && !error.message.startsWith("انتهت الجلسة")) {
      showLogin("تعذر الاتصال بالخادم. شغّل التطبيق واتصل بقاعدة البيانات ثم أعد تحميل الصفحة.");
    } else {
      showLogin();
    }
  }
}

initialize();
applyTheme();

let orderPageRefreshRunning = false;
setInterval(async () => {
  if (!state.user || !["orders", "order-report"].includes(state.page) || orderPageRefreshRunning) return;
  orderPageRefreshRunning = true;
  try {
    await refreshCurrentOrderPage();
  } catch (error) {
    showToast(error.message);
  } finally {
    orderPageRefreshRunning = false;
  }
}, 15_000);
