/* ============================================================
   FIREBASE-CONFIG.JS  —  Kembang Turi Greenhouse Monitor
   Uses Firebase Modular SDK v12 (ESM via CDN)

   HOW TO USE IN HTML:
     <script type="module" src="firebase-config.js"></script>
     Then in your own module script, import helpers:
       import { writeSensorLog, getUsers, ... } from './firebase-config.js';

   OR use the window.FB bridge (for non-module scripts):
     window.FB.writeSensorLog(suhu, ph)
     window.FB.getUsers()
     etc.
============================================================ */

import { initializeApp }                        from "https://www.gstatic.com/firebasejs/12.14.0/firebase-app.js";
import { getDatabase, ref, push, set, update,
         remove, get, query, orderByChild,
         limitToLast, startAt, endAt,
         onValue, onChildAdded }                from "https://www.gstatic.com/firebasejs/12.14.0/firebase-database.js";
import { getAuth, signInWithEmailAndPassword,
         createUserWithEmailAndPassword,
         signOut, onAuthStateChanged }          from "https://www.gstatic.com/firebasejs/12.14.0/firebase-auth.js";

/* ── Config ── */
const firebaseConfig = {
  apiKey:            "AIzaSyDH6oCPlkJfENGu468i-pNncpsGAGOa_UQ",
  authDomain:        "monitoringgreenhouse-c85cd.firebaseapp.com",
  databaseURL:       "https://monitoringgreenhouse-c85cd-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "monitoringgreenhouse-c85cd",
  storageBucket:     "monitoringgreenhouse-c85cd.firebasestorage.app",
  messagingSenderId: "910282906314",
  appId:             "1:910282906314:web:3daefde044c971e35e3233",
  measurementId:     "G-FC4JNVJWD5"
};

const app  = initializeApp(firebaseConfig);
const db   = getDatabase(app);
const auth = getAuth(app);

console.log("[Firebase] ✓ Connected to:", firebaseConfig.databaseURL);

/* ============================================================
   HELPERS — AUTHENTICATION
   (Dipakai oleh index.html untuk login. akun.html memakai
   secondary app instance-nya sendiri untuk createUser, lihat
   komentar di akun.html.)
============================================================ */

/** Login dengan email & password. Return Firebase user object. */
async function loginUser(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

/** Ambil data profil user (nama, role, dll) dari /users/{uid} */
async function getUserProfile(uid) {
  const snap = await get(ref(db, `users/${uid}`));
  return snap.exists() ? snap.val() : null;
}

/** Sign out user yang sedang login */
async function signOutUser() {
  await signOut(auth);
}

/** Subscribe ke perubahan status login. Returns unsub function. */
function subscribeAuthState(callback) {
  return onAuthStateChanged(auth, callback);
}

/* ============================================================
   DEFAULTS
============================================================ */
const DEFAULT_THRESHOLDS = { suhu_max: 30.0, ph_min: 5.5, ph_max: 6.5 };

/* ============================================================
   HELPERS — SENSOR
============================================================ */

/** Determine status string from sensor values */
function getSensorStatus(suhu, ph, thr = DEFAULT_THRESHOLDS) {
  const sb = suhu > thr.suhu_max;
  const pb = ph < thr.ph_min || ph > thr.ph_max;
  if (sb && pb) return "kritis";
  if (sb)       return "suhu_kritis";
  if (pb)       return "ph_kritis";
  return "normal";
}

/** Write one sensor log entry to Firebase */
async function writeSensorLog(suhu, ph, thr = DEFAULT_THRESHOLDS) {
  const payload = {
    suhu:      parseFloat(suhu.toFixed(1)),
    ph:        parseFloat(ph.toFixed(2)),
    timestamp: Date.now(),
    status:    getSensorStatus(suhu, ph, thr),
  };
  const newRef = await push(ref(db, "log_sensor"), payload);
  return newRef.key;
}

/** Fetch last N sensor logs (newest first) */
async function getRecentLogs(limit = 30) {
  const q    = query(ref(db, "log_sensor"), orderByChild("timestamp"), limitToLast(limit));
  const snap = await get(q);
  const rows = [];
  snap.forEach(c => rows.push({ key: c.key, ...c.val() }));
  return rows.reverse();
}

/** Fetch logs within a timestamp range */
async function getLogsByRange(fromMs, toMs) {
  const q    = query(ref(db, "log_sensor"), orderByChild("timestamp"), startAt(fromMs), endAt(toMs));
  const snap = await get(q);
  const rows = [];
  snap.forEach(c => rows.push({ key: c.key, ...c.val() }));
  return rows.reverse();
}

/**
 * Fetch ALL log_sensor entries with NO orderByChild/query — works even
 * without a ".indexOn": "timestamp" rule configured in Firebase.
 * Converts the Object-of-Objects (push IDs) shape into a plain Array,
 * sorted newest-first. Use this as a safe fallback when getLogsByRange()
 * throws an index-not-defined error.
 */
async function getAllLogsRaw() {
  const snap = await get(ref(db, "log_sensor"));
  if (!snap.exists()) return [];
  const val = snap.val();
  // val is an Object keyed by push-id, e.g. { "-OuX1...": {suhu,ph,timestamp,status}, ... }
  const rows = Object.entries(val).map(([key, v]) => ({ key, ...v }));
  rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)); // newest first
  return rows;
}

/**
 * Client-side range filter — call after getAllLogsRaw() so range
 * queries work without any server-side index.
 */
function filterLogsByRange(rows, fromMs, toMs) {
  return rows.filter(r => typeof r.timestamp === "number" && r.timestamp >= fromMs && r.timestamp <= toMs);
}

/** Subscribe to latest sensor entry in real-time. Returns unsub function. */
function subscribeLatestSensor(callback) {
  const q = query(ref(db, "log_sensor"), orderByChild("timestamp"), limitToLast(1));
  const unsub = onValue(q, snap => {
    snap.forEach(c => callback({ key: c.key, ...c.val() }));
  });
  return unsub;
}

/** Subscribe to new sensor entries (child_added). Returns unsub function. */
function subscribeNewSensor(callback) {
  const q = query(ref(db, "log_sensor"), orderByChild("timestamp"), limitToLast(1));
  const unsub = onChildAdded(q, snap => {
    callback({ key: snap.key, ...snap.val() });
  });
  return unsub;
}

/** Listen to Firebase connection state */
function subscribeConnectionState(callback) {
  onValue(ref(db, ".info/connected"), snap => callback(snap.val() === true));
}

/* ============================================================
   HELPERS — USERS
============================================================ */

/** Get all users once */
async function getUsers() {
  const snap = await get(ref(db, "users"));
  const list = [];
  if (snap.exists()) snap.forEach(c => list.push({ key: c.key, ...c.val() }));
  return list;
}

/** Add a new user. Returns new key. */
async function addUser(data) {
  const payload = {
    nama:      data.nama.trim(),
    username:  data.username.trim().replace(/^@/, ""),
    role:      data.role,
    active:    true,
    createdAt: Date.now(),
  };
  const newRef = await push(ref(db, "users"), payload);
  return newRef.key;
}

/** Update existing user by key */
async function updateUser(key, data) {
  await update(ref(db, `users/${key}`), {
    nama:      data.nama.trim(),
    username:  data.username.trim().replace(/^@/, ""),
    role:      data.role,
    active:    data.active,
    updatedAt: Date.now(),
  });
}

/** Delete user by key */
async function deleteUser(key) {
  await remove(ref(db, `users/${key}`));
}

/* ============================================================
   HELPERS — THRESHOLDS
============================================================ */

/** Get thresholds from Firebase */
async function getThresholds() {
  const snap = await get(ref(db, "thresholds"));
  return snap.exists() ? snap.val() : { ...DEFAULT_THRESHOLDS };
}

/** Save thresholds to Firebase */
async function saveThresholds(data) {
  await update(ref(db, "thresholds"), {
    suhu_max:  parseFloat(data.suhu_max),
    ph_min:    parseFloat(data.ph_min),
    ph_max:    parseFloat(data.ph_max),
    updatedAt: Date.now(),
  });
}

/**
 * Subscribe real-time ke perubahan thresholds di Firebase.
 * Callback dipanggil segera dengan nilai saat ini, dan setiap
 * kali admin menyimpan perubahan parameter dari parameter.html.
 * Returns unsub function.
 */
function subscribeThresholds(callback) {
  return onValue(ref(db, "thresholds"), snap => {
    callback(snap.exists() ? { ...DEFAULT_THRESHOLDS, ...snap.val() } : { ...DEFAULT_THRESHOLDS });
  });
}

/* ============================================================
   HELPERS — WHATSAPP ALERT (Fonnte Gateway)
============================================================ */

/* ────────────────────────────────────────────────────────────
   PETUNJUK: Ganti nilai di bawah ini dengan API Token Fonnte
   kamu sendiri. Dapatkan token dari dashboard Fonnte:
   https://md.fonnte.com/  →  menu "Device" → salin "Token".

   ⚠️ Catatan keamanan: token ini akan terlihat oleh siapa saja
   yang membuka DevTools / view-source di browser, karena kode
   ini berjalan di client-side. Untuk produksi, sebaiknya
   panggilan ke Fonnte dipindah ke backend/Cloud Function agar
   token tidak terekspos publik. Untuk skala tugas/proyek kuliah
   ini, pendekatan client-side berikut sudah cukup.
──────────────────────────────────────────────────────────── */
const FONNTE_API_TOKEN = "1dPHojRFzmqKuBhgV3oY"; // ← ISI TOKEN DI SINI
const FONNTE_ENDPOINT  = "https://api.fonnte.com/send";

/* ── Daftar role yang berhak menerima notifikasi WhatsApp ──
   Pencocokan dilakukan secara case-insensitive di dalam sendWhatsAppAlert()
   agar tidak gagal karena perbedaan kapitalisasi ("Asisten" vs "asisten"). */
const WA_TARGET_ROLES_NORMALIZED = new Set([
  "pekerja lahan",
  "pekerja",
  "asisten kebun",
  "asisten",
]);

/**
 * Kirim pesan WhatsApp peringatan ke semua user dengan role yang sesuai
 * dan memiliki no_hp tersimpan di /users/{uid}.
 *
 * @param {string} pesan  Isi pesan peringatan yang akan dikirim.
 * @returns {Promise<{sent:number, targets:string[]}>}
 */
async function sendWhatsAppAlert(pesan) {
  console.log("[WA] ══════════════════════════════════════");
  console.log("[WA] 🚀 sendWhatsAppAlert() dipanggil");
  console.log("[WA] Isi pesan:", pesan);

  // ── Guard: token belum diisi ──
  if (!FONNTE_API_TOKEN || FONNTE_API_TOKEN === "GANTI_DENGAN_TOKEN_FONNTE_ANDA") {
    console.warn("[WA] ⚠ FONNTE_API_TOKEN belum diisi — alert tidak dikirim.");
    return { sent: 0, targets: [] };
  }
  console.log("[WA] ✓ Token Fonnte:", FONNTE_API_TOKEN.slice(0, 4) + "****");

  // ── 1. Ambil data user ──
  console.log("[WA] Mengambil data user dari Firebase /users ...");
  let users = [];
  try {
    users = await getUsers();
  } catch (e) {
    console.error("[WA] ❌ Gagal mengambil data user:", e.message);
    throw e;
  }
  console.log(`[WA] Total user di database: ${users.length}`, users);

  // ── 2. Filter role & no_hp ──
  console.log("[WA] Memulai filter role & no_hp ...");
  const filtered = users.filter(u => {
    const roleNorm = (u.role || "").trim().toLowerCase();
    const roleOk   = roleNorm.includes("pekerja") || roleNorm.includes("asisten");
    const hpRaw    = typeof u.no_hp === "string" ? u.no_hp : "";
    const hpOk     = hpRaw.trim().length >= 10;

    console.log(
      `[WA] User: "${u.nama}" | role="${u.role}" → norm="${roleNorm}" → roleOk=${roleOk} | ` +
      `no_hp="${hpRaw}" → hpOk=${hpOk}`
    );
    return roleOk && hpOk;
  });

  console.log(`[WA] User lolos filter: ${filtered.length}`, filtered.map(u => ({ nama: u.nama, role: u.role, no_hp: u.no_hp })));

  // ── 3. Sanitasi nomor HP ──
  const targets = filtered.map(u => {
    let hp = u.no_hp
      .replace(/\s/g, "")   // hapus semua spasi
      .replace(/-/g, "")    // hapus strip
      .replace(/\+/g, "");  // hapus tanda plus

    if (hp.startsWith("0")) {
      hp = "62" + hp.slice(1); // "0812..." → "62812..."
    }

    console.log(`[WA] Sanitasi no_hp: "${u.no_hp}" → "${hp}"`);
    return hp;
  });

  // ── 4. Guard: tidak ada target ──
  if (targets.length === 0) {
    console.error("[Fonnte] Batal kirim: Tidak ada nomor HP pekerja/asisten yang valid di database!");
    return { sent: 0, targets: [] };
  }

  const targetString = targets.join(",");
  console.log(`[WA] Target final (${targets.length} nomor): ${targetString}`);

  // ── 5. Kirim ke Fonnte via FormData ──
  // PENTING: JANGAN set Content-Type manual — biarkan browser isi otomatis
  // sebagai multipart/form-data dengan boundary yang benar.
  const formData = new FormData();
  formData.append("target",  targetString);
  formData.append("message", pesan);

  console.log("[WA] Mengirim request ke Fonnte:", FONNTE_ENDPOINT);
  try {
    const response = await fetch(FONNTE_ENDPOINT, {
      method:  "POST",
      headers: { "Authorization": FONNTE_API_TOKEN }, // ← HANYA ini, tanpa Content-Type
      body:    formData,
    });

    console.log("[WA] HTTP Status:", response.status, response.statusText);

    const res = await response.json();
    console.log("[Fonnte Success]:", res);

    console.log(`[WA] ✓ Selesai — pesan terkirim ke ${targets.length} penerima.`);
    console.log("[WA] ══════════════════════════════════════");
    return { sent: targets.length, targets };

  } catch (error) {
    console.error("[Fonnte Catch Error]:", error);
    throw error;
  }
}

/* ============================================================
   HELPERS — AGGREGATION / REPORT
============================================================ */

function _avg(arr) {
  if (!arr.length) return 0;
  return parseFloat((arr.reduce((s, v) => s + v, 0) / arr.length).toFixed(2));
}

/** Group log rows by date (WIB UTC+7), return daily summaries */
function aggregateByDay(rows) {
  const map = {};
  rows.forEach(r => {
    const wib = new Date(r.timestamp + 7 * 3600 * 1000);
    const key = wib.toISOString().slice(0, 10);
    if (!map[key]) map[key] = { date: key, suhuList: [], phList: [], alerts: 0 };
    map[key].suhuList.push(r.suhu);
    map[key].phList.push(r.ph);
    if (r.status !== "normal") map[key].alerts++;
  });
  return Object.values(map).map(d => ({
    date:      d.date,
    suhuAvg:   _avg(d.suhuList),
    suhuMax:   Math.max(...d.suhuList),
    suhuMin:   Math.min(...d.suhuList),
    suhuRange: `${Math.min(...d.suhuList).toFixed(1)} – ${Math.max(...d.suhuList).toFixed(1)}`,
    phAvg:     _avg(d.phList),
    alerts:    d.alerts,
    status:    d.alerts === 0 ? "normal" : (d.alerts <= 2 ? "warning" : "critical"),
  })).sort((a, b) => b.date.localeCompare(a.date));
}

function computeSummary(rows) {
  if (!rows.length) return { avgSuhu: 0, avgPh: 0, totalAlerts: 0 };
  return {
    avgSuhu:     _avg(rows.map(r => r.suhu)),
    avgPh:       _avg(rows.map(r => r.ph)),
    totalAlerts: rows.filter(r => r.status !== "normal").length,
  };
}

/* ============================================================
   DATE UTILS
============================================================ */
function todayISO()    { return new Date(Date.now() + 7*3600*1000).toISOString().slice(0,10); }
function daysAgoISO(n) { return new Date(Date.now() + 7*3600*1000 - n*86400000).toISOString().slice(0,10); }
function formatDateLabel(iso) {
  return new Date(iso + "T00:00:00+07:00")
    .toLocaleDateString("id-ID", { weekday:"short", day:"numeric", month:"short", timeZone:"Asia/Jakarta" });
}
function formatDateTime(ms) {
  return new Date(ms).toLocaleString("id-ID", {
    timeZone:"Asia/Jakarta", day:"2-digit", month:"short", year:"numeric", hour:"2-digit", minute:"2-digit"
  });
}

/* ============================================================
   SIMULATOR  (writes fake data to Firebase every N ms)
============================================================ */
let _simTimer   = null;
let _simSuhu    = 28.5;
let _simPh      = 6.0;
let _simThr     = { ...DEFAULT_THRESHOLDS };
let _thrUnsub   = null; // listener unsubscribe handle

/**
 * Aktifkan listener real-time pada node /thresholds.
 * Setiap kali admin mengubah parameter dari parameter.html,
 * _simThr langsung diperbarui tanpa perlu restart simulator.
 */
function _startThresholdListener() {
  if (_thrUnsub) return; // sudah aktif
  _thrUnsub = onValue(ref(db, "thresholds"), snap => {
    if (snap.exists()) {
      _simThr = { ...DEFAULT_THRESHOLDS, ...snap.val() };
      console.log("[Simulator] ↺ Threshold diperbarui dari Firebase:", _simThr);
    }
  });
}

function _stopThresholdListener() {
  if (_thrUnsub) {
    _thrUnsub();
    _thrUnsub = null;
  }
}

/* ── Cooldown Anti-Spam WhatsApp ──────────────────────────────
   Variabel ini mencatat kapan terakhir kali alert WA dikirim.
   Gunakan nilai 0 agar pengiriman pertama selalu lolos.

   WA_ALERT_COOLDOWN_MS = durasi cooldown dalam milidetik.
   Default: 30 menit (1.800.000 ms).
   Ubah ke 60000 (1 menit) untuk pengujian di laptop.
──────────────────────────────────────────────────────────── */
let lastAlertTime = 0;

const WA_ALERT_COOLDOWN_MS = 60000; // GANTI UNTUK TESTING → 60000 (1 menit) saat uji coba 1800000

async function startSimulator(intervalMs = 5000) {
  // Aktifkan listener real-time — _simThr akan selalu sinkron dengan Firebase
  _startThresholdListener();
  await _doSimWrite();                        // immediate first write
  _simTimer = setInterval(_doSimWrite, intervalMs);
  console.log(`[Simulator] ▶ started (every ${intervalMs / 1000}s)`);
}

function stopSimulator() {
  clearInterval(_simTimer);
  _simTimer = null;
  _stopThresholdListener();
  console.log("[Simulator] ■ stopped");
}

async function _doSimWrite() {
  // 1. Generate nilai sensor baru (simulasi perubahan gradual)
  _simSuhu = Math.min(33, Math.max(24, _simSuhu + (Math.random() - 0.45) * 0.7));
  _simPh   = Math.min(7.5, Math.max(4.8, _simPh  + (Math.random() - 0.5)  * 0.09));

  // 2. Tulis ke Firebase
  try {
    await writeSensorLog(_simSuhu, _simPh, _simThr);
  } catch (e) {
    console.warn("[Simulator] Gagal menulis ke Firebase:", e.message);
  }

  // 3. Periksa apakah nilai melampaui ambang batas
  const suhuLewatBatas = _simSuhu > _simThr.suhu_max;
  const phLewatBatas   = _simPh < _simThr.ph_min || _simPh > _simThr.ph_max;

  console.log(
    `[Simulator] Suhu=${_simSuhu.toFixed(1)} (max=${_simThr.suhu_max}, lewat=${suhuLewatBatas}) | ` +
    `pH=${_simPh.toFixed(2)} (min=${_simThr.ph_min}, max=${_simThr.ph_max}, lewat=${phLewatBatas})`
  );

  if (!suhuLewatBatas && !phLewatBatas) {
    // Kondisi normal — tidak ada yang perlu dilakukan
    return;
  }

  console.log("[Simulator] ⚠ Mendeteksi bahaya, menyiapkan WA...");

  // 4. Ada pelanggaran ambang batas → cek cooldown
  const now           = Date.now();
  const sisaCooldown  = WA_ALERT_COOLDOWN_MS - (now - lastAlertTime);

  if (sisaCooldown > 0) {
    const detikSisa = Math.ceil(sisaCooldown / 1000);
    console.log(`[Simulator] ⏳ WA masih cooldown — sisa ${detikSisa} detik. Alert dilewati.`);
    return;
  }

  // 5. Cooldown sudah lewat → tandai waktu SEBELUM await (cegah race condition)
  lastAlertTime = now;
  console.log("[Simulator] ✅ Cooldown sudah lewat — melanjutkan pengiriman WA.");

  // 6. Susun teks pesan peringatan yang informatif
  const baris = [];
  if (suhuLewatBatas) {
    baris.push(`🌡️ Suhu: ${_simSuhu.toFixed(1)}°C (Maks: ${_simThr.suhu_max}°C)`);
  }
  if (phLewatBatas) {
    const keterangan = _simPh < _simThr.ph_min ? "terlalu rendah" : "terlalu tinggi";
    baris.push(`💧 pH: ${_simPh.toFixed(2)} (${keterangan}, batas aman: ${_simThr.ph_min}–${_simThr.ph_max})`);
  }

  const pesan =
    `⚠️ PERINGATAN KEMBANG TURI ⚠️\n` +
    `Kondisi Greenhouse di luar batas!\n\n` +
    baris.join("\n") + "\n\n" +
    `Segera cek lokasi!\n` +
    `Waktu: ${formatDateTime(now)}`;

  // 7. Kirim notifikasi WhatsApp
  try {
    console.log("[Simulator] Memanggil sendWhatsAppAlert()...");
    const result = await sendWhatsAppAlert(pesan);
    if (result.sent > 0) {
      console.log(`[Simulator] ✓ Alert WA berhasil terkirim ke ${result.sent} penerima. Cooldown ${WA_ALERT_COOLDOWN_MS / 1000}s dimulai.`);
    } else {
      console.warn("[Simulator] ⚠ sendWhatsAppAlert() selesai tapi 0 penerima (cek filter role & no_hp di atas).");
    }
  } catch (e) {
    // Jika pengiriman gagal, reset lastAlertTime agar bisa dicoba lagi di siklus berikutnya
    lastAlertTime = 0;
    console.error("[Simulator] ❌ Gagal mengirim alert WhatsApp:", e.message, e);
  }
}

/* ============================================================
   WINDOW BRIDGE  (lets non-module <script> tags call these)
   Usage:  window.FB.getUsers().then(...)
============================================================ */
window.FB = {
  db, auth, firebaseConfig, DEFAULT_THRESHOLDS,
  writeSensorLog, getRecentLogs, getLogsByRange, getAllLogsRaw, filterLogsByRange,
  subscribeLatestSensor, subscribeNewSensor, subscribeConnectionState,
  getUsers, addUser, updateUser, deleteUser,
  getThresholds, saveThresholds, subscribeThresholds,
  sendWhatsAppAlert,
  aggregateByDay, computeSummary,
  todayISO, daysAgoISO, formatDateLabel, formatDateTime,
  startSimulator, stopSimulator,
  getSensorStatus,
  loginUser, getUserProfile, signOutUser, subscribeAuthState,
};

console.log("[Firebase] ✓ window.FB bridge ready");
