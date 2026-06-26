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

   ARSITEKTUR ALERT (Pemisahan Tanggung Jawab):
   ┌────────────────────────────────────────────────────────────────┐
   │  simulator.html → startSimulator()                             │
   │    └─ _doSimWrite() → push ke /log_sensor SAJA                │
   │                       (TIDAK ada logika kirim WA di sini)     │
   │                                                                │
   │  dashboard.html → startAlertMonitor()                         │
   │    └─ onValue /log_sensor → _evaluateAndSendAlert(data)       │
   │         ├─ Guard A: skip data historis (timestamp)            │
   │         ├─ Guard B: skip jika kondisi normal                  │
   │         └─ Guard C: Global Cooldown via /system/last_wa_sent  │
   │              ├─ get() → baca kapan WA terakhir dikirim        │
   │              ├─ jika < 1 jam → log & return                   │
   │              ├─ set() → KLAIM cooldown (sebelum fetch Fonnte) │
   │              └─ sendWhatsAppAlert(pesan)                      │
   └────────────────────────────────────────────────────────────────┘

   Keuntungan Global Cooldown:
   • 5 user buka dashboard bersamaan → tetap hanya 1 WA per jam
   • Buka/tutup tab → tidak spam (timestamp guard)
   • Simulator push data → AlertMonitor yang handle, bukan simulator
   • Cooldown persist meski semua tab ditutup lalu dibuka lagi
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
 * Fetch ALL log_sensor entries — fallback aman tanpa .indexOn rule.
 * Returns array sorted newest-first.
 */
async function getAllLogsRaw() {
  const snap = await get(ref(db, "log_sensor"));
  if (!snap.exists()) return [];
  const val  = snap.val();
  const rows = Object.entries(val).map(([key, v]) => ({ key, ...v }));
  rows.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  return rows;
}

/** Client-side range filter setelah getAllLogsRaw() */
function filterLogsByRange(rows, fromMs, toMs) {
  return rows.filter(r => typeof r.timestamp === "number" && r.timestamp >= fromMs && r.timestamp <= toMs);
}

/** Subscribe to latest sensor entry in real-time. Returns unsub function. */
function subscribeLatestSensor(callback) {
  const q    = query(ref(db, "log_sensor"), orderByChild("timestamp"), limitToLast(1));
  const unsub = onValue(q, snap => {
    snap.forEach(c => callback({ key: c.key, ...c.val() }));
  });
  return unsub;
}

/** Subscribe to new sensor entries (child_added). Returns unsub function. */
function subscribeNewSensor(callback) {
  const q    = query(ref(db, "log_sensor"), orderByChild("timestamp"), limitToLast(1));
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

/**
 * Get all users dari /users.
 * Menangani dua kemungkinan struktur key:
 *   - Auth UID  (akun.html baru: set ref "users/{uid}")
 *   - Push ID   (addUser() lama: push ke "users")
 * Field no_hp dinormalisasi ke string meski tersimpan sebagai number.
 */
async function getUsers() {
  console.log("[getUsers] Mengambil /users dari Firebase...");
  const snap = await get(ref(db, "users"));

  if (!snap.exists()) {
    console.warn("[getUsers] Node /users tidak ditemukan atau kosong.");
    return [];
  }

  const list = [];
  snap.forEach(child => {
    const val = child.val();
    if (!val || typeof val !== "object") return;

    let rawHp = val.no_hp;
    if (rawHp === undefined || rawHp === null) rawHp = "";
    rawHp = String(rawHp).trim();

    list.push({
      key:       child.key,
      uid:       child.key,
      username:  val.username  || "",
      email:     val.email     || "",
      nama:      val.nama      || val.username || val.email || child.key,
      role:      val.role      || "",
      no_hp:     rawHp,
      active:    val.active    !== undefined ? val.active : true,
      createdAt: val.createdAt || 0,
    });
  });

  console.log(`[getUsers] ✓ ${list.length} user ditemukan:`, list.map(u => ({
    key: u.key, nama: u.nama, role: u.role, no_hp: u.no_hp
  })));
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
 * Returns unsub function.
 */
function subscribeThresholds(callback) {
  return onValue(ref(db, "thresholds"), snap => {
    callback(snap.exists() ? { ...DEFAULT_THRESHOLDS, ...snap.val() } : { ...DEFAULT_THRESHOLDS });
  });
}

/* ============================================================
   HELPERS — WHATSAPP ALERT (Fonnte Gateway)

   Fungsi ini MURNI mengirim pesan ke Fonnte.
   TIDAK ada logika cooldown, threshold, atau evaluasi di sini.
   Semua keputusan "kapan kirim" ada di _evaluateAndSendAlert().

   ⚠️ Catatan keamanan: token terekspos di client-side.
   Untuk produksi, pindahkan ke backend / Cloud Function.
   Untuk skala proyek kuliah ini, pendekatan ini sudah cukup.
============================================================ */

const FONNTE_API_TOKEN = "1dPHojRFzmqKuBhgV3oY"; // ← ISI TOKEN DI SINI
const FONNTE_ENDPOINT  = "https://api.fonnte.com/send";

/**
 * Kirim pesan WhatsApp ke semua user pekerja/asisten yang punya no_hp.
 *
 * @param {string} pesan  Isi pesan peringatan.
 * @returns {Promise<{sent:number, targets:string[]}>}
 */
async function sendWhatsAppAlert(pesan) {
  console.log("[WA] ══════════════════════════════════════");
  console.log("[WA] 🚀 sendWhatsAppAlert() dipanggil");
  console.log("[WA] Isi pesan:", pesan);

  if (!FONNTE_API_TOKEN || FONNTE_API_TOKEN === "GANTI_DENGAN_TOKEN_FONNTE_ANDA") {
    console.warn("[WA] ⚠ FONNTE_API_TOKEN belum diisi — alert tidak dikirim.");
    return { sent: 0, targets: [] };
  }
  console.log("[WA] ✓ Token Fonnte:", FONNTE_API_TOKEN.slice(0, 4) + "****");

  let users = [];
  try {
    users = await getUsers();
  } catch (e) {
    console.error("[WA] ❌ Gagal mengambil data user:", e.message);
    throw e;
  }
  console.log(`[WA] Total user di database: ${users.length}`);

  if (users.length === 0) {
    console.warn("[WA] ⚠ Tidak ada user ditemukan di /users.");
    return { sent: 0, targets: [] };
  }

  const filtered = users.filter(u => {
    const roleNorm = (u.role || "").trim().toLowerCase();
    const roleOk   = roleNorm.includes("pekerja") || roleNorm.includes("asisten");
    const hpRaw    = u.no_hp || "";
    const hpOk     = hpRaw.replace(/[\s\-\+]/g, "").length >= 9;
    console.log(
      `[WA] User: "${u.nama}" | role="${u.role}" → norm="${roleNorm}" → roleOk=${roleOk} | ` +
      `no_hp="${hpRaw}" → hpOk=${hpOk} | active=${u.active}`
    );
    return roleOk && hpOk;
  });

  console.log(`[WA] User lolos filter: ${filtered.length}`, filtered.map(u => ({ nama: u.nama, role: u.role, no_hp: u.no_hp })));

  const targets = filtered.map(u => {
    let hp = u.no_hp.replace(/\s/g, "").replace(/-/g, "").replace(/\+/g, "");
    if (hp.startsWith("0")) hp = "62" + hp.slice(1);
    console.log(`[WA] Sanitasi no_hp: "${u.no_hp}" → "${hp}"`);
    return hp;
  });

  if (targets.length === 0) {
    console.error("[Fonnte] Batal kirim: tidak ada nomor HP pekerja/asisten yang valid!");
    return { sent: 0, targets: [] };
  }

  const targetString = targets.join(",");
  console.log(`[WA] Target final (${targets.length} nomor): ${targetString}`);

  const formData = new FormData();
  formData.append("target",  targetString);
  formData.append("message", pesan);

  console.log("[WA] Mengirim request ke Fonnte:", FONNTE_ENDPOINT);
  try {
    const response = await fetch(FONNTE_ENDPOINT, {
      method:  "POST",
      headers: { "Authorization": FONNTE_API_TOKEN },
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
   SIMULATOR  —  Hanya menulis data sensor ke Firebase.
                 TIDAK ADA logika kirim WA di sini.

   Tanggung jawab simulator = push angka ke /log_sensor.
   Tanggung jawab AlertMonitor = evaluasi angka itu & kirim WA.

   Dengan pemisahan ini:
   • simulator.html bisa dibuka kapan saja tanpa risiko spam WA.
   • Tidak ada cooldown ganda / konflik antar komponen.
============================================================ */

let _simTimer = null;
let _simSuhu  = 28.5;
let _simPh    = 6.0;
let _simThr   = { ...DEFAULT_THRESHOLDS };
let _thrUnsub = null;

function _startThresholdListener() {
  if (_thrUnsub) return;
  _thrUnsub = onValue(ref(db, "thresholds"), snap => {
    if (snap.exists()) {
      _simThr = { ...DEFAULT_THRESHOLDS, ...snap.val() };
      console.log("[Simulator] ↺ Threshold diperbarui dari Firebase:", _simThr);
    }
  });
}

function _stopThresholdListener() {
  if (_thrUnsub) { _thrUnsub(); _thrUnsub = null; }
}

async function startSimulator(intervalMs = 5000) {
  _startThresholdListener();
  await _doSimWrite();
  _simTimer = setInterval(_doSimWrite, intervalMs);
  console.log(`[Simulator] ▶ started (every ${intervalMs / 1000}s) — hanya tulis data sensor, tidak kirim WA`);
}

function stopSimulator() {
  clearInterval(_simTimer);
  _simTimer = null;
  _stopThresholdListener();
  console.log("[Simulator] ■ stopped");
}

/**
 * Tulis satu entry sensor ke Firebase. Hanya ini, tidak lebih.
 * AlertMonitor di dashboard.html yang mendeteksi entry ini
 * dan memutuskan apakah WA perlu dikirim.
 */
async function _doSimWrite() {
  _simSuhu = Math.min(33, Math.max(24, _simSuhu + (Math.random() - 0.45) * 0.7));
  _simPh   = Math.min(7.5, Math.max(4.8, _simPh  + (Math.random() - 0.5)  * 0.09));

  try {
    await writeSensorLog(_simSuhu, _simPh, _simThr);
  } catch (e) {
    console.warn("[Simulator] Gagal menulis ke Firebase:", e.message);
  }

  const suhuLewat = _simSuhu > _simThr.suhu_max;
  const phLewat   = _simPh < _simThr.ph_min || _simPh > _simThr.ph_max;
  console.log(
    `[Simulator] Suhu=${_simSuhu.toFixed(1)} (max=${_simThr.suhu_max}, lewat=${suhuLewat}) | ` +
    `pH=${_simPh.toFixed(2)} (min=${_simThr.ph_min}, max=${_simThr.ph_max}, lewat=${phLewat})`
  );
  // Selesai. Tidak ada kode WA di bawah ini.
  // AlertMonitor di dashboard.html yang mengurus evaluasi & pengiriman.
}

/* ============================================================
   GLOBAL COOLDOWN — disimpan di Firebase RTDB /system/last_wa_sent

   MENGAPA DI FIREBASE, BUKAN VARIABEL JS LOKAL?
   ─────────────────────────────────────────────
   Variabel JS lokal hanya hidup di satu tab browser.
   Jika N user buka dashboard bersamaan → N variabel lokal yang
   masing-masing bernilai 0 → N WA dikirim untuk 1 event yang sama.

   Dengan menyimpan timestamp di Firebase RTDB:
   ✓ Semua tab & semua user baca/tulis ke node yang SAMA
   ✓ Hanya 1 WA per jam, berapapun user aktif
   ✓ Cooldown persist meski semua tab ditutup lalu dibuka lagi
   ✓ Jika pengiriman gagal, timestamp di-reset ke 0 → retry otomatis

   Path : /system/last_wa_sent  (Unix ms, integer)
   Nilai: 0 = belum pernah kirim / cooldown di-reset
============================================================ */

const WA_COOLDOWN_MS   = 3600000;              // 1 jam penuh — jangan ubah sembarangan
const COOLDOWN_FB_PATH = "system/last_wa_sent"; // path di RTDB

/**
 * Baca timestamp terakhir WA dikirim dari Firebase.
 * Return 0 jika belum pernah ada atau terjadi error baca.
 */
async function _getGlobalLastSent() {
  try {
    const snap = await get(ref(db, COOLDOWN_FB_PATH));
    return snap.exists() ? (snap.val() || 0) : 0;
  } catch (e) {
    console.warn("[Cooldown] Gagal baca dari Firebase:", e.message, "— anggap 0 (aman lanjut).");
    return 0;
  }
}

/**
 * Tulis timestamp ke Firebase sebagai klaim cooldown.
 * Dipanggil SEBELUM fetch ke Fonnte — ini adalah "optimistic lock"
 * yang mencegah tab/user lain mengirim WA dalam selang waktu dekat.
 * Pass 0 untuk reset (saat pengiriman gagal / 0 penerima).
 */
async function _setGlobalLastSent(timestampMs) {
  try {
    await set(ref(db, COOLDOWN_FB_PATH), timestampMs);
  } catch (e) {
    console.warn("[Cooldown] Gagal tulis ke Firebase:", e.message);
  }
}

/* ============================================================
   ALERT MONITOR  —  Pemantau real-time + trigger WA global

   Gunakan di dashboard.html:
     window.FB.startAlertMonitor();   // saat Firebase siap
     window.FB.stopAlertMonitor();    // opsional saat unload

   Alur lengkap setiap kali data sensor baru masuk:
   1. Guard A: apakah data ini BARU (timestamp > listenerStart)?
      → Tidak: abaikan (cegah spam saat halaman pertama dibuka)
   2. Guard B: apakah ada parameter yang melampaui batas?
      → Tidak: tidak ada tindakan
   3. Guard C: apakah cooldown global sudah lewat 1 jam?
      → Belum: log "masih dalam global cooldown 1 jam" & return
   4. Klaim cooldown: tulis now ke /system/last_wa_sent
      (tab/user lain yang masuk Guard C dalam selang detik yang sama
       akan membaca nilai ini dan masuk cooldown)
   5. Kirim WA via sendWhatsAppAlert()
      → Gagal / 0 penerima: reset /system/last_wa_sent ke 0
============================================================ */

let _alertMonitorUnsub  = null; // unsub fungsi sensor listener
let _alertThrUnsub      = null; // unsub fungsi threshold listener
let _alertThr           = { ...DEFAULT_THRESHOLDS };
let _alertListenerStart = 0;    // timestamp kapan listener dipasang

/**
 * Mulai monitor alert WA berbasis Firebase real-time listener.
 * Aman dipanggil berkali-kali — hanya aktifkan sekali.
 */
function startAlertMonitor() {
  if (_alertMonitorUnsub) {
    console.log("[AlertMonitor] Sudah aktif, skip.");
    return;
  }

  // Catat waktu SEBELUM subscribe.
  // Semua data dengan timestamp ≤ nilai ini dianggap historis → diabaikan (Guard A).
  // Ini mencegah spam saat halaman pertama dibuka karena Firebase onValue
  // selalu mengirim snapshot data yang sudah ada di DB (bukan hanya data baru).
  _alertListenerStart = Date.now();
  console.log("[AlertMonitor] ⏱ Listener mulai:", new Date(_alertListenerStart).toLocaleTimeString("id-ID"));

  // [1] Sinkronkan threshold secara real-time
  _alertThrUnsub = onValue(ref(db, "thresholds"), snap => {
    _alertThr = snap.exists()
      ? { ...DEFAULT_THRESHOLDS, ...snap.val() }
      : { ...DEFAULT_THRESHOLDS };
    console.log("[AlertMonitor] ↺ Threshold diperbarui:", _alertThr);
  });

  // [2] Pantau entry sensor terbaru — onValue terpicu tiap ada update baru
  const q = query(ref(db, "log_sensor"), orderByChild("timestamp"), limitToLast(1));
  _alertMonitorUnsub = onValue(q, snap => {
    snap.forEach(child => {
      _evaluateAndSendAlert({ key: child.key, ...child.val() });
    });
  });

  console.log("[AlertMonitor] ▶ Aktif — global cooldown 1 jam via /system/last_wa_sent");
}

/** Hentikan alert monitor dan bersihkan semua listener */
function stopAlertMonitor() {
  if (_alertMonitorUnsub) { _alertMonitorUnsub(); _alertMonitorUnsub = null; }
  if (_alertThrUnsub)     { _alertThrUnsub();     _alertThrUnsub     = null; }
  _alertListenerStart = 0;
  console.log("[AlertMonitor] ■ dihentikan.");
}

/**
 * Evaluasi satu entry sensor. Kirim WA hanya jika ketiga guard lolos.
 *
 * Guard A — Timestamp guard (anti spam saat halaman load)
 * Guard B — Threshold check (hanya kirim jika ada yang kritis)
 * Guard C — Global cooldown via Firebase (anti spam multi-client)
 *
 * @param {{suhu:number, ph:number, timestamp:number, key:string}} data
 */
async function _evaluateAndSendAlert(data) {
  if (typeof data.suhu !== "number" || typeof data.ph !== "number") return;

  // ── Guard A: Skip data historis ───────────────────────────────────────
  // Firebase onValue selalu mengirim snapshot data terakhir saat listener
  // dipasang (termasuk saat refresh halaman). Data itu bisa jam lalu tapi
  // masih melebihi threshold → spam.
  // Fix: hanya proses data yang timestamp-nya lebih baru dari listenerStart.
  if (_alertListenerStart > 0 && (data.timestamp || 0) <= _alertListenerStart) {
    const selisihDetik = ((_alertListenerStart - (data.timestamp || 0)) / 1000).toFixed(1);
    console.log(
      `[AlertMonitor] ⏭ Guard A: skip data historis ` +
      `(data.timestamp=${data.timestamp}, listenerStart=${_alertListenerStart}, selisih=${selisihDetik}s)`
    );
    return;
  }

  // ── Guard B: Cek threshold ────────────────────────────────────────────
  const thr       = _alertThr;
  const suhuLewat = data.suhu > thr.suhu_max;
  const phLewat   = data.ph < thr.ph_min || data.ph > thr.ph_max;
  if (!suhuLewat && !phLewat) return; // kondisi normal, tidak ada tindakan

  // ── Guard C: Global cooldown dari Firebase ────────────────────────────
  // Baca KAPAN terakhir kali WA berhasil dikirim — nilainya sama untuk
  // SEMUA tab dan SEMUA user karena tersimpan di Firebase, bukan memori lokal.
  // Inilah yang membuat sistem anti-spam multi-client bekerja.
  const now      = Date.now();
  const lastSent = await _getGlobalLastSent();
  const sisaMs   = WA_COOLDOWN_MS - (now - lastSent);

  if (sisaMs > 0) {
    const mntSisa = Math.ceil(sisaMs / 60000);
    console.log(
      `[AlertMonitor] ⏳ Guard C: Peringatan kritis terdeteksi, ` +
      `namun masih dalam masa global cooldown 1 jam (sisa ~${mntSisa} menit). Alert dilewati.`
    );
    return;
  }

  // ── Klaim cooldown (Optimistic Lock) ─────────────────────────────────
  // Tulis timestamp ke Firebase SEBELUM memanggil Fonnte.
  // Jika dua tab kebetulan sama-sama lolos Guard C dalam selang <1 detik,
  // keduanya akan menulis ke Firebase — tab yang menulis lebih dulu "menang",
  // tab kedua pada evaluasi berikutnya akan baca nilai baru dan masuk cooldown.
  // Ini tidak 100% atomic (perlu Firebase Transactions / Cloud Functions untuk
  // garansi penuh), tapi sangat efektif di skala proyek ini.
  await _setGlobalLastSent(now);
  console.log("[AlertMonitor] 🔒 Cooldown diklaim: menulis", now, "ke /system/last_wa_sent");

  // ── Susun pesan peringatan ────────────────────────────────────────────
  const baris = [];
  if (suhuLewat) {
    baris.push(`🌡️ Suhu: ${data.suhu.toFixed(1)}°C (Maks: ${thr.suhu_max}°C)`);
  }
  if (phLewat) {
    const ket = data.ph < thr.ph_min ? "terlalu rendah" : "terlalu tinggi";
    baris.push(`💧 pH: ${data.ph.toFixed(2)} (${ket}, batas aman: ${thr.ph_min}–${thr.ph_max})`);
  }

  const pesan =
    `⚠️ PERINGATAN KEMBANG TURI ⚠️\n` +
    `Kondisi Greenhouse di luar batas!\n\n` +
    baris.join("\n") + "\n\n" +
    `Segera cek lokasi!\n` +
    `Waktu: ${formatDateTime(now)}`;

  console.log("[AlertMonitor] ⚠ Data baru melampaui batas — mengirim WA...");

  try {
    const result = await sendWhatsAppAlert(pesan);
    if (result.sent > 0) {
      console.log(
        `[AlertMonitor] ✓ WA terkirim ke ${result.sent} penerima. ` +
        `Global cooldown 1 jam aktif via /system/last_wa_sent.`
      );
    } else {
      // 0 penerima valid (bukan error jaringan) → reset cooldown agar bisa retry
      await _setGlobalLastSent(0);
      console.warn("[AlertMonitor] ⚠ 0 penerima — cooldown di-reset ke 0. Cek no_hp & role di Firebase.");
    }
  } catch (e) {
    // Error jaringan / Fonnte down → reset cooldown agar bisa retry
    await _setGlobalLastSent(0);
    console.error("[AlertMonitor] ❌ Gagal kirim WA:", e.message, "— cooldown di-reset ke 0.");
  }
}

/* ============================================================
   UI HELPERS — PROFIL PENGGUNA (Avatar Dinamis)

   Fungsi ini memperbarui tampilan avatar di semua halaman
   berdasarkan data user (nama + role) dari Firebase Auth/RTDB.

   Cara pakai:
   • Otomatis: AuthGuard._applyUI() memanggil ini via localStorage session.
   • Manual  : window.FB.updateUserProfileUI(nama, role)
               → panggil setelah Firebase Auth + getUserProfile() selesai.

   Selector avatar yang didukung (seluruh halaman):
   • #avatarEl    → dashboard.html (id unik)
   • .avatar      → dashboard.html (class)
   • .avatar-sm   → laporan.html, parameter.html, status.html
   • .avatar-chip → akun.html
============================================================ */

const AVATAR_ROLE_COLORS = {
  "pekerja":  "#22C55E",  // 🟢 Hijau
  "asisten":  "#3B82F6",  // 🔵 Biru
  "manajer":  "#F59E0B",  // 🟠 Amber
  "admin it": "#6366F1",  // 🟣 Indigo
  "admin":    "#6366F1",  // 🟣 Indigo (alias key "admin" di ROLES)
};

/**
 * Perbarui semua elemen avatar di halaman saat ini.
 *
 * @param {string} nama  Nama lengkap dari /users/{uid}/nama
 * @param {string} role  Role dari /users/{uid}/role (case-insensitive)
 */
function updateUserProfileUI(nama, role) {
  const initial = (nama || "?").charAt(0).toUpperCase();
  const roleKey = (role || "").trim().toLowerCase();

  // Cari warna: exact match dulu, lalu partial untuk role multi-kata
  let color = AVATAR_ROLE_COLORS[roleKey];
  if (!color) {
    for (const [key, val] of Object.entries(AVATAR_ROLE_COLORS)) {
      if (roleKey.includes(key)) { color = val; break; }
    }
  }
  if (!color) color = "#6B7280"; // abu-abu jika role tidak dikenal

  document.querySelectorAll("#avatarEl, .avatar, .avatar-sm, .avatar-chip").forEach(el => {
    el.textContent      = initial;
    el.style.background = color;
  });

  const profileNameEl = document.getElementById("profileName");
  if (profileNameEl) profileNameEl.textContent = nama || role || "—";

  const greetNameEl = document.getElementById("greetName");
  if (greetNameEl) greetNameEl.textContent = nama || role || "—";

  const greetingEl = document.querySelector(".page-greeting");
  if (greetingEl) greetingEl.innerHTML = `Halo, <strong>${nama || role || "—"}</strong> 👋`;

  console.log(`[ProfileUI] ✓ Avatar → inisial="${initial}", role="${roleKey}", warna="${color}"`);
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
  startAlertMonitor, stopAlertMonitor,
  updateUserProfileUI,
  aggregateByDay, computeSummary,
  todayISO, daysAgoISO, formatDateLabel, formatDateTime,
  startSimulator, stopSimulator,
  getSensorStatus,
  loginUser, getUserProfile, signOutUser, subscribeAuthState,
};

console.log("[Firebase] ✓ window.FB bridge ready — global cooldown via /system/last_wa_sent");
