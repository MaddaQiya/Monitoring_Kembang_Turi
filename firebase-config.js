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
let _simTimer  = null;
let _simSuhu   = 28.5;
let _simPh     = 6.0;
let _simThr    = { ...DEFAULT_THRESHOLDS };

async function startSimulator(intervalMs = 5000) {
  _simThr = await getThresholds();
  await _doSimWrite();                          // immediate first write
  _simTimer = setInterval(_doSimWrite, intervalMs);
  console.log(`[Simulator] ▶ started (every ${intervalMs/1000}s)`);
}
function stopSimulator() {
  clearInterval(_simTimer); _simTimer = null;
  console.log("[Simulator] ■ stopped");
}
async function _doSimWrite() {
  _simSuhu = Math.min(33, Math.max(24, _simSuhu + (Math.random() - 0.45) * 0.7));
  _simPh   = Math.min(7.5, Math.max(4.8, _simPh  + (Math.random() - 0.5)  * 0.09));
  try { await writeSensorLog(_simSuhu, _simPh, _simThr); }
  catch(e) { console.warn("[Simulator] write failed:", e.message); }
}

/* ============================================================
   WINDOW BRIDGE  (lets non-module <script> tags call these)
   Usage:  window.FB.getUsers().then(...)
============================================================ */
window.FB = {
  db, auth, firebaseConfig, DEFAULT_THRESHOLDS,
  writeSensorLog, getRecentLogs, getLogsByRange,
  subscribeLatestSensor, subscribeNewSensor, subscribeConnectionState,
  getUsers, addUser, updateUser, deleteUser,
  getThresholds, saveThresholds,
  aggregateByDay, computeSummary,
  todayISO, daysAgoISO, formatDateLabel, formatDateTime,
  startSimulator, stopSimulator,
  getSensorStatus,
  loginUser, getUserProfile, signOutUser, subscribeAuthState,
};

console.log("[Firebase] ✓ window.FB bridge ready");
