/* ================================================================
   Ruang Tes — app.js
   Single-file SPA. Data lives in localStorage (prototype).
   In production: auth & storage move to a real backend;
   webcam snapshots are uploaded to a server/Drive folder.
   ================================================================ */

'use strict';

/* ────────────────────────────────────────────────────────────
   DATA LAYER
   ──────────────────────────────────────────────────────────── */
const DB_KEY = 'ruangtes_db_v4';

function migrateDB(db) {
  Object.values(db.tests || {}).forEach(t => {
    (t.sections || []).forEach(sec => {
      if (sec.kind !== 'example') sec.kind = 'test';
      sec.untimed = !!sec.untimed;
      if (sec.displayMode !== 'all') sec.displayMode = 'single';
      if (typeof sec.description !== 'string') sec.description = '';
      (sec.questions || []).forEach(q => {
        if ((q.type === 'single' || q.type === 'multi') && Array.isArray(q.opts)) {
          q.opts = q.opts.map(o => (typeof o === 'string') ? { text: o, image: null } : o);
        }
      });
      if (typeof sec.durationSec === 'undefined') {
        sec.durationSec = (typeof sec.durationMin === 'number' ? sec.durationMin : 10) * 60;
        delete sec.durationMin;
      }
    });
    if (typeof t.useIqNorm === 'undefined') t.useIqNorm = false;
    if (!Array.isArray(t.iqNormTable)) t.iqNormTable = [];
    if (!Array.isArray(t.invited)) t.invited = [];
  });
  if (!db.tombstones) db.tombstones = { tests: {}, users: {}, results: {} };
  if (!db.tombstones.results) db.tombstones.results = {};
  return db;
}

function loadDB() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return migrateDB(JSON.parse(raw));
  } catch (e) { /* ignore */ }
  return { tests: {}, users: {}, tombstones: { tests: {}, users: {}, results: {} } };
}

function saveDB() {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
  catch (e) { console.error('Gagal menyimpan data:', e); }
  if (window.Drive?.state?.connected) Drive.save(db);
  if (window.Cloud) Cloud.push(db, refreshAfterMerge);
}

/* Tarik data server lalu gabungkan. Return true bila ada perubahan. */
async function syncFromCloud() {
  if (!window.Cloud || !Cloud.state.configured) return false;
  await Cloud.flush(db);
  const changed = await Cloud.pull(db);
  if (changed) {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { /* */ }
  }
  return changed;
}

/* Layar daftar aman di-render ulang; layar form/tes tidak boleh terganggu. */
const LIST_SCREENS = ['home', 'adminDashboard', 'adminResults', 'adminParticipants', 'participantEntry'];
function refreshAfterMerge() {
  try { localStorage.setItem(DB_KEY, JSON.stringify(db)); } catch (e) { /* */ }
}

function markDeleted(kind, key) {
  db.tombstones = db.tombstones || { tests: {}, users: {}, results: {} };
  db.tombstones[kind] = db.tombstones[kind] || {};
  db.tombstones[kind][key] = Date.now();
}

/* Hapus riwayat pengerjaan. items: [{ t, r }]. Foto kamera di Storage ikut dihapus bila bisa. */
function deleteResults(items) {
  items.forEach(({ t, r }) => {
    const i = t.results.indexOf(r);
    if (i < 0) return;
    t.results.splice(i, 1);
    markDeleted('results', `${r.submittedAt}|${r.email}`);
    window.Cloud?.deleteSnapshots(r.snapshots);
  });
  saveDB();
}
function clearTombstone(kind, key) {
  if (db.tombstones?.[kind]) delete db.tombstones[kind][key];
}

let db = loadDB();
let currentUser = null; /* { email, name, role } */

/* ────────────────────────────────────────────────────────────
   THEME
   ──────────────────────────────────────────────────────────── */
const THEME_KEY = 'ruangtes_theme';
let theme = 'system';
try { theme = localStorage.getItem(THEME_KEY) || 'system'; } catch (e) { /* */ }

function applyTheme() {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
}

function cycleTheme() {
  theme = theme === 'system' ? 'light' : theme === 'light' ? 'dark' : 'system';
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) { /* */ }
  applyTheme();
  render();
}

function themeIcon()  { return theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '🖥️'; }
function themeLabel() { return theme === 'light' ? 'Terang' : theme === 'dark' ? 'Gelap' : 'Sistem'; }

/* ────────────────────────────────────────────────────────────
   UTILITIES
   ──────────────────────────────────────────────────────────── */
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function todayStr() { return new Date().toISOString().slice(0, 10); }

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d + 'T00:00:00').toLocaleDateString('id-ID', { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function drivePath(code, date) { return `PsikotesResults/${code}_${date}/`; }

const TYPE_LABEL = {
  single:    'Pilihan ganda — satu jawaban',
  multi:     'Pilihan ganda — multi jawaban',
  truefalse: 'Benar / Salah',
  scale:     'Skala 1–5',
  essay:     'Esai / teks bebas',
};
const AUTO_SCORE_TYPES = ['single', 'multi', 'truefalse'];

/* Huruf pilihan sesuai urutan: A, B, C, ... */
function optLetter(i) { return Number.isInteger(i) && i >= 0 ? String.fromCharCode(65 + (i % 26)) : ''; }

/* Isi pilihan untuk peserta. Bila teks tidak ditulis, tampilkan huruf otomatis (A, B, C, ...) sesuai urutan. */
function optLabel(op, oi) {
  if (typeof op === 'string') return `<span>${esc(op)}</span>`;
  const hasText = !!op?.text?.trim();
  let html = '';
  if (op?.image) html += `<img src="${op.image}" class="ans-opt-img" alt="Pilihan ${optLetter(oi)}">`;
  if (hasText) html += `<span>${esc(op.text)}</span>`;
  else if (oi != null) html += `<span class="opt-letter">${optLetter(oi)}</span>`;
  else if (!op?.image) html += `<span class="text-tertiary">(pilihan kosong)</span>`;
  return html;
}

/* Teks pilihan untuk ringkasan jawaban (admin & umpan balik). Tanpa teks → "Pilihan A". */
function optText(op, oi) {
  if (op == null) return '(kosong)';
  if (typeof op === 'string') return op;
  if (op.text?.trim()) return op.text;
  const name = oi != null ? `Pilihan ${optLetter(oi)}` : '';
  if (op.image) return name ? `${name} (gambar)` : '[gambar]';
  return name || '(kosong)';
}

function optThumb(op) {
  if (op && typeof op === 'object' && op.image) {
    return `<img src="${op.image}" style="max-width:90px;max-height:60px;object-fit:contain;border-radius:4px;border:1px solid var(--border);display:block;margin-top:4px;">`;
  }
  return '';
}

/* IQ conversion via norm table with linear interpolation */
function computeIQ(test, rawScore) {
  if (!test?.useIqNorm || !test.iqNormTable?.length) return null;
  const table = test.iqNormTable
    .filter(r => r && r.raw != null && r.iq != null && !isNaN(r.raw) && !isNaN(r.iq))
    .sort((a, b) => a.raw - b.raw);
  if (!table.length) return null;
  const exact = table.find(r => r.raw === rawScore);
  if (exact) return exact.iq;
  if (rawScore <= table[0].raw) return table[0].iq;
  if (rawScore >= table[table.length - 1].raw) return table[table.length - 1].iq;
  for (let i = 0; i < table.length - 1; i++) {
    const a = table[i], b = table[i + 1];
    if (rawScore > a.raw && rawScore < b.raw) {
      const frac = (rawScore - a.raw) / (b.raw - a.raw);
      return Math.round(a.iq + frac * (b.iq - a.iq));
    }
  }
  return null;
}

const IQ_CATEGORIES = [
  { min: 170, label: 'Genius / Jenius' },
  { min: 140, label: 'Very Superior / Sangat Cerdas' },
  { min: 120, label: 'Superior / Cerdas' },
  { min: 110, label: 'High Average / Di atas rata-rata' },
  { min: 90,  label: 'Average / Rata-rata' },
  { min: 80,  label: 'Low Average / Di bawah rata-rata' },
  { min: 70,  label: 'Borderline' },
  { min: -Infinity, label: 'Mentally Defective' },
];

function iqCategory(iq) {
  if (iq == null) return null;
  return IQ_CATEGORIES.find(c => iq >= c.min)?.label ?? null;
}

/* Batas keluar tab: tes ditutup otomatis pada pelanggaran ke-N. 0 = tanpa batas. */
function maxViolationsOf(t) {
  return typeof t?.maxViolations === 'number' ? t.maxViolations : 3;
}

function fmtSnapInterval(t) {
  const sec = t.snapshotSec ?? (t.snapshotMinutes ?? 3) * 60;
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m > 0 && s > 0) return `${m} menit ${s} detik`;
  if (m > 0) return `${m} menit`;
  return `${s} detik`;
}

async function readImageCompressed(file, maxW = 800, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement('canvas');
        canvas.width  = Math.max(1, Math.round(img.width  * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/* ────────────────────────────────────────────────────────────
   ROUTER / STATE
   ──────────────────────────────────────────────────────────── */
let state = { screen: 'home' };
const root = document.getElementById('app');

const ADMIN_SCREENS     = ['adminDashboard','adminCreateTest','adminTestCreated','adminResults','adminResultDetail','adminParticipants','adminInvite','adminParticipantProfile'];
const PESERTA_SCREENS   = ['participantEntry','participantConsent','participantTest','participantDone'];

/* ── Pratinjau admin: melihat tes dari sudut pandang peserta ── */
function startPreview(code) {
  if (examCtx) { clearInterval(examTimer); clearInterval(snapTimer); }
  examCtx = null;
  go('participantConsent', { code, date: todayStr(), preview: true });
}

function exitPreview(code) {
  clearInterval(examTimer); clearInterval(snapTimer);
  document.removeEventListener('visibilitychange', window.__ruangtesVis || (() => {}));
  examCtx = null;
  go(code ? 'adminResults' : 'adminDashboard', code ? { code } : {});
}

function previewBar(t, sectionIdx) {
  const jump = sectionIdx == null ? '' : `
    <label class="text-xs" style="display:flex;align-items:center;gap:var(--sp-2);">Lompat ke
      <select class="form-field" id="pvJump" style="width:auto;padding:2px var(--sp-2);">
        ${t.sections.map((sec, i) => `<option value="${i}" ${i === sectionIdx ? 'selected' : ''}>${i + 1}. ${esc(sec.name)}${sec.kind === 'example' ? ' (contoh)' : ''}</option>`).join('')}
      </select>
    </label>`;
  return `<div class="preview-bar" role="status">
    <span><strong>Mode pratinjau</strong> — tampilan peserta. Jawaban dan hasil tidak disimpan, kamera tidak aktif, dan waktu habis tidak memindahkan bagian.</span>
    ${jump}
    <button type="button" class="btn btn-secondary btn-sm" id="pvExit">Keluar pratinjau</button>
  </div>`;
}

function go(screen, extra) {
  if (state.screen === 'participantTest' && screen !== 'participantTest') removeZoomControls();
  if (state.preview && state.screen === 'participantTest' && screen !== 'participantTest') {
    clearInterval(examTimer); clearInterval(snapTimer); examCtx = null;
  }
  state = Object.assign({ screen }, extra || {});
  render();
  window.scrollTo(0, 0);
  if (LIST_SCREENS.includes(screen)) {
    const shown = state;
    syncFromCloud().then(changed => { if (changed && state === shown) render(); });
  }
}

function render() {
  root.innerHTML = '';
  if (ADMIN_SCREENS.includes(state.screen) && !(currentUser?.role === 'admin')) {
    screenAuth('login', 'admin'); return;
  }
  const adminPreview = state.preview && currentUser?.role === 'admin';
  if (PESERTA_SCREENS.includes(state.screen) && !(currentUser?.role === 'peserta' || adminPreview)) {
    screenAuth('login', 'peserta'); return;
  }
  SCREENS[state.screen]?.();
}

/* ────────────────────────────────────────────────────────────
   TOPBAR
   ──────────────────────────────────────────────────────────── */
function buildTopbar(activeKey) {
  const bar = document.createElement('header');
  bar.className = 'topbar';
  bar.innerHTML = `
    <div class="brand" id="brandHome">
      <div class="brand__mark">R</div>
      <div>
        <div class="brand__name">Ruang Tes</div>
        <div class="brand__tagline">Platform psikotes daring</div>
      </div>
    </div>
    <nav class="topbar-nav">
      <button class="nav-btn ${activeKey === 'home' ? 'nav-btn--active' : ''}" data-r="home">Beranda</button>
      <button class="nav-btn" data-r="theme" title="Tema: ${themeLabel()}">${themeIcon()} ${themeLabel()}</button>
      ${window.Drive ? (() => {
        const ds = Drive.state;
        if (!ds.configured) return '';
        if (ds.syncing) return `<span class="nav-btn" style="opacity:.6;cursor:default">⏳ Drive…</span>`;
        if (ds.connected) return `<button class="nav-btn" data-r="driveOut" title="Putuskan Google Drive">☁️ Terhubung</button>`;
        return `<button class="nav-btn" data-r="driveIn" title="Hubungkan Google Drive">☁️ Drive</button>`;
      })() : ''}
      ${currentUser ? `
        <span class="topbar-who">
          <b>${esc(currentUser.name)}</b>
          <span class="role-chip">${currentUser.role === 'admin' ? 'Admin' : 'Peserta'}</span>
        </span>
        <button class="nav-btn ${activeKey !== 'home' ? 'nav-btn--active' : ''}" data-r="dash">
          ${currentUser.role === 'admin' ? 'Dasbor' : 'Tes saya'}
        </button>
        <button class="nav-btn nav-btn--danger" data-r="logout">Keluar</button>
      ` : `
        <button class="nav-btn" data-r="login">Masuk</button>
      `}
    </nav>
  `;
  bar.querySelector('#brandHome').onclick = () => go('home');
  bar.querySelectorAll('[data-r]').forEach(b => {
    b.onclick = () => {
      const r = b.dataset.r;
      if (r === 'home') go('home');
      else if (r === 'theme') cycleTheme();
      else if (r === 'login') go('authView', { mode: 'login' });
      else if (r === 'dash') go(currentUser.role === 'admin' ? 'adminDashboard' : 'participantEntry');
      else if (r === 'logout') { currentUser = null; go('home'); }
      else if (r === 'driveIn' && window.Drive) Drive.signIn();
      else if (r === 'driveOut' && window.Drive) Drive.signOut();
    };
  });
  return bar;
}

/* ────────────────────────────────────────────────────────────
   AUTH
   ──────────────────────────────────────────────────────────── */
function screenAuth(forceMode, roleHint) {
  root.appendChild(buildTopbar('auth'));
  let mode = forceMode || state.mode || 'login';
  let regRole = roleHint || 'peserta';
  let showPw = false;
  const wrap = document.createElement('div');
  wrap.className = 'screen';
  root.appendChild(wrap);

  function draw() {
    if (mode === 'login') {
      wrap.innerHTML = `
        <div class="auth-wrap">
          <div class="card">
            <h2 style="font-size:var(--text-2xl);margin:0 0 var(--sp-1);">Masuk ke Ruang Tes</h2>
            <p class="text-secondary text-sm" style="margin:0 0 var(--sp-5);">
              ${roleHint === 'admin'   ? 'Halaman ini hanya untuk admin.' :
                roleHint === 'peserta' ? 'Masuk dengan akun peserta untuk mengikuti tes.' :
                'Masuk ke akunmu.'}
            </p>
            <div class="form-group">
              <label class="form-label" for="lEmail">Email</label>
              <input class="form-field" type="email" id="lEmail" placeholder="nama@email.com" autocomplete="email">
            </div>
            <div class="form-group">
              <label class="form-label" for="lPw">Kata sandi</label>
              <div class="pw-wrap">
                <input class="form-field" type="${showPw ? 'text' : 'password'}" id="lPw" autocomplete="current-password">
                <button type="button" class="pw-toggle" id="pwt">${showPw ? 'Sembunyikan' : 'Lihat'}</button>
              </div>
            </div>
            <div id="err" class="form-error" style="display:none;"></div>
            <button class="btn btn-primary btn-block" id="submit">Masuk</button>
            <p class="text-sm text-secondary" style="text-align:center;margin-top:var(--sp-4);">
              Belum punya akun? <button class="link-btn" id="toReg">Daftar</button>
            </p>
            <hr class="divider">
            <p class="text-xs text-tertiary" style="text-align:center;margin:0 0 var(--sp-2);">Coba cepat:</p>
            <div style="display:flex;gap:var(--sp-2);justify-content:center;">
              <button class="btn btn-secondary btn-sm" id="seedAdmin">Akun admin contoh</button>
              <button class="btn btn-secondary btn-sm" id="seedPeserta">Akun peserta contoh</button>
            </div>
          </div>
        </div>`;
      wrap.querySelector('#pwt').onclick = () => { showPw = !showPw; draw(); };
      wrap.querySelector('#toReg').onclick = () => { mode = 'register'; draw(); };
      wrap.querySelector('#seedAdmin').onclick = () => {
        ensureSeedUsers();
        wrap.querySelector('#lEmail').value = 'admin@ruangtes.id';
        wrap.querySelector('#lPw').value = 'admin123';
      };
      wrap.querySelector('#seedPeserta').onclick = () => {
        ensureSeedUsers();
        wrap.querySelector('#lEmail').value = 'peserta@ruangtes.id';
        wrap.querySelector('#lPw').value = 'peserta123';
      };
      wrap.querySelector('#submit').onclick = async () => {
        const email = wrap.querySelector('#lEmail').value.trim().toLowerCase();
        const pw    = wrap.querySelector('#lPw').value;
        const errEl = wrap.querySelector('#err');
        const btn   = wrap.querySelector('#submit');
        btn.disabled = true; btn.textContent = 'Memeriksa…';
        await syncFromCloud();
        btn.disabled = false; btn.textContent = 'Masuk';
        const u = db.users[email];
        if (!u || u.password !== pw) {
          errEl.textContent = 'Email atau kata sandi tidak cocok.';
          errEl.style.display = 'block';
          return;
        }
        errEl.style.display = 'none';
        currentUser = { email: u.email, name: u.name, role: u.role };
        go(u.role === 'admin' ? 'adminDashboard' : 'participantEntry');
      };
    } else {
      wrap.innerHTML = `
        <div class="auth-wrap">
          <div class="card">
            <h2 style="font-size:var(--text-2xl);margin:0 0 var(--sp-1);">Buat akun</h2>
            <p class="text-secondary text-sm" style="margin:0 0 var(--sp-4);">Pilih jenis akun sesuai perananmu.</p>
            <div class="seg-ctrl">
              <button type="button" class="seg-btn ${regRole === 'peserta' ? 'seg-btn--active' : ''}" data-role="peserta">Saya peserta</button>
              <button type="button" class="seg-btn ${regRole === 'admin'   ? 'seg-btn--active' : ''}" data-role="admin">Saya admin</button>
            </div>
            <div class="form-group">
              <label class="form-label" for="rName">Nama lengkap</label>
              <input class="form-field" type="text" id="rName" placeholder="Nama sesuai identitas" autocomplete="name">
            </div>
            <div class="form-group">
              <label class="form-label" for="rEmail">Email</label>
              <input class="form-field" type="email" id="rEmail" placeholder="nama@email.com" autocomplete="email">
            </div>
            <div class="form-group">
              <label class="form-label" for="rPw">Kata sandi</label>
              <div class="pw-wrap">
                <input class="form-field" type="${showPw ? 'text' : 'password'}" id="rPw" autocomplete="new-password">
                <button type="button" class="pw-toggle" id="pwt">${showPw ? 'Sembunyikan' : 'Lihat'}</button>
              </div>
            </div>
            <div id="err" class="form-error" style="display:none;"></div>
            <button class="btn btn-primary btn-block" id="submit">Daftar</button>
            <p class="text-sm text-secondary" style="text-align:center;margin-top:var(--sp-4);">
              Sudah punya akun? <button class="link-btn" id="toLogin">Masuk</button>
            </p>
          </div>
        </div>`;
      wrap.querySelectorAll('[data-role]').forEach(b => b.onclick = () => { regRole = b.dataset.role; draw(); });
      wrap.querySelector('#pwt').onclick = () => { showPw = !showPw; draw(); };
      wrap.querySelector('#toLogin').onclick = () => { mode = 'login'; draw(); };
      wrap.querySelector('#submit').onclick = async () => {
        const name  = wrap.querySelector('#rName').value.trim();
        const email = wrap.querySelector('#rEmail').value.trim().toLowerCase();
        const pw    = wrap.querySelector('#rPw').value;
        const errEl = wrap.querySelector('#err');
        if (!name || !email || !pw) { errEl.textContent = 'Semua kolom wajib diisi.'; errEl.style.display = 'block'; return; }
        await syncFromCloud();
        if (db.users[email]) { errEl.textContent = 'Email ini sudah terdaftar. Silakan masuk.'; errEl.style.display = 'block'; return; }
        clearTombstone('users', email);
        db.users[email] = { email, name, password: pw, role: regRole, createdAt: Date.now() };
        saveDB();
        await Cloud?.flush(db);
        currentUser = { email, name, role: regRole };
        go(regRole === 'admin' ? 'adminDashboard' : 'participantEntry');
      };
    }
  }
  draw();
}

function ensureSeedUsers() {
  if (!db.users['admin@ruangtes.id'])
    db.users['admin@ruangtes.id'] = { email: 'admin@ruangtes.id', name: 'Admin Contoh', password: 'admin123', role: 'admin', createdAt: Date.now() };
  if (!db.users['peserta@ruangtes.id'])
    db.users['peserta@ruangtes.id'] = { email: 'peserta@ruangtes.id', name: 'Peserta Contoh', password: 'peserta123', role: 'peserta', createdAt: Date.now() };
  saveDB();
}

/* ────────────────────────────────────────────────────────────
   HOME
   ──────────────────────────────────────────────────────────── */
function screenHome() {
  root.appendChild(buildTopbar('home'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  wrap.innerHTML = `
    <div class="hero">
      <h1 class="hero-title">Buat tes, awasi pengerjaannya,<br>lihat hasilnya — dalam satu ruang.</h1>
      <p class="hero-lede">Penyelenggara menyusun soal, mengatur batas waktu, dan memantau kamera peserta. Peserta cukup memasukkan kode unik untuk memulai. Semua terekam otomatis.</p>
      <div class="gate-grid">
        <div class="gate-card">
          <span class="gate-tag">Untuk penyelenggara</span>
          <h2>Masuk sebagai Admin</h2>
          <p>Susun bagian tes, atur waktu dan interval kamera, undang peserta, lalu tinjau hasil dan rekaman tiap peserta.</p>
          <button class="btn btn-secondary" id="toAdmin">Buka dasbor admin</button>
        </div>
        <div class="gate-card">
          <span class="gate-tag">Untuk peserta</span>
          <h2>Ikuti tes</h2>
          <p>Masuk dengan akun peserta, lalu masukkan tanggal pelaksanaan dan kode unik dari penyelenggara untuk memulai.</p>
          <button class="btn btn-primary" id="toPeserta">Mulai tes</button>
        </div>
      </div>
    </div>
    <div class="note" style="max-width:720px;">
      <strong>Catatan prototipe:</strong> ${window.Cloud?.state.configured ? 'data disinkronkan ke Supabase sehingga sama di semua peramban' : 'Supabase belum dikonfigurasi, jadi data hanya tersimpan di <code>localStorage</code> peramban ini'} — kata sandi tersimpan polos dan login belum diverifikasi server.
    </div>
  `;
  root.appendChild(wrap);
  wrap.querySelector('#toAdmin').onclick   = () => routeAuth('admin');
  wrap.querySelector('#toPeserta').onclick = () => routeAuth('peserta');
}

function routeAuth(role) {
  if (currentUser?.role === role) { go(role === 'admin' ? 'adminDashboard' : 'participantEntry'); return; }
  root.innerHTML = '';
  screenAuth('login', role);
}

/* ────────────────────────────────────────────────────────────
   ADMIN — DASHBOARD
   ──────────────────────────────────────────────────────────── */
function screenAdminDashboard() {
  root.appendChild(buildTopbar('admin'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  root.appendChild(wrap);
  let confirmCode = null;

  function redraw() {
    const tests = Object.values(db.tests);
    wrap.innerHTML = `
      <div class="page-header">
        <div><h2 class="page-title">Dasbor</h2></div>
        <div class="page-actions">
          <button class="btn btn-secondary" id="btnParticipants">Kelola peserta</button>
          <button class="btn btn-secondary" id="btnSeed">Muat contoh tes</button>
          <button class="btn btn-primary"   id="btnNew">+ Tes baru</button>
        </div>
      </div>
      <div class="card-flush">
        ${tests.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Nama tes</th><th>Kode</th><th>Tanggal</th>
              <th>Section</th><th>Peserta</th><th style="text-align:right;">Aksi</th>
            </tr></thead>
            <tbody>
              ${tests.map(t => {
                const isConf = confirmCode === t.code;
                return `<tr>
                  <td>
                    <div class="font-bold">${esc(t.title)}</div>
                    <div class="text-xs text-tertiary" style="margin-top:2px;">
                      Skor ${t.showScore ? 'ditampilkan' : 'disembunyikan'} · ${(t.invited||[]).length} diundang
                    </div>
                  </td>
                  <td><span class="code-tag">${t.code}</span></td>
                  <td class="text-sm text-secondary">${fmtDate(t.date)}</td>
                  <td class="text-sm">${t.sections.length}</td>
                  <td class="text-sm">${t.results.length}</td>
                  <td style="text-align:right;white-space:nowrap;">
                    ${isConf ? `
                      <span class="text-danger text-xs" style="margin-right:var(--sp-2);">
                        Hapus tes${t.results.length ? ` + ${t.results.length} hasil` : ''}?
                      </span>
                      <button class="btn btn-danger btn-sm"  data-conf-del="${t.code}">Ya, hapus</button>
                      <button class="btn btn-secondary btn-sm" data-cancel-del="${t.code}">Batal</button>
                    ` : `
                      <button class="btn btn-secondary btn-sm" data-preview="${t.code}">Pratinjau</button>
                      <button class="btn btn-secondary btn-sm" data-edit="${t.code}">Edit</button>
                      <button class="btn btn-secondary btn-sm" data-view="${t.code}">Hasil</button>
                      <button class="btn btn-danger-outline btn-sm" data-ask-del="${t.code}">Hapus</button>
                    `}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : `
        <div class="empty">
          <p class="font-bold text-secondary" style="font-size:var(--text-lg);margin:0 0 var(--sp-2);">Belum ada tes</p>
          <p>Buat tes baru atau muat contoh untuk mencoba alur lengkapnya.</p>
        </div>`}
      </div>
    `;
    wrap.querySelector('#btnNew').onclick = () => go('adminCreateTest');
    wrap.querySelector('#btnSeed').onclick = () => { seedExample(); redraw(); };
    wrap.querySelector('#btnParticipants').onclick = () => go('adminParticipants');
    wrap.querySelectorAll('[data-preview]').forEach(b => b.onclick = () => startPreview(b.dataset.preview));
    wrap.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => go('adminCreateTest', { editCode: b.dataset.edit }));
    wrap.querySelectorAll('[data-view]').forEach(b => b.onclick = () => go('adminResults', { code: b.dataset.view }));
    wrap.querySelectorAll('[data-ask-del]').forEach(b => b.onclick = () => { confirmCode = b.dataset.askDel; redraw(); });
    wrap.querySelectorAll('[data-cancel-del]').forEach(b => b.onclick = () => { confirmCode = null; redraw(); });
    wrap.querySelectorAll('[data-conf-del]').forEach(b => b.onclick = () => {
      delete db.tests[b.dataset.confDel];
      markDeleted('tests', b.dataset.confDel);
      saveDB();
      confirmCode = null;
      redraw();
    });
  }
  redraw();
}

/* ────────────────────────────────────────────────────────────
   ADMIN — MANAGE PARTICIPANTS
   ──────────────────────────────────────────────────────────── */
function screenAdminParticipants() {
  root.appendChild(buildTopbar('admin'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  root.appendChild(wrap);
  let confirmEmail = null;

  function redraw() {
    const accounts = Object.values(db.users).filter(u => u.role === 'peserta');
    wrap.innerHTML = `
      <div style="margin-bottom:var(--sp-4);">
        <button class="btn btn-ghost" id="back">← Dasbor</button>
      </div>
      <div class="page-header">
        <div><h2 class="page-title">Kelola Peserta</h2></div>
      </div>
      <div class="card" style="margin-bottom:var(--sp-5);">
        <h3 style="font-size:var(--text-lg);margin:0 0 var(--sp-1);">Buat akun peserta baru</h3>
        <p class="text-sm text-secondary" style="margin:0 0 var(--sp-4);">Admin dapat membuatkan akun langsung tanpa peserta perlu mendaftar sendiri.</p>
        <div class="form-row">
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label" for="pName">Nama lengkap</label>
            <input class="form-field" type="text" id="pName" placeholder="Nama peserta">
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label" for="pEmail">Email</label>
            <input class="form-field" type="email" id="pEmail" placeholder="nama@email.com">
          </div>
        </div>
        <div class="form-group" style="margin-top:var(--sp-4);">
          <label class="form-label" for="pPw">Kata sandi awal</label>
          <input class="form-field" type="text" id="pPw" placeholder="Kata sandi untuk peserta ini">
        </div>
        <div id="createErr" class="form-error" style="display:none;"></div>
        <button class="btn btn-primary" id="createBtn">Buat akun</button>
      </div>
      <div class="card-flush">
        ${accounts.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Nama</th><th>Email</th><th>Tes diundang</th><th style="text-align:right;">Aksi</th></tr></thead>
            <tbody>
              ${accounts.map(u => {
                const invTests = Object.values(db.tests).filter(t => (t.invited||[]).some(inv => inv.email === u.email));
                const isConf = confirmEmail === u.email;
                return `<tr>
                  <td class="font-bold">${esc(u.name)}</td>
                  <td class="text-sm text-secondary">${esc(u.email)}</td>
                  <td>${invTests.length
                    ? invTests.map(t => `<span class="badge badge-teal" style="margin:2px;">${esc(t.title)}</span>`).join('')
                    : '<span class="text-tertiary text-xs">—</span>'
                  }</td>
                  <td style="text-align:right;white-space:nowrap;">
                    ${isConf ? `
                      <span class="text-danger text-xs" style="margin-right:var(--sp-2);">Hapus akun ini?</span>
                      <button class="btn btn-danger btn-sm"  data-conf-del="${esc(u.email)}">Ya, hapus</button>
                      <button class="btn btn-secondary btn-sm" data-cancel-del="${esc(u.email)}">Batal</button>
                    ` : `
                      <button class="btn btn-secondary btn-sm" data-profile="${esc(u.email)}">Profil & skor</button>
                      <button class="btn btn-secondary btn-sm" data-invite="${esc(u.email)}">Undangan</button>
                      <button class="btn btn-danger-outline btn-sm" data-ask-del="${esc(u.email)}">Hapus</button>
                    `}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : `
        <div class="empty">
          <p class="font-bold text-secondary" style="font-size:var(--text-lg);margin:0 0 var(--sp-2);">Belum ada akun peserta</p>
          <p>Buat satu lewat formulir di atas.</p>
        </div>`}
      </div>
    `;
    wrap.querySelector('#back').onclick = () => go('adminDashboard');
    wrap.querySelector('#createBtn').onclick = () => {
      const name  = wrap.querySelector('#pName').value.trim();
      const email = wrap.querySelector('#pEmail').value.trim().toLowerCase();
      const pw    = wrap.querySelector('#pPw').value;
      const errEl = wrap.querySelector('#createErr');
      if (!name || !email || !pw) { errEl.textContent = 'Semua kolom wajib diisi.'; errEl.style.display = 'block'; return; }
      if (db.users[email]) { errEl.textContent = 'Email ini sudah terdaftar.'; errEl.style.display = 'block'; return; }
      clearTombstone('users', email);
      db.users[email] = { email, name, password: pw, role: 'peserta', createdAt: Date.now() };
      saveDB();
      redraw();
    };
    wrap.querySelectorAll('[data-profile]').forEach(b => b.onclick = () => go('adminParticipantProfile', { email: b.dataset.profile }));
    wrap.querySelectorAll('[data-invite]').forEach(b  => b.onclick = () => go('adminInvite', { email: b.dataset.invite }));
    wrap.querySelectorAll('[data-ask-del]').forEach(b => b.onclick = () => { confirmEmail = b.dataset.askDel; redraw(); });
    wrap.querySelectorAll('[data-cancel-del]').forEach(b => b.onclick = () => { confirmEmail = null; redraw(); });
    wrap.querySelectorAll('[data-conf-del]').forEach(b => b.onclick = () => {
      const em = b.dataset.confDel;
      delete db.users[em];
      markDeleted('users', em);
      Object.values(db.tests).forEach(t => { t.invited = (t.invited||[]).filter(i => i.email !== em); });
      saveDB();
      confirmEmail = null;
      redraw();
    });
  }
  redraw();
}

/* ────────────────────────────────────────────────────────────
   ADMIN — PARTICIPANT PROFILE & SCORE HISTORY
   ──────────────────────────────────────────────────────────── */
function screenAdminParticipantProfile() {
  root.appendChild(buildTopbar('admin'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  root.appendChild(wrap);
  const user = db.users[state.email];
  if (!user) {
    wrap.innerHTML = `<button class="btn btn-ghost" onclick="go('adminParticipants')">← Kembali</button><div class="empty"><p>Akun tidak ditemukan.</p></div>`;
    return;
  }
  const rows = [];
  Object.values(db.tests).forEach(t => {
    t.results.forEach((r, ri) => { if (r.email === state.email) rows.push({ t, r, ri }); });
  });
  rows.sort((a, b) => b.r.submittedAt - a.r.submittedAt);
  let confirmRow = null, confirmAll = false;

  function redrawProfile() {
  wrap.innerHTML = `
    <div style="margin-bottom:var(--sp-4);">
      <button class="btn btn-ghost" id="back">← Kelola peserta</button>
    </div>
    <div class="card" style="margin-bottom:var(--sp-4);">
      <h2 style="margin:0 0 var(--sp-1);">${esc(user.name)}</h2>
      <p class="text-secondary text-sm" style="margin:0;">${esc(user.email)}</p>
    </div>
    <div class="card-flush">
      <div class="card__header" style="padding:var(--sp-4) var(--sp-5);border-bottom:1px solid var(--border);">
        <span class="font-bold">Riwayat skor (${rows.length})</span>
        ${rows.length ? (confirmAll ? `
          <span style="float:right;">
            <span class="text-danger text-sm">Hapus semua ${rows.length} riwayat peserta ini?</span>
            <button class="btn btn-danger btn-sm" id="pAllYes">Ya, hapus semua</button>
            <button class="btn btn-secondary btn-sm" id="pAllNo">Batal</button>
          </span>` : `<button class="btn btn-danger-outline btn-sm" id="pAllAsk" style="float:right;">Hapus semua riwayat</button>`) : ''}
      </div>
      ${rows.length ? `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Tes</th><th>Tanggal</th><th>Skor</th><th>IQ</th><th>Pelanggaran</th><th style="text-align:right;">Aksi</th></tr></thead>
          <tbody>
            ${rows.map(({ t, r, ri }) => {
              const iq = t.useIqNorm ? computeIQ(t, r.score) : null;
              return `<tr>
                <td class="font-bold">${esc(t.title)}</td>
                <td class="text-sm text-secondary">${new Date(r.submittedAt).toLocaleString('id-ID')}</td>
                <td class="font-mono">${r.score}/${r.maxScore}</td>
                <td>${iq != null ? `<span class="font-bold">${iq}</span>` : '—'}</td>
                <td>${r.violations}${r.autoClosed ? ' <span class="badge badge-red">ditutup otomatis</span>' : ''}</td>
                <td style="text-align:right;white-space:nowrap;">
                  ${confirmRow === r ? `
                    <span class="text-danger text-xs">Hapus?</span>
                    <button class="btn btn-danger btn-sm" data-p-yes="${t.code}|${ri}">Ya</button>
                    <button class="btn btn-secondary btn-sm" data-p-no>Batal</button>
                  ` : `
                    <button class="btn btn-secondary btn-sm" data-det="${t.code}|${ri}">Detail</button>
                    <button class="btn btn-danger-outline btn-sm" data-p-ask="${t.code}|${ri}">Hapus</button>
                  `}
                </td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>` : `
      <div class="empty"><p>Peserta ini belum menyelesaikan tes apapun.</p></div>`}
    </div>
  `;
  wrap.querySelector('#back').onclick = () => go('adminParticipants');
  wrap.querySelectorAll('[data-det]').forEach(b => {
    b.onclick = () => {
      const [code, riStr] = b.dataset.det.split('|');
      go('adminResultDetail', { code, ri: +riStr });
    };
  });
  const rowOf = key => { const [code, riStr] = key.split('|'); return { t: db.tests[code], r: db.tests[code].results[+riStr] }; };
  wrap.querySelectorAll('[data-p-ask]').forEach(b => b.onclick = () => { confirmRow = rowOf(b.dataset.pAsk).r; redrawProfile(); });
  wrap.querySelectorAll('[data-p-no]').forEach(b => b.onclick = () => { confirmRow = null; redrawProfile(); });
  wrap.querySelectorAll('[data-p-yes]').forEach(b => b.onclick = () => {
    deleteResults([rowOf(b.dataset.pYes)]); confirmRow = null; rebuildRows(); redrawProfile();
  });
  wrap.querySelector('#pAllAsk')?.addEventListener('click', () => { confirmAll = true; redrawProfile(); });
  wrap.querySelector('#pAllNo')?.addEventListener('click', () => { confirmAll = false; redrawProfile(); });
  wrap.querySelector('#pAllYes')?.addEventListener('click', () => {
    deleteResults(rows.map(({ t, r }) => ({ t, r }))); confirmAll = false; rebuildRows(); redrawProfile();
  });
  }
  function rebuildRows() {
    rows.length = 0;
    Object.values(db.tests).forEach(t => t.results.forEach((r, ri) => { if (r.email === state.email) rows.push({ t, r, ri }); }));
    rows.sort((a, b) => b.r.submittedAt - a.r.submittedAt);
  }
  redrawProfile();
}

/* ────────────────────────────────────────────────────────────
   ADMIN — MANAGE INVITATIONS
   ──────────────────────────────────────────────────────────── */
function screenAdminInvite() {
  root.appendChild(buildTopbar('admin'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  root.appendChild(wrap);
  const user = db.users[state.email];
  if (!user) { wrap.innerHTML = '<div class="empty"><p>Akun tidak ditemukan.</p></div>'; return; }
  const tests = Object.values(db.tests);

  function redraw() {
    wrap.innerHTML = `
      <div style="margin-bottom:var(--sp-4);">
        <button class="btn btn-ghost" id="back">← Kelola peserta</button>
      </div>
      <div class="page-header">
        <div>
          <h2 class="page-title">Undangan untuk ${esc(user.name)}</h2>
          <p class="page-meta">${esc(user.email)}</p>
        </div>
      </div>
      <div class="card-flush">
        ${tests.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Tes</th><th>Tanggal</th><th>Kode</th><th>Status</th><th style="text-align:right;">Aksi</th></tr></thead>
            <tbody>
              ${tests.map(t => {
                const invited = (t.invited||[]).some(i => i.email === user.email);
                const done    = t.results.some(r => r.email === user.email);
                return `<tr>
                  <td class="font-bold">${esc(t.title)}</td>
                  <td class="text-sm text-secondary">${fmtDate(t.date)}</td>
                  <td><span class="code-tag">${t.code}</span></td>
                  <td>${done
                    ? '<span class="badge badge-teal">Sudah mengerjakan</span>'
                    : invited
                      ? '<span class="badge badge-amber">Diundang, belum dikerjakan</span>'
                      : '<span class="text-tertiary text-xs">—</span>'
                  }</td>
                  <td style="text-align:right;">
                    ${invited
                      ? `<button class="btn btn-secondary btn-sm" data-uninvite="${t.code}">Batalkan</button>`
                      : `<button class="btn btn-primary btn-sm"   data-inv="${t.code}">+ Undang</button>`}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : `
        <div class="empty"><p>Belum ada tes. Buat tes dulu di dasbor.</p></div>`}
      </div>
    `;
    wrap.querySelector('#back').onclick = () => go('adminParticipants');
    wrap.querySelectorAll('[data-inv]').forEach(b => b.onclick = () => {
      const t = db.tests[b.dataset.inv];
      if (!Array.isArray(t.invited)) t.invited = [];
      if (!t.invited.some(i => i.email === user.email))
        t.invited.push({ email: user.email, name: user.name, invitedAt: Date.now() });
      saveDB(); redraw();
    });
    wrap.querySelectorAll('[data-uninvite]').forEach(b => b.onclick = () => {
      const t = db.tests[b.dataset.uninvite];
      t.invited = (t.invited||[]).filter(i => i.email !== user.email);
      saveDB(); redraw();
    });
  }
  redraw();
}

/* ────────────────────────────────────────────────────────────
   SEED DATA
   ──────────────────────────────────────────────────────────── */
function seedExample() {
  const code = genCode();
  db.tests[code] = {
    code, title: 'Tes Potensi Dasar — Batch September',
    date: todayStr(), snapshotSec: 120, showScore: true,
    useIqNorm: true,
    iqNormTable: [
      { raw: 7, iq: 55 }, { raw: 10, iq: 63 }, { raw: 13, iq: 72 }, { raw: 16, iq: 81 },
      { raw: 19, iq: 91 }, { raw: 22, iq: 100 }, { raw: 25, iq: 109 }, { raw: 28, iq: 117 },
    ],
    sections: [
      { id: 's1', name: 'Logika Angka', durationSec: 180, questions: [
        { type: 'single', q: '2, 4, 8, 16, … angka selanjutnya adalah?', opts: [{text:'20',image:null},{text:'24',image:null},{text:'32',image:null},{text:'30',image:null}], correct: 2 },
        { type: 'truefalse', q: '7 adalah bilangan prima.', correct: 0 },
      ]},
      { id: 's2', name: 'Pemahaman Verbal', durationSec: 180, questions: [
        { type: 'multi', q: 'Manakah yang termasuk sinonim dari "cermat"? (pilih semua yang sesuai)', opts: [{text:'Teliti',image:null},{text:'Ceroboh',image:null},{text:'Hati-hati',image:null},{text:'Terburu-buru',image:null}], correct: [0, 2] },
        { type: 'scale', q: 'Seberapa nyaman Anda bekerja dalam tekanan waktu?', min: 1, max: 5, minLabel: 'Sangat tidak nyaman', maxLabel: 'Sangat nyaman' },
        { type: 'essay', q: 'Ceritakan singkat pengalaman Anda menyelesaikan tugas dengan tenggat waktu ketat.' },
      ]},
    ],
    results: [], invited: [],
  };
  saveDB();
}

/* ────────────────────────────────────────────────────────────
   ADMIN — CREATE / EDIT TEST
   ──────────────────────────────────────────────────────────── */
function screenAdminCreateTest() {
  root.appendChild(buildTopbar('admin'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  root.appendChild(wrap);

  const editCode = state.editCode || null;
  const existing = editCode ? db.tests[editCode] : null;
  let sections   = existing ? JSON.parse(JSON.stringify(existing.sections)) : [blankSection()];
  let showScore  = existing ? existing.showScore  : true;
  let scoreOpen  = true;   /* panel "Pengaturan nilai" terbuka/tertutup */
  let useIqNorm  = existing ? !!existing.useIqNorm : false;
  let iqTable    = (existing?.iqNormTable?.length)
    ? existing.iqNormTable.map(r => ({ raw: String(r.raw), iq: String(r.iq) }))
    : [{ raw: '', iq: '' }, { raw: '', iq: '' }];

  const MIN_OPTS = 2, MAX_OPTS = 12;
  /* Soal dianggap terisi bila punya teks, gambar soal, atau isi pada pilihannya */
  function hasQuestionContent(q) {
    return !!(q.q?.trim() || q.image || (q.opts || []).some(o => o?.image || o?.text?.trim()));
  }
  function blankOpt()      { return { text: '', image: null }; }
  function blankSection(kind = 'test') { return { name: '', kind, untimed: kind === 'example', description: '', displayMode: 'single', durationSec: 600, questions: [blankQuestion()] }; }
  function blankQuestion() { return { type: 'single', q: '', opts: [blankOpt(),blankOpt(),blankOpt(),blankOpt()], correct: 0, image: null }; }

  function makeQForType(type, prev) {
    const q = { type, q: prev?.q || '', image: prev?.image || null };
    if (type === 'single')    { q.opts = prev?.opts?.length >= 2 ? prev.opts : [blankOpt(),blankOpt(),blankOpt(),blankOpt()]; q.correct = 0; }
    else if (type === 'multi') { q.opts = prev?.opts?.length >= 2 ? prev.opts : [blankOpt(),blankOpt(),blankOpt(),blankOpt()]; q.correct = []; }
    else if (type === 'truefalse') { q.correct = 0; }
    else if (type === 'scale') { q.min = 1; q.max = 5; q.minLabel = ''; q.maxLabel = ''; }
    else if (type === 'essay') { q.answerKey = prev?.answerKey || ''; }
    return q;
  }

  /* ── Unggah gambar: seret-lepas, tempel, atau pilih banyak file ── */
  function dropZone(key, hint) {
    return `<div class="img-drop" data-drop="${key}" tabindex="0">
      <input type="file" accept="image/*" multiple hidden data-drop-input>
      <span class="img-drop__title">Seret atau tempel gambar</span>
      <span class="img-drop__hint">${hint}</span>
      <button type="button" class="btn btn-secondary btn-sm" data-pick style="margin-top:var(--sp-2);">Pilih file…</button>
    </div>`;
  }

  async function applyImages(key, files) {
    const imgs = Array.from(files).filter(f => f.type.startsWith('image/'));
    if (!imgs.length) return;
    const [kind, path] = key.split(':');
    const idx = path.split('.').map(Number);
    try {
      if (kind === 'q') {
        sections[idx[0]].questions[idx[1]].image = await readImageCompressed(imgs[0]);
        if (imgs.length > 1) alert('Soal hanya punya satu gambar; gambar pertama yang dipakai.');
      } else {
        const [si, qi, oi] = idx;
        const opts = sections[si].questions[qi].opts;
        /* tambah pilihan kosong bila gambar lebih banyak dari sisa pilihan */
        const free = opts.slice(oi + 1).filter(o => !o.image).length + 1;
        for (let n = imgs.length - free; n > 0 && opts.length < MAX_OPTS; n--) opts.push(blankOpt());
        let at = oi, used = 0;
        for (const f of imgs) {
          /* pilihan target ditimpa; berikutnya hanya mengisi yang masih kosong */
          while (at < opts.length && used > 0 && opts[at].image) at++;
          if (at >= opts.length) break;
          opts[at].image = await readImageCompressed(f, 500, 0.75);
          at++; used++;
        }
        if (used > 0 && at < opts.length && !opts[at].image) setTarget(`o:${si}.${qi}.${at}`);
        if (used < imgs.length) alert(`Hanya ${used} dari ${imgs.length} gambar yang dipakai (maksimal ${MAX_OPTS} pilihan).`);
      }
    } catch (e) { alert('Gagal memuat gambar.'); }
    const y = window.scrollY;
    renderForm();
    window.scrollTo(0, y);
  }

  /* ── Urutan soal & pilihan: tombol ↑↓ atau seret pegangan ⠿ ── */
  function rerender() { const y = window.scrollY; renderForm(); window.scrollTo(0, y); }

  /* Pindahkan item arr[from] ke posisi akhir `to` */
  function moveItem(arr, from, to) {
    const [item] = arr.splice(from, 1);
    arr.splice(to, 0, item);
  }

  function moveOption(si, qi, from, to) {
    const qq = sections[si].questions[qi];
    if (from === to || to < 0 || to >= qq.opts.length) return;
    const mapIdx = i => i === from ? to
      : (from < to && i > from && i <= to) ? i - 1
      : (from > to && i >= to && i < from) ? i + 1 : i;
    moveItem(qq.opts, from, to);
    qq.correct = Array.isArray(qq.correct) ? qq.correct.map(mapIdx).sort((a, b) => a - b) : mapIdx(qq.correct);
    pasteTarget = null;
    rerender();
  }

  function moveQuestion(from, to) {   /* from/to: [si, qi]; `to` = posisi akhir */
    const [fs, fq] = from, [ts, tq] = to;
    const item = sections[fs].questions.splice(fq, 1)[0];
    sections[ts].questions.splice(tq, 0, item);
    collapsedQs.clear();
    pasteTarget = null;
    rerender();
  }

  let dragInfo = null;   /* { kind: 'q'|'o', path: [..] } selama menyeret */
  function clearDropMarks() { wrap.querySelectorAll('.drop-before,.drop-after').forEach(el => el.classList.remove('drop-before', 'drop-after')); }

  function wireReorder() {
    wrap.querySelectorAll('[data-q-up],[data-q-down]').forEach(b => b.onclick = () => {
      const up = b.dataset.qUp != null;
      const [si, qi] = (b.dataset.qUp ?? b.dataset.qDown).split('.').map(Number);
      moveQuestion([si, qi], [si, qi + (up ? -1 : 1)]);
    });
    wrap.querySelectorAll('[data-o-up],[data-o-down]').forEach(b => b.onclick = () => {
      const up = b.dataset.oUp != null;
      const [si, qi, oi] = (b.dataset.oUp ?? b.dataset.oDown).split('.').map(Number);
      moveOption(si, qi, oi, oi + (up ? -1 : 1));
    });

    wrap.querySelectorAll('[data-qdrag],[data-odrag]').forEach(h => {
      h.addEventListener('dragstart', e => {
        const isQ = h.dataset.qdrag != null;
        dragInfo = { kind: isQ ? 'q' : 'o', path: (h.dataset.qdrag ?? h.dataset.odrag).split('.').map(Number) };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'urutan');
        const card = h.closest(isQ ? '[data-qblock]' : '[data-optcard]');
        if (card) { e.dataTransfer.setDragImage(card, 12, 12); card.classList.add('dragging'); }
      });
      h.addEventListener('dragend', () => { dragInfo = null; clearDropMarks(); wrap.querySelectorAll('.dragging').forEach(el => el.classList.remove('dragging')); });
    });

    const dropTargets = [
      ...[...wrap.querySelectorAll('[data-qblock]')].map(el => ({ el, kind: 'q', path: el.dataset.qblock.split('.').map(Number) })),
      ...[...wrap.querySelectorAll('[data-optcard]')].map(el => ({ el, kind: 'o', path: el.dataset.optcard.split('.').map(Number) })),
    ];
    dropTargets.forEach(({ el, kind, path }) => {
      const valid = () => dragInfo && dragInfo.kind === kind &&
        (kind === 'q' || (dragInfo.path[0] === path[0] && dragInfo.path[1] === path[1]));
      const after = e => { const r = el.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
      el.addEventListener('dragover', e => {
        if (!valid()) return;
        e.preventDefault(); e.stopPropagation();
        clearDropMarks();
        el.classList.add(after(e) ? 'drop-after' : 'drop-before');
      });
      el.addEventListener('drop', e => {
        if (!valid()) return;
        e.preventDefault(); e.stopPropagation();
        const insertAfter = after(e);
        clearDropMarks();
        if (kind === 'q') {
          const [fs, fq] = dragInfo.path, [ts, tq] = path;
          let at = tq + (insertAfter ? 1 : 0);
          if (fs === ts && fq < at) at--;      /* item asal dicabut dulu */
          dragInfo = null;
          moveQuestion([fs, fq], [ts, at]);
        } else {
          const from = dragInfo.path[2];
          let at = path[2] + (insertAfter ? 1 : 0);
          if (from < at) at--;
          dragInfo = null;
          moveOption(path[0], path[1], from, at);
        }
      });
    });
  }

  /* ── Target tempel: klik soal/pilihan dulu, baru Ctrl+V ── */
  let pasteTarget = null;   /* 'q:si.qi' atau 'o:si.qi.oi' */

  function targetLabel(key) {
    const [kind, path] = key.split(':');
    const [si, qi, oi] = path.split('.').map(Number);
    const base = `Section ${si + 1} · Soal ${qi + 1}`;
    return kind === 'q' ? `${base} · gambar soal` : `${base} · Pilihan ${String.fromCharCode(65 + oi)}`;
  }

  function markTarget() {
    wrap.querySelectorAll('.paste-active').forEach(el => el.classList.remove('paste-active'));
    const bar = wrap.querySelector('#pasteBar');
    if (!pasteTarget) { if (bar) bar.textContent = 'Klik sebuah soal atau pilihan, lalu tekan Ctrl+V untuk menempel gambar.'; return; }
    const [kind, path] = pasteTarget.split(':');
    const el = kind === 'q'
      ? wrap.querySelector(`[data-qblock="${path.split('.').slice(0, 2).join('.')}"] [data-drop="${pasteTarget}"]`)
      : wrap.querySelector(`[data-optcard="${path}"]`);
    if (!el) { pasteTarget = null; markTarget(); return; }   /* target sudah tidak ada (soal dihapus) */
    el.classList.add('paste-active');
    if (kind === 'q') wrap.querySelector(`[data-qblock="${path}"]`)?.classList.add('paste-active');
    if (bar) bar.innerHTML = `📋 Ctrl+V akan menempel ke: <strong>${esc(targetLabel(pasteTarget))}</strong>`;
  }

  function setTarget(key) {
    pasteTarget = key;
    markTarget();
  }

  function flashBar(msg) {
    const bar = wrap.querySelector('#pasteBar');
    if (!bar) return;
    bar.textContent = msg; bar.classList.add('paste-bar--flash');
    setTimeout(() => { bar.classList.remove('paste-bar--flash'); markTarget(); }, 2200);
  }

  /* Klik di mana pun dalam soal/pilihan menjadikannya target tempel */
  wrap.addEventListener('pointerdown', e => {
    if (e.target.closest('[data-rm-q],[data-rm-sec],[data-rm-opt],[data-rm-img],[data-rm-optimg]')) return;
    const drop  = e.target.closest('[data-drop]');
    const optc  = e.target.closest('[data-optcard]');
    const block = e.target.closest('[data-qblock]');
    const key = drop?.dataset.drop || (optc ? `o:${optc.dataset.optcard}` : block ? `q:${block.dataset.qblock}` : null);
    if (key) setTarget(key);
  });

  function wireDropZones() {
    wireReorder();
    wrap.querySelectorAll('[data-drop]').forEach(z => {
      const key = z.dataset.drop;
      const input = z.querySelector('[data-drop-input]');
      if (input) {
        input.onchange = () => applyImages(key, input.files);
        z.querySelector('[data-pick]')?.addEventListener('click', () => input.click());
      }
      z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('img-drop--over'); });
      z.addEventListener('dragleave', () => z.classList.remove('img-drop--over'));
      z.addEventListener('drop', e => {
        e.preventDefault(); z.classList.remove('img-drop--over');
        applyImages(key, e.dataTransfer.files);
      });
      z.addEventListener('focusin', () => setTarget(key));
    });
    markTarget();
  }

  /* Tempel (Ctrl+V): hanya ke target yang dipilih (klik). Tanpa target → petunjuk, tidak menebak. */
  document.removeEventListener('paste', window.__ruangtesPaste || (() => {}));
  window.__ruangtesPaste = e => {
    if (!document.body.contains(wrap)) return;
    const files = Array.from(e.clipboardData?.files || []).filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    if (!pasteTarget) { flashBar('Klik dulu soal atau pilihan tujuan, lalu tekan Ctrl+V lagi.'); return; }
    applyImages(pasteTarget, files);
  };
  document.addEventListener('paste', window.__ruangtesPaste);

  /* Soal yang dilipat ("si.qi"); hanya menampilkan baris judulnya */
  const collapsedQs = new Set();
  /* Section yang dilipat (indeks section) */
  const collapsedSecs = new Set();

  /* Isian info tes disimpan agar tidak hilang saat form dirender ulang */
  const snapTotal = existing ? (existing.snapshotSec ?? (existing.snapshotMinutes ?? 3) * 60) : 180;
  const meta = {
    title: existing ? existing.title : '',
    date: existing ? existing.date : todayStr(),
    snapM: String(Math.floor(snapTotal / 60)), snapS: String(snapTotal % 60),
    maxViol: String(existing ? maxViolationsOf(existing) : 3),
  };
  function captureMeta() {
    ['title', 'date', 'snapM', 'snapS', 'maxViol'].forEach(k => {
      const el = wrap.querySelector('#' + k);
      if (el) meta[k] = el.value;
    });
  }

  function renderForm() {
    captureMeta();
    wrap.innerHTML = `
      <div style="margin-bottom:var(--sp-4);">
        <button class="btn btn-ghost" id="backBtn">← Dasbor</button>
      </div>
      <div class="page-header">
        <h2 class="page-title">${editCode ? 'Edit tes' : 'Tes baru'}</h2>
      </div>
      ${editCode && existing?.results?.length ? `
      <div class="note note-warn" style="margin-bottom:var(--sp-4);">
        <strong>Perhatian:</strong> Tes ini sudah punya ${existing.results.length} hasil. Mengubah urutan atau jumlah soal dapat mengacaukan referensi jawaban lama. Aman untuk memperbaiki teks, gambar, atau kunci jawaban.
      </div>` : ''}

      <div class="card" style="margin-bottom:var(--sp-4);">
        <h3 style="font-size:var(--text-lg);margin:0 0 var(--sp-4);">Informasi tes</h3>
        <div class="form-group">
          <label class="form-label" for="title">Nama tes</label>
          <input class="form-field" type="text" id="title" placeholder="Tes Potensi Dasar — Batch September" value="${esc(meta.title)}">
        </div>
        <div class="form-row">
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label" for="date">Tanggal pelaksanaan</label>
            <input class="form-field" type="date" id="date" value="${esc(meta.date)}">
          </div>
          <div class="form-group" style="margin-bottom:0;">
            <label class="form-label">Interval kamera (menit : detik)</label>
            <div class="duration-row">
              <input class="form-field" type="number" id="snapM" value="${esc(meta.snapM)}" min="0" title="Menit">
              <span class="duration-sep">:</span>
              <input class="form-field" type="number" id="snapS" value="${esc(meta.snapS)}" min="0" max="59" title="Detik">
            </div>
          </div>
        </div>
        <div class="form-group" style="margin:var(--sp-4) 0 0;">
          <label class="form-label" for="maxViol">Batas keluar tab</label>
          <input class="form-field" type="number" id="maxViol" value="${esc(meta.maxViol)}" min="0" step="1" style="max-width:140px;">
          <div class="text-xs text-tertiary" style="margin-top:var(--sp-1);">Tes ditutup otomatis pada keluar tab ke-N, jawaban yang sudah ada tetap tersimpan. Isi 0 untuk tanpa batas (pelanggaran tetap dicatat).</div>
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--sp-4);">
        <button type="button" class="collapse-head" id="scoreToggle" aria-expanded="${scoreOpen}" aria-controls="scoreBody">
          <span class="collapse-head__title">Pengaturan nilai</span>
          <span class="collapse-head__sum">${scoreOpen ? '' : `Skor ${showScore ? 'ditampilkan' : 'disembunyikan'} · IQ ${useIqNorm ? 'aktif' : 'nonaktif'}`}</span>
          <span class="collapse-head__chev" aria-hidden="true">▾</span>
        </button>
        <div id="scoreBody" ${scoreOpen ? '' : 'hidden'} style="margin-top:var(--sp-4);">
        <label class="check-line">
          <input type="checkbox" id="showScore" ${showScore ? 'checked' : ''}>
          Tampilkan skor akhir kepada peserta setelah selesai
        </label>
        <div class="note" style="margin-bottom:var(--sp-4);">Jika dimatikan, peserta hanya melihat konfirmasi tes selesai. Skor tetap bisa diakses admin di halaman hasil.</div>
        <label class="check-line">
          <input type="checkbox" id="useIqNorm" ${useIqNorm ? 'checked' : ''}>
          Konversi skor mentah ke IQ menggunakan tabel norma
        </label>
        <div id="iqHost" ${useIqNorm ? '' : 'style="display:none;"'}>
          <div id="iqRows"></div>
          <button class="btn btn-secondary btn-sm" id="addIqRow">+ Tambah baris</button>
          <div class="note" style="margin-top:var(--sp-3);">Isi pasangan skor mentah ↔ IQ. Skor di antara dua baris diinterpolasi secara linear; skor di luar rentang memakai nilai terdekat.</div>
        </div>
        </div>
      </div>

      <div id="sectionsHost"></div>
      <div style="display:flex;gap:var(--sp-2);flex-wrap:wrap;margin-bottom:var(--sp-6);">
        <button class="btn btn-secondary" id="addSection">+ Tambah section</button>
        <button class="btn btn-secondary" id="addExample">+ Tambah section contoh soal</button>
        <button class="btn btn-ghost" data-secs-all="close">Ciutkan semua section</button>
        <button class="btn btn-ghost" data-secs-all="open">Buka semua section</button>
        <button class="btn btn-ghost" data-qs-all="close">Ciutkan semua soal</button>
        <button class="btn btn-ghost" data-qs-all="open">Buka semua soal</button>
      </div>

      <div class="paste-bar" id="pasteBar" role="status" aria-live="polite"></div>
      <div class="card card-accent" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:var(--sp-3);">
        <div>
          <div class="font-bold" style="color:var(--action-deep);">${editCode ? 'Simpan perubahan' : 'Simpan & buat kode unik'}</div>
          <div class="text-sm text-secondary" style="margin-top:2px;">
            ${editCode
              ? `Kode tes tetap <span class="code-tag">${editCode}</span> — undangan dan hasil peserta tidak berubah.`
              : 'Kode 6-karakter dibuat otomatis saat tes disimpan.'}
          </div>
        </div>
        <button class="btn btn-primary" id="saveBtn">${editCode ? 'Simpan perubahan' : 'Simpan tes'}</button>
      </div>
    `;

    wrap.querySelector('#backBtn').onclick = () => go(editCode ? 'adminResults' : 'adminDashboard', editCode ? { code: editCode } : {});
    wrap.querySelector('#scoreToggle').onclick = e => {
      scoreOpen = !scoreOpen;
      const btn = e.currentTarget;
      btn.setAttribute('aria-expanded', scoreOpen);
      wrap.querySelector('#scoreBody').hidden = !scoreOpen;
      wrap.querySelector('.collapse-head__sum').textContent = scoreOpen ? '' :
        `Skor ${showScore ? 'ditampilkan' : 'disembunyikan'} · IQ ${useIqNorm ? 'aktif' : 'nonaktif'}`;
    };
    wrap.querySelector('#showScore').onchange = e => { showScore = e.target.checked; };
    wrap.querySelector('#useIqNorm').onchange = e => { useIqNorm = e.target.checked; renderForm(); };

    if (useIqNorm) {
      const iqRowsEl = wrap.querySelector('#iqRows');
      iqRowsEl.innerHTML = iqTable.map((r, ri) => `
        <div class="form-row" style="margin-bottom:var(--sp-2);align-items:start;">
          <div>
            <label class="form-label">Skor Mentah</label>
            <input class="form-field" type="number" data-iq-raw="${ri}" value="${esc(r.raw)}">
          </div>
          <div style="display:flex;gap:var(--sp-2);align-items:flex-end;">
            <div style="flex:1;">
              <label class="form-label">Skor IQ</label>
              <input class="form-field" type="number" data-iq-iq="${ri}" value="${esc(r.iq)}">
            </div>
            ${iqTable.length > 1 ? `<button class="btn btn-danger-outline btn-sm" data-rm-iq="${ri}" style="flex:none;margin-bottom:1px;">Hapus</button>` : ''}
          </div>
        </div>`).join('');
      iqRowsEl.querySelectorAll('[data-iq-raw]').forEach(el => el.oninput = () => { iqTable[+el.dataset.iqRaw].raw = el.value; });
      iqRowsEl.querySelectorAll('[data-iq-iq]').forEach(el => el.oninput = () => { iqTable[+el.dataset.iqIq].iq = el.value; });
      iqRowsEl.querySelectorAll('[data-rm-iq]').forEach(el => el.onclick = () => { iqTable.splice(+el.dataset.rmIq, 1); renderForm(); });
      wrap.querySelector('#addIqRow').onclick = () => { iqTable.push({ raw: '', iq: '' }); renderForm(); };
    }

    const secHost = wrap.querySelector('#sectionsHost');
    sections.forEach((sec, si) => {
      const sb = document.createElement('div');
      sb.className = 'section-card';
      sb.dataset.sec = si;
      const secOpen = !collapsedSecs.has(si);
      if (!secOpen) sb.classList.add('section-card--collapsed');
      const h = Math.floor((sec.durationSec||0) / 3600);
      const m = Math.floor(((sec.durationSec||0) % 3600) / 60);
      const s = (sec.durationSec||0) % 60;
      sb.innerHTML = `
        <div class="section-card-head">
          <span class="sec-head-title" data-sec-toggle="${si}" title="Klik untuk melipat/membuka section">
            Section ${si + 1}${sec.kind === 'example' ? ' · Contoh soal' : ''}
            <span class="sec-head-name" data-sec-title="${si}">${sec.name ? '· ' + esc(sec.name) : ''}</span>
            <span class="sec-head-count">· ${sec.questions.length} soal</span>
          </span>
          <span style="display:flex;gap:var(--sp-2);align-items:center;">
            ${si > 0 ? `<button class="btn btn-ghost btn-sm" data-sec-up="${si}" title="Pindah ke atas">↑</button>` : ''}
            ${si < sections.length - 1 ? `<button class="btn btn-ghost btn-sm" data-sec-down="${si}" title="Pindah ke bawah">↓</button>` : ''}
            ${sections.length > 1 ? `<button class="btn btn-danger-outline btn-sm sec-delete" data-rm-sec="${si}">Hapus section</button>` : ''}
            <button type="button" class="btn btn-ghost btn-sm q-chev" data-sec-toggle="${si}" aria-expanded="${secOpen}" aria-label="Lipat atau buka section">▾</button>
          </span>
        </div>
        <div class="section-card-body" data-secbody="${si}" ${secOpen ? '' : 'hidden'}>
          <div class="form-row" style="margin-bottom:var(--sp-4);">
            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label">Nama section</label>
              <input class="form-field" type="text" data-sec-name="${si}" value="${esc(sec.name)}" placeholder="Logika Angka">
            </div>
            <div class="form-group" style="margin-bottom:0;">
              <label class="form-label">Durasi (jam : menit : detik)</label>
              <div class="duration-row">
                <input class="form-field" type="number" data-sec-h="${si}" value="${h}" min="0" max="99" title="Jam" ${sec.untimed ? 'disabled' : ''}>
                <span class="duration-sep">:</span>
                <input class="form-field" type="number" data-sec-m="${si}" value="${m}" min="0" max="59" title="Menit" ${sec.untimed ? 'disabled' : ''}>
                <span class="duration-sep">:</span>
                <input class="form-field" type="number" data-sec-s="${si}" value="${s}" min="0" max="59" title="Detik" ${sec.untimed ? 'disabled' : ''}>
              </div>
            </div>
          </div>
          <div class="seg-ctrl" style="margin-bottom:var(--sp-3);">
            <button type="button" class="seg-btn ${sec.kind !== 'example' ? 'seg-btn--active' : ''}" data-sec-kind="${si}.test">Soal tes (dinilai)</button>
            <button type="button" class="seg-btn ${sec.kind === 'example' ? 'seg-btn--active' : ''}" data-sec-kind="${si}.example">Contoh soal (tidak dinilai)</button>
          </div>
          <div class="form-label" style="margin-bottom:var(--sp-1);">Tampilan soal untuk peserta</div>
          <div class="seg-ctrl" style="margin-bottom:var(--sp-3);">
            <button type="button" class="seg-btn ${sec.displayMode !== 'all' ? 'seg-btn--active' : ''}" data-sec-mode="${si}.single">Satu per satu</button>
            <button type="button" class="seg-btn ${sec.displayMode === 'all' ? 'seg-btn--active' : ''}" data-sec-mode="${si}.all">Semua sekaligus</button>
          </div>
          <label class="check-line" style="margin-bottom:var(--sp-3);">
            <input type="checkbox" data-sec-untimed="${si}" ${sec.untimed ? 'checked' : ''}>
            Tanpa batas waktu
          </label>
          <div class="form-group">
            <label class="form-label">Deskripsi / petunjuk di awal section (opsional)</label>
            <textarea class="form-field" data-sec-desc="${si}" rows="3" placeholder="Contoh: Pada bagian ini Anda akan melihat pola angka. Pilih jawaban yang paling tepat.">${esc(sec.description || '')}</textarea>
            <div class="text-xs text-tertiary" style="margin-top:var(--sp-1);">Jika diisi, peserta melihat halaman petunjuk ini sebelum soal dimulai. Waktu baru berjalan setelah peserta menekan Mulai.</div>
          </div>
          <div data-qhost="${si}"></div>
          <button class="btn btn-secondary btn-sm" data-addq="${si}" style="margin-top:var(--sp-2);">+ Tambah soal</button>
        </div>
      `;
      secHost.appendChild(sb);

      const qhost = sb.querySelector(`[data-qhost="${si}"]`);
      sec.questions.forEach((qq, qi) => {
        const qb = document.createElement('div');
        qb.className = 'q-block';
        qb.dataset.qblock = `${si}.${qi}`;
        const qOpen = !collapsedQs.has(`${si}.${qi}`);
        if (!qOpen) qb.classList.add('q-block--collapsed');
        let sub = '';
        if (qq.type === 'single' || qq.type === 'multi') {
          const itype = qq.type === 'single' ? 'radio' : 'checkbox';
          sub = `<div class="note" style="margin-bottom:var(--sp-3);">Isi teks dan/atau unggah gambar untuk tiap pilihan. Cocok untuk soal pola/bentuk.</div>` +
            qq.opts.map((op, oi) => `
            <div class="opt-card${(itype==='radio' ? qq.correct===oi : (qq.correct||[]).includes(oi)) ? ' opt-card--key' : ''}" data-optcard="${si}.${qi}.${oi}">
              <div class="opt-card-top">
                <input type="${itype}" ${itype==='radio' ? `name="correct-${si}-${qi}"` : ''}
                  ${itype==='radio' ? (qq.correct===oi ? 'checked' : '') : ((qq.correct||[]).includes(oi) ? 'checked' : '')}
                  data-q-correct="${si}.${qi}.${oi}">
                <span class="drag-handle" draggable="true" data-odrag="${si}.${qi}.${oi}" title="Seret untuk memindah urutan pilihan" aria-label="Seret untuk memindah pilihan">⠿</span>
                <span style="flex:1;">Pilihan ${String.fromCharCode(65+oi)} ${itype==='radio' ? '(tandai jika benar)' : '(centang jika termasuk benar)'} <span class="key-badge">✓ Kunci jawaban</span></span>
                ${oi > 0 ? `<button type="button" class="btn btn-ghost btn-sm" data-o-up="${si}.${qi}.${oi}" title="Naikkan pilihan">↑</button>` : ''}
                ${oi < qq.opts.length - 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-o-down="${si}.${qi}.${oi}" title="Turunkan pilihan">↓</button>` : ''}
                ${qq.opts.length > MIN_OPTS ? `<button type="button" class="btn btn-ghost btn-sm" data-rm-opt="${si}.${qi}.${oi}" title="Hapus pilihan ini">Hapus pilihan</button>` : ''}
              </div>
              ${op.image ? `
              <div class="img-preview" data-drop="o:${si}.${qi}.${oi}" title="Seret atau tempel gambar baru untuk mengganti">
                <img src="${op.image}" alt="Pilihan ${String.fromCharCode(65+oi)}">
                <button type="button" class="btn btn-secondary btn-sm" data-rm-optimg="${si}.${qi}.${oi}">Hapus gambar</button>
              </div>` : dropZone('o:' + si + '.' + qi + '.' + oi, 'Klik pilihan ini lalu Ctrl+V, atau seret gambar. Beberapa gambar sekaligus mengisi pilihan berikutnya.')}
              <input class="form-field" type="text" data-q-opt="${si}.${qi}.${oi}" value="${esc(op.text||'')}" placeholder="Teks pilihan (opsional jika sudah ada gambar)">
            </div>`).join('') +
            (qq.opts.length < MAX_OPTS
              ? `<button type="button" class="btn btn-secondary btn-sm" data-add-opt="${si}.${qi}">+ Tambah pilihan (${qq.opts.length}/${MAX_OPTS})</button>`
              : `<div class="text-xs text-tertiary">Maksimal ${MAX_OPTS} pilihan.</div>`);
        } else if (qq.type === 'truefalse') {
          sub = `
            <label class="opt-card tf-row${qq.correct===0?' opt-card--key':''}" data-tfrow="${si}.${qi}.0" style="display:flex;align-items:center;gap:var(--sp-2);font-size:var(--text-sm);">
              <input type="radio" name="correct-${si}-${qi}" ${qq.correct===0?'checked':''} data-q-tf="${si}.${qi}.0" style="accent-color:var(--action);">
              <span style="flex:1;">Benar <span class="key-badge">✓ Kunci jawaban</span></span>
            </label>
            <label class="opt-card tf-row${qq.correct===1?' opt-card--key':''}" data-tfrow="${si}.${qi}.1" style="display:flex;align-items:center;gap:var(--sp-2);font-size:var(--text-sm);">
              <input type="radio" name="correct-${si}-${qi}" ${qq.correct===1?'checked':''} data-q-tf="${si}.${qi}.1" style="accent-color:var(--action);">
              <span style="flex:1;">Salah <span class="key-badge">✓ Kunci jawaban</span></span>
            </label>`;
        } else if (qq.type === 'scale') {
          sub = `
            <div class="form-row">
              <div class="form-group" style="margin-bottom:0;">
                <label class="form-label">Label ujung bawah (1)</label>
                <input class="form-field" type="text" data-q-minlabel="${si}.${qi}" value="${esc(qq.minLabel||'')}" placeholder="Sangat tidak setuju">
              </div>
              <div class="form-group" style="margin-bottom:0;">
                <label class="form-label">Label ujung atas (5)</label>
                <input class="form-field" type="text" data-q-maxlabel="${si}.${qi}" value="${esc(qq.maxLabel||'')}" placeholder="Sangat setuju">
              </div>
            </div>
            <div class="note" style="margin-top:var(--sp-3);">Skala tidak memiliki jawaban "benar" — dipakai untuk mengukur kecenderungan, tidak dinilai otomatis.</div>`;
        } else if (qq.type === 'essay') {
          sub = `
            <div class="form-group">
              <label class="form-label">Kunci jawaban (opsional)</label>
              <input class="form-field" type="text" data-q-key="${si}.${qi}" value="${esc(qq.answerKey||'')}" placeholder="Contoh: fotosintesis">
              <p class="form-hint">Isi untuk penilaian otomatis (pencocokan tepat, tidak case-sensitive). Kosongkan jika jawaban dinilai manual oleh admin.</p>
            </div>`;
        }
        qb.innerHTML = `
          <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:var(--sp-2);margin-bottom:var(--sp-3);">
            <div class="q-head-title" data-q-toggle="${si}.${qi}" title="Klik untuk melipat/membuka soal">
              <span class="drag-handle" draggable="true" data-qdrag="${si}.${qi}" title="Seret untuk memindah urutan soal" aria-label="Seret untuk memindah soal">⠿</span>
              <span class="font-bold text-sm">Soal ${qi + 1}</span>
              <span class="type-badge">${TYPE_LABEL[qq.type]}${qq.type==='essay' && qq.answerKey?.trim() ? ' · dinilai otomatis' : ''}</span>
            </div>
            <span style="display:flex;gap:var(--sp-1);align-items:center;">
              <span class="q-actions">
              ${qi > 0 ? `<button type="button" class="btn btn-ghost btn-sm" data-q-up="${si}.${qi}" title="Naikkan soal">↑</button>` : ''}
              ${qi < sec.questions.length - 1 ? `<button type="button" class="btn btn-ghost btn-sm" data-q-down="${si}.${qi}" title="Turunkan soal">↓</button>` : ''}
              ${sec.questions.length > 1 ? `<button class="btn btn-danger-outline btn-sm" data-rm-q="${si}.${qi}">Hapus</button>` : ''}
              </span>
              <button type="button" class="btn btn-ghost btn-sm q-chev" data-q-toggle="${si}.${qi}" aria-expanded="${qOpen}" aria-label="Lipat atau buka soal">▾</button>
            </span>
          </div>
          <div data-qbody="${si}.${qi}" ${qOpen ? '' : 'hidden'}>
          <div class="form-group">
            <label class="form-label">Tipe soal</label>
            <select class="form-field" data-q-type="${si}.${qi}">
              ${Object.entries(TYPE_LABEL).map(([v,l]) => `<option value="${v}" ${qq.type===v?'selected':''}>${l}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">Pertanyaan</label>
            <textarea class="form-field" data-q-text="${si}.${qi}" placeholder="Tulis pertanyaan di sini…">${esc(qq.q)}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">Gambar soal (opsional)</label>
            ${qq.image ? `
            <div class="img-preview" style="margin-bottom:var(--sp-2);">
              <img src="${qq.image}" alt="Gambar soal">
              <button type="button" class="btn btn-secondary btn-sm" data-rm-img="${si}.${qi}">Hapus gambar</button>
            </div>` : ''}
            ${dropZone('q:' + si + '.' + qi, 'Klik area soal ini, lalu tekan Ctrl+V — atau seret gambarnya ke sini.')}
          </div>
          ${sub}
          ${sec.kind === 'example' ? `
          <div class="form-group" style="margin-top:var(--sp-3);margin-bottom:0;">
            <label class="form-label">Pembahasan (opsional, ditampilkan setelah peserta menjawab)</label>
            <textarea class="form-field" data-q-expl="${si}.${qi}" rows="2" placeholder="Jelaskan mengapa jawaban ini benar.">${esc(qq.explanation || '')}</textarea>
          </div>` : ''}
          </div>
        `;
        qhost.appendChild(qb);
      });
    });

    bindFormEvents();
  }

  function bindFormEvents() {
    wrap.querySelector('#addSection').onclick = () => { sections.push(blankSection()); renderForm(); };
    wrap.querySelector('#addExample').onclick = () => { sections.push(blankSection('example')); renderForm(); };
    wrap.querySelectorAll('[data-rm-sec]').forEach(b => b.onclick = () => { sections.splice(+b.dataset.rmSec, 1); collapsedQs.clear(); collapsedSecs.clear(); renderForm(); });
    wrap.querySelectorAll('[data-addq]').forEach(b => b.onclick = () => { sections[+b.dataset.addq].questions.push(blankQuestion()); renderForm(); });
    wrap.querySelectorAll('[data-rm-q]').forEach(b => b.onclick = () => {
      const [si, qi] = b.dataset.rmQ.split('.').map(Number);
      sections[si].questions.splice(qi, 1); collapsedQs.clear(); renderForm();
    });
    wrap.querySelectorAll('[data-sec-up],[data-sec-down]').forEach(el => el.onclick = () => {
      const si = +(el.dataset.secUp ?? el.dataset.secDown);
      const to = el.dataset.secUp != null ? si - 1 : si + 1;
      [sections[si], sections[to]] = [sections[to], sections[si]];
      collapsedSecs.clear();
      renderForm();
    });
    wrap.querySelectorAll('[data-sec-kind]').forEach(el => el.onclick = () => {
      const [si, kind] = el.dataset.secKind.split('.');
      const sec = sections[+si];
      if (sec.kind === kind) return;
      sec.kind = kind;
      if (kind === 'example') sec.untimed = true;
      renderForm();
    });
    wrap.querySelectorAll('[data-sec-mode]').forEach(el => el.onclick = () => {
      const [si, mode] = el.dataset.secMode.split('.');
      if (sections[+si].displayMode === mode) return;
      sections[+si].displayMode = mode; renderForm();
    });
    wrap.querySelectorAll('[data-sec-untimed]').forEach(el => el.onchange = () => {
      sections[+el.dataset.secUntimed].untimed = el.checked; renderForm();
    });
    wrap.querySelectorAll('[data-sec-desc]').forEach(el => el.oninput = () => { sections[+el.dataset.secDesc].description = el.value; });
    wrap.querySelectorAll('[data-q-expl]').forEach(el => el.oninput = () => {
      const [si, qi] = el.dataset.qExpl.split('.').map(Number);
      sections[si].questions[qi].explanation = el.value;
    });
    wrap.querySelectorAll('[data-sec-name]').forEach(el => el.oninput = () => {
      sections[+el.dataset.secName].name = el.value;
      const t = wrap.querySelector(`[data-sec-title="${el.dataset.secName}"]`);
      if (t) t.textContent = el.value ? '· ' + el.value : '';
    });

    function readDur(si) {
      const h = Math.max(0, +wrap.querySelector(`[data-sec-h="${si}"]`)?.value || 0);
      const m = Math.min(59, Math.max(0, +wrap.querySelector(`[data-sec-m="${si}"]`)?.value || 0));
      const s = Math.min(59, Math.max(0, +wrap.querySelector(`[data-sec-s="${si}"]`)?.value || 0));
      sections[si].durationSec = Math.max(1, h * 3600 + m * 60 + s);
    }
    wrap.querySelectorAll('[data-sec-h],[data-sec-m],[data-sec-s]').forEach(el => {
      el.oninput = () => {
        const si = +(el.dataset.secH ?? el.dataset.secM ?? el.dataset.secS);
        readDur(si);
      };
    });

    wrap.querySelectorAll('[data-q-type]').forEach(el => el.onchange = () => {
      const [si, qi] = el.dataset.qType.split('.').map(Number);
      sections[si].questions[qi] = makeQForType(el.value, sections[si].questions[qi]);
      renderForm();
    });
    wrap.querySelectorAll('[data-q-text]').forEach(el => el.oninput = () => {
      const [si, qi] = el.dataset.qText.split('.').map(Number);
      sections[si].questions[qi].q = el.value;
    });
    wrap.querySelectorAll('[data-q-opt]').forEach(el => el.oninput = () => {
      const [si, qi, oi] = el.dataset.qOpt.split('.').map(Number);
      sections[si].questions[qi].opts[oi].text = el.value;
    });
    function syncKeyMarks(si, qi) {
      const qq = sections[si].questions[qi];
      const isKey = oi => Array.isArray(qq.correct) ? qq.correct.includes(oi) : qq.correct === oi;
      wrap.querySelectorAll(`[data-optcard^="${si}.${qi}."]`).forEach(c =>
        c.classList.toggle('opt-card--key', isKey(+c.dataset.optcard.split('.')[2])));
      wrap.querySelectorAll(`[data-tfrow^="${si}.${qi}."]`).forEach(c =>
        c.classList.toggle('opt-card--key', isKey(+c.dataset.tfrow.split('.')[2])));
    }
    wrap.querySelectorAll('[data-q-correct]').forEach(el => el.onchange = () => {
      const [si, qi, oi] = el.dataset.qCorrect.split('.').map(Number);
      const qq = sections[si].questions[qi];
      if (qq.type === 'single') { qq.correct = oi; }
      else if (qq.type === 'multi') {
        const set = new Set(qq.correct || []);
        el.checked ? set.add(oi) : set.delete(oi);
        qq.correct = Array.from(set).sort((a, b) => a - b);
      }
      syncKeyMarks(si, qi);
    });
    wrap.querySelectorAll('[data-q-tf]').forEach(el => el.onchange = () => {
      const [si, qi, val] = el.dataset.qTf.split('.').map(Number);
      sections[si].questions[qi].correct = val;
      syncKeyMarks(si, qi);
    });
    wrap.querySelectorAll('[data-q-minlabel]').forEach(el => el.oninput = () => {
      const [si, qi] = el.dataset.qMinlabel.split('.').map(Number);
      sections[si].questions[qi].minLabel = el.value;
    });
    wrap.querySelectorAll('[data-q-maxlabel]').forEach(el => el.oninput = () => {
      const [si, qi] = el.dataset.qMaxlabel.split('.').map(Number);
      sections[si].questions[qi].maxLabel = el.value;
    });
    wrap.querySelectorAll('[data-q-key]').forEach(el => el.oninput = () => {
      const [si, qi] = el.dataset.qKey.split('.').map(Number);
      sections[si].questions[qi].answerKey = el.value;
    });
    wrap.querySelectorAll('[data-rm-img]').forEach(el => el.onclick = () => {
      const [si, qi] = el.dataset.rmImg.split('.').map(Number);
      sections[si].questions[qi].image = null; renderForm();
    });
    wireDropZones();
    function setQOpen(key, open) {
      open ? collapsedQs.delete(key) : collapsedQs.add(key);
      const blk = wrap.querySelector(`[data-qblock="${key}"]`);
      if (!blk) return;
      blk.classList.toggle('q-block--collapsed', !open);
      blk.querySelector('[data-qbody]').hidden = !open;
      blk.querySelector('.q-chev').setAttribute('aria-expanded', open);
    }
    wrap.querySelectorAll('[data-q-toggle]').forEach(el => el.addEventListener('click', e => {
      if (e.target.closest('[data-qdrag]')) return;       /* pegangan seret bukan tombol lipat */
      const key = el.dataset.qToggle;
      setQOpen(key, collapsedQs.has(key));
    }));
    function setSecOpen(si, open) {
      open ? collapsedSecs.delete(si) : collapsedSecs.add(si);
      const card = wrap.querySelector(`[data-sec="${si}"]`);
      if (!card) return;
      card.classList.toggle('section-card--collapsed', !open);
      card.querySelector('[data-secbody]').hidden = !open;
      card.querySelector('.q-chev').setAttribute('aria-expanded', open);
    }
    wrap.querySelectorAll('[data-sec-toggle]').forEach(el => el.addEventListener('click', () => {
      const si = +el.dataset.secToggle;
      setSecOpen(si, collapsedSecs.has(si));
    }));
    wrap.querySelectorAll('[data-secs-all]').forEach(b => b.onclick = () => {
      const open = b.dataset.secsAll === 'open';
      sections.forEach((_, si) => setSecOpen(si, open));
    });
    wrap.querySelectorAll('[data-qs-all]').forEach(b => b.onclick = () => {
      const open = b.dataset.qsAll === 'open';
      wrap.querySelectorAll('[data-qblock]').forEach(blk => setQOpen(blk.dataset.qblock, open));
    });
    wrap.querySelectorAll('[data-add-opt]').forEach(el => el.onclick = () => {
      const [si, qi] = el.dataset.addOpt.split('.').map(Number);
      const qq = sections[si].questions[qi];
      if (qq.opts.length < MAX_OPTS) qq.opts.push(blankOpt());
      renderForm();
    });
    wrap.querySelectorAll('[data-rm-opt]').forEach(el => el.onclick = () => {
      const [si, qi, oi] = el.dataset.rmOpt.split('.').map(Number);
      const qq = sections[si].questions[qi];
      if (qq.opts.length <= MIN_OPTS) return;
      qq.opts.splice(oi, 1);
      if (qq.type === 'multi') qq.correct = (qq.correct || []).filter(i => i !== oi).map(i => i > oi ? i - 1 : i);
      else qq.correct = qq.correct === oi ? 0 : (qq.correct > oi ? qq.correct - 1 : qq.correct);
      renderForm();
    });
    wrap.querySelectorAll('[data-rm-optimg]').forEach(el => el.onclick = () => {
      const [si, qi, oi] = el.dataset.rmOptimg.split('.').map(Number);
      sections[si].questions[qi].opts[oi].image = null; renderForm();
    });

    wrap.querySelector('#saveBtn').onclick = () => {
      const title = wrap.querySelector('#title').value.trim();
      const date  = wrap.querySelector('#date').value;
      const snapM = +(wrap.querySelector('#snapM').value) || 0;
      const snapS = Math.min(59, +(wrap.querySelector('#snapS').value) || 0);
      const snap  = Math.max(1, snapM * 60 + snapS);
      const maxViolRaw = wrap.querySelector('#maxViol').value.trim();
      const maxViolations = maxViolRaw === '' ? 3 : Math.max(0, Math.floor(+maxViolRaw) || 0);
      if (!title) { alert('Nama tes wajib diisi.'); return; }
      const cleanSections = sections.map(s => ({
        id: s.id || ('sec_' + Math.random().toString(36).slice(2, 8)),
        name: s.name || 'Tanpa nama',
        kind: s.kind === 'example' ? 'example' : 'test',
        untimed: !!s.untimed,
        displayMode: s.displayMode === 'all' ? 'all' : 'single',
        description: (s.description || '').trim(),
        durationSec: Math.max(1, s.durationSec || 600),
        questions: s.questions.filter(hasQuestionContent),
      }));
      const shortSec = cleanSections.findIndex(sec => !sec.untimed && sec.durationSec < 10);
      if (shortSec >= 0) {
        alert(`Section ${shortSec + 1} ("${cleanSections[shortSec].name}") hanya berdurasi ${cleanSections[shortSec].durationSec} detik, sehingga peserta langsung dilompati. Isi durasi yang wajar atau centang "Tanpa batas waktu".`);
        return;
      }
      const emptySec = cleanSections.findIndex(sec => !sec.questions.length);
      if (emptySec >= 0) { alert(`Section ${emptySec + 1} belum punya soal. Isi teks atau gambar soal, atau hapus section tersebut.`); return; }
      const code = editCode || genCode();
      const cleanIq = useIqNorm
        ? iqTable.filter(r => r.raw !== '' && r.iq !== '' && !isNaN(+r.raw) && !isNaN(+r.iq)).map(r => ({ raw: +r.raw, iq: +r.iq }))
        : [];
      const base = existing || { results: [], invited: [] };
      db.tests[code] = { ...base, code, title, date, snapshotSec: snap, maxViolations, showScore, useIqNorm, iqNormTable: cleanIq, sections: cleanSections };
      saveDB();
      go(editCode ? 'adminResults' : 'adminTestCreated', { code });
    };
  }

  renderForm();
}

/* ────────────────────────────────────────────────────────────
   ADMIN — TEST CREATED CONFIRMATION
   ──────────────────────────────────────────────────────────── */
function screenAdminTestCreated() {
  root.appendChild(buildTopbar('admin'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  const t = db.tests[state.code];
  wrap.innerHTML = `
    <div class="narrow" style="margin-top:var(--sp-6);">
      <div class="card" style="text-align:center;padding:var(--sp-7) var(--sp-6);">
        <div class="text-sm text-tertiary" style="margin-bottom:var(--sp-2);">Tes berhasil disimpan</div>
        <h2 class="serif" style="font-size:var(--text-2xl);margin:0 0 var(--sp-5);">${esc(t.title)}</h2>
        <div style="font-family:'IBM Plex Mono',monospace;font-size:var(--text-4xl);letter-spacing:0.1em;color:var(--action-deep);background:var(--action-soft);display:inline-block;padding:var(--sp-3) var(--sp-5);border-radius:var(--radius-lg);margin-bottom:var(--sp-4);">${t.code}</div>
        <p class="text-sm text-secondary" style="max-width:360px;margin:0 auto var(--sp-5);">
          Bagikan kode ini bersama tanggal pelaksanaan <strong>${fmtDate(t.date)}</strong> kepada peserta. Peserta masuk dengan akun pesertanya, lalu masukkan kode dan tanggal ini untuk memulai tes.
        </p>
        <div style="display:flex;gap:var(--sp-3);justify-content:center;flex-wrap:wrap;">
          <button class="btn btn-primary"   id="toResults">Lihat halaman hasil</button>
          <button class="btn btn-secondary" id="toDash">Kembali ke dasbor</button>
        </div>
      </div>
    </div>
  `;
  root.appendChild(wrap);
  wrap.querySelector('#toDash').onclick    = () => go('adminDashboard');
  wrap.querySelector('#toResults').onclick = () => go('adminResults', { code: state.code });
}

/* ────────────────────────────────────────────────────────────
   ADMIN — RESULTS LIST
   ──────────────────────────────────────────────────────────── */
function screenAdminResults() {
  root.appendChild(buildTopbar('admin'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  root.appendChild(wrap);
  const t = db.tests[state.code];
  if (!t) { wrap.innerHTML = '<div class="empty"><p>Tes tidak ditemukan.</p></div>'; return; }
  let confirmDel = false;
  let confirmRow = null;     /* hasil yang sedang dikonfirmasi untuk dihapus */
  let confirmAllRes = false;

  function redraw() {
    wrap.innerHTML = `
      <div style="margin-bottom:var(--sp-4);">
        <button class="btn btn-ghost" id="back">← Semua tes</button>
      </div>
      <div class="page-header">
        <div>
          <h2 class="page-title">${esc(t.title)}</h2>
          <p class="page-meta">
            Kode <span class="code-tag">${t.code}</span> ·
            ${fmtDate(t.date)} ·
            Skor ${t.showScore ? 'ditampilkan' : 'disembunyikan'} ke peserta ·
            Disimpan di <code>${esc(drivePath(t.code, t.date))}</code>
          </p>
        </div>
        <div class="page-actions">
          ${confirmDel ? `
            <span class="text-danger text-sm">Hapus tes${t.results.length ? ` + ${t.results.length} hasil` : ''}?</span>
            <button class="btn btn-danger"    id="confDel">Ya, hapus</button>
            <button class="btn btn-secondary" id="canDel">Batal</button>
          ` : `
            <button class="btn btn-secondary" id="previewBtn">Pratinjau</button>
            <button class="btn btn-secondary" id="editBtn">Edit soal</button>
            <button class="btn btn-secondary" id="invBtn">Kelola undangan</button>
            <button class="btn btn-danger-outline" id="askDel">Hapus tes</button>
          `}
        </div>
      </div>

      <div class="card" style="margin-bottom:var(--sp-4);">
        <h3 style="font-size:var(--text-base);font-weight:var(--w-bold);margin:0 0 var(--sp-3);">Peserta diundang (${(t.invited||[]).length})</h3>
        ${(t.invited||[]).length ? `
          <div style="display:flex;flex-wrap:wrap;gap:var(--sp-2);">
            ${t.invited.map(inv => {
              const done = t.results.some(r => r.email === inv.email);
              return `<span class="badge ${done ? 'badge-teal' : 'badge-amber'}">${esc(inv.name)} ${done ? '(selesai)' : '(belum)'}</span>`;
            }).join('')}
          </div>` : `<p class="text-sm text-tertiary" style="margin:0;">Belum ada peserta khusus yang diundang. Peserta yang punya kode dan tanggal tetap bisa ikut.</p>`}
      </div>

      <div class="card-flush">
        ${t.results.length ? `
        <div style="display:flex;justify-content:flex-end;align-items:center;gap:var(--sp-2);padding:var(--sp-3) var(--sp-4);border-bottom:1px solid var(--border);">
          ${confirmAllRes ? `
            <span class="text-danger text-sm">Hapus semua ${t.results.length} riwayat pengerjaan tes ini?</span>
            <button class="btn btn-danger btn-sm" id="allResYes">Ya, hapus semua</button>
            <button class="btn btn-secondary btn-sm" id="allResNo">Batal</button>
          ` : `<button class="btn btn-danger-outline btn-sm" id="allResAsk">Hapus semua riwayat</button>`}
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr>
              <th>Peserta</th><th>Selesai</th><th>Skor</th>
              ${t.useIqNorm ? '<th>IQ</th>' : ''}
              <th>Pelanggaran</th><th>Foto</th>
              <th style="text-align:right;">Aksi</th>
            </tr></thead>
            <tbody>
              ${t.results.map((r, ri) => {
                const iq = t.useIqNorm ? computeIQ(t, r.score) : null;
                return `<tr>
                  <td>
                    <div class="font-bold">${esc(r.name)}</div>
                    <div class="text-xs text-tertiary">${esc(r.email||'')}</div>
                  </td>
                  <td class="text-sm text-secondary">${new Date(r.submittedAt).toLocaleString('id-ID')}</td>
                  <td class="font-mono font-bold">${r.score}/${r.maxScore}</td>
                  ${t.useIqNorm ? `<td>${iq != null ? `<span class="font-bold">${iq}</span>` : '—'}</td>` : ''}
                  <td>${r.violations}${r.autoClosed ? ' <span class="badge badge-red">otomatis</span>' : ''}</td>
                  <td class="text-sm">${r.snapshots.length} foto</td>
                  <td style="text-align:right;white-space:nowrap;">
                    ${confirmRow === r ? `
                      <span class="text-danger text-xs">Hapus riwayat ini?</span>
                      <button class="btn btn-danger btn-sm" data-res-yes="${ri}">Ya</button>
                      <button class="btn btn-secondary btn-sm" data-res-no>Batal</button>
                    ` : `
                      <button class="btn btn-secondary btn-sm" data-det="${ri}">Detail</button>
                      <button class="btn btn-danger-outline btn-sm" data-res-ask="${ri}">Hapus</button>
                    `}
                  </td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : `
        <div class="empty">
          <p class="font-bold text-secondary" style="font-size:var(--text-lg);margin:0 0 var(--sp-2);">Belum ada hasil</p>
          <p>Peserta yang menyelesaikan tes akan muncul di sini.</p>
        </div>`}
      </div>
    `;
    wrap.querySelector('#back').onclick = () => go('adminDashboard');
    if (confirmDel) {
      wrap.querySelector('#confDel').onclick = () => { delete db.tests[t.code]; markDeleted('tests', t.code); saveDB(); go('adminDashboard'); };
      wrap.querySelector('#canDel').onclick  = () => { confirmDel = false; redraw(); };
    } else {
      wrap.querySelector('#previewBtn').onclick = () => startPreview(t.code);
      wrap.querySelector('#editBtn').onclick = () => go('adminCreateTest', { editCode: t.code });
      wrap.querySelector('#invBtn').onclick  = () => go('adminParticipants');
      wrap.querySelector('#askDel').onclick  = () => { confirmDel = true; redraw(); };
    }
    wrap.querySelectorAll('[data-det]').forEach(b => b.onclick = () => go('adminResultDetail', { code: t.code, ri: +b.dataset.det }));
    wrap.querySelectorAll('[data-res-ask]').forEach(b => b.onclick = () => { confirmRow = t.results[+b.dataset.resAsk]; redraw(); });
    wrap.querySelectorAll('[data-res-no]').forEach(b => b.onclick = () => { confirmRow = null; redraw(); });
    wrap.querySelectorAll('[data-res-yes]').forEach(b => b.onclick = () => {
      deleteResults([{ t, r: t.results[+b.dataset.resYes] }]); confirmRow = null; redraw();
    });
    wrap.querySelector('#allResAsk')?.addEventListener('click', () => { confirmAllRes = true; redraw(); });
    wrap.querySelector('#allResNo')?.addEventListener('click', () => { confirmAllRes = false; redraw(); });
    wrap.querySelector('#allResYes')?.addEventListener('click', () => {
      deleteResults(t.results.map(r => ({ t, r }))); confirmAllRes = false; redraw();
    });
  }
  redraw();
}

/* ────────────────────────────────────────────────────────────
   ADMIN — RESULT DETAIL
   ──────────────────────────────────────────────────────────── */
function screenAdminResultDetail() {
  root.appendChild(buildTopbar('admin'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  const t = db.tests[state.code];
  const r = t.results[state.ri];
  const iq  = t.useIqNorm ? computeIQ(t, r.score) : null;
  const cat = iq != null ? iqCategory(iq) : null;
  wrap.innerHTML = `
    <div style="margin-bottom:var(--sp-4);">
      <button class="btn btn-ghost" id="back">← Kembali ke hasil</button>
      <span id="delBox" style="float:right;"><button class="btn btn-danger-outline btn-sm" id="delAsk">Hapus riwayat ini</button></span>
    </div>
    <div class="card" style="margin-bottom:var(--sp-4);">
      <div class="flex-between">
        <div>
          <h2 style="margin:0 0 var(--sp-1);">${esc(r.name)}</h2>
          <p class="text-sm text-secondary" style="margin:0;">
            ${esc(r.email||'')} · Tanggal tes: ${fmtDate(t.date)} · Selesai: ${new Date(r.submittedAt).toLocaleString('id-ID')}
          </p>
        </div>
        <div style="text-align:right;">
          <div class="result-score">${r.score}/${r.maxScore}</div>
          <div class="text-xs text-tertiary">${t.showScore ? 'terlihat peserta' : 'disembunyikan dari peserta'}</div>
          ${iq != null ? `
          <div class="text-sm" style="margin-top:var(--sp-1);">
            IQ <strong style="color:var(--action-deep);">${iq}</strong>${cat ? ` · ${esc(cat)}` : ''}
          </div>` : ''}
        </div>
      </div>
      ${r.violations > 0 ? `
      <div class="violation-banner" style="margin-top:var(--sp-4);">
        ${r.violations} kali keluar dari tab tes${r.autoClosed ? ` — tes ditutup otomatis pada percobaan ke-${r.maxViolations ?? 3}` : ''}.
      </div>` : ''}
    </div>

    <div class="card" style="margin-bottom:var(--sp-4);">
      <h3 style="font-size:var(--text-base);font-weight:var(--w-bold);margin:0 0 var(--sp-3);">Rekaman kamera (${r.snapshots.length})</h3>
      ${r.snapshots.length
        ? `<div class="thumb-strip">${r.snapshots.map(s => {
            const src = s.url ? s.url : s.driveId ? Drive.thumbUrl(s.driveId) : s.data;
            return `<img src="${src}" title="${new Date(s.t).toLocaleTimeString('id-ID')}" alt="Rekaman">`;
          }).join('')}</div>`
        : `<p class="text-sm text-tertiary" style="margin:0;">Tidak ada rekaman kamera.</p>`}
    </div>

    <div class="card">
      <h3 style="font-size:var(--text-base);font-weight:var(--w-bold);margin:0 0 var(--sp-4);">Jawaban per section</h3>
      ${t.sections.map((sec, si) => `
        <div style="margin-bottom:var(--sp-5);">
          <div class="text-sm font-bold" style="margin-bottom:var(--sp-3);">${esc(sec.name)}${sec.kind === 'example' ? ' <span class="badge">contoh soal · tidak dinilai</span>' : ''}</div>
          ${sec.questions.map((q, qi) => renderAnswerReview(q, qi, r.answers?.[si]?.[qi])).join('')}
        </div>`).join('')}
    </div>
  `;
  root.appendChild(wrap);
  wrap.querySelector('#back').onclick = () => go('adminResults', { code: t.code });
  wrap.querySelector('#delAsk').onclick = () => {
    wrap.querySelector('#delBox').innerHTML = `
      <span class="text-danger text-sm">Hapus riwayat ini?</span>
      <button class="btn btn-danger btn-sm" id="delYes">Ya, hapus</button>
      <button class="btn btn-secondary btn-sm" id="delNo">Batal</button>`;
    wrap.querySelector('#delYes').onclick = () => { deleteResults([{ t, r }]); go('adminResults', { code: t.code }); };
    wrap.querySelector('#delNo').onclick = () => go('adminResultDetail', { code: t.code, ri: state.ri });
  };
}

function renderAnswerReview(q, qi, given) {
  const imgHtml = q.image
    ? `<img src="${q.image}" style="max-width:180px;max-height:130px;object-fit:cover;border-radius:var(--radius);border:1px solid var(--border);display:block;margin:var(--sp-2) 0;" alt="Gambar soal">`
    : '';
  const head = `<div class="text-sm" style="margin-bottom:var(--sp-1);">${qi+1}. ${esc(q.q)}<span class="type-badge">${TYPE_LABEL[q.type]}</span></div>${imgHtml}`;
  let body = '';
  if (q.type === 'single' || q.type === 'truefalse') {
    const opts = q.type === 'truefalse' ? ['Benar','Salah'] : q.opts;
    const ok = given === q.correct;
    const givenOp = given != null ? opts[given] : null;
    const corrOp  = opts[q.correct];
    body = `<div class="text-sm" style="color:${ok ? 'var(--action-deep)' : 'var(--danger)'};">
      Jawaban: ${givenOp != null ? esc(optText(givenOp, given)) : '(tidak dijawab)'}${optThumb(givenOp)}
      ${!ok ? ` · Benar: ${esc(optText(corrOp, q.correct))}${optThumb(corrOp)}` : ' · ✓ Benar'}
    </div>`;
  } else if (q.type === 'multi') {
    const givenArr = (given||[]).slice().sort((a,b)=>a-b);
    const corrArr  = (q.correct||[]).slice().sort((a,b)=>a-b);
    const ok = JSON.stringify(givenArr) === JSON.stringify(corrArr);
    body = `<div class="text-sm" style="color:${ok ? 'var(--action-deep)' : 'var(--danger)'};">
      Jawaban: ${givenArr.length ? givenArr.map(i => esc(optText(q.opts[i], i))).join(', ') : '(tidak dijawab)'}
      ${!ok ? ` · Benar: ${corrArr.map(i => esc(optText(q.opts[i], i))).join(', ')}` : ' · ✓ Benar'}
    </div>`;
  } else if (q.type === 'scale') {
    body = `<div class="text-sm text-secondary">Nilai: ${given != null ? `${given}/5` : '(tidak dijawab)'} <em>(tidak dinilai otomatis)</em></div>`;
  } else if (q.type === 'essay') {
    const hasKey = q.answerKey?.trim();
    if (hasKey) {
      const ok = !!(given) && given.trim().toLowerCase() === q.answerKey.trim().toLowerCase();
      body = `<div class="text-sm" style="color:${ok ? 'var(--action-deep)' : 'var(--danger)'};white-space:pre-wrap;">
        ${given ? esc(given) : '(tidak dijawab)'}
        ${!ok ? ` · Kunci: ${esc(q.answerKey)}` : ' · ✓ Benar'}
      </div>`;
    } else {
      body = `<div class="text-sm text-secondary" style="white-space:pre-wrap;">${given ? esc(given) : '(tidak dijawab)'}</div>`;
    }
  }
  return `<div class="q-block" style="margin-bottom:var(--sp-3);">${head}${body}</div>`;
}

/* ────────────────────────────────────────────────────────────
   PARTICIPANT — ENTRY
   ──────────────────────────────────────────────────────────── */
function screenParticipantEntry() {
  root.appendChild(buildTopbar('peserta'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  const invited = Object.values(db.tests).filter(t => (t.invited||[]).some(i => i.email === currentUser.email));
  wrap.innerHTML = `
    ${invited.length ? `
    <div class="card narrow" style="margin:var(--sp-5) auto var(--sp-5);">
      <h2 style="font-size:var(--text-xl);margin:0 0 var(--sp-1);">Tes yang diundangkan untukmu</h2>
      <p class="text-sm text-secondary" style="margin:0 0 var(--sp-4);">Klik <em>Mulai</em> untuk langsung membukanya tanpa perlu memasukkan kode.</p>
      ${invited.map(t => {
        const done = t.results.some(r => r.email === currentUser.email);
        return `<div style="display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border);border-radius:var(--radius);padding:var(--sp-3) var(--sp-4);margin-bottom:var(--sp-2);background:var(--surface-raised);">
          <div>
            <div class="font-bold">${esc(t.title)}</div>
            <div class="text-xs text-tertiary">${fmtDate(t.date)}</div>
          </div>
          ${done
            ? '<span class="badge badge-teal">Sudah dikerjakan</span>'
            : `<button class="btn btn-primary btn-sm" data-start="${t.code}">Mulai tes</button>`}
        </div>`;
      }).join('')}
    </div>` : ''}

    <div class="card narrow" style="margin:${invited.length ? '0' : 'var(--sp-5)'} auto 0;">
      <h2 style="font-size:var(--text-xl);margin:0 0 var(--sp-1);">Masukkan kode tes</h2>
      <p class="text-sm text-secondary" style="margin:0 0 var(--sp-4);">Masuk sebagai <strong>${esc(currentUser.name)}</strong>. Masukkan tanggal dan kode dari penyelenggara.</p>
      <div class="form-row" style="margin-bottom:var(--sp-4);">
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label" for="pdate">Tanggal pelaksanaan</label>
          <input class="form-field" type="date" id="pdate" value="${state.prefillDate||todayStr()}">
        </div>
        <div class="form-group" style="margin-bottom:0;">
          <label class="form-label" for="pcode">Kode unik tes</label>
          <input class="form-field" type="text" id="pcode" style="text-transform:uppercase;" value="${state.prefillCode||''}" placeholder="Contoh: 7XQK2M">
        </div>
      </div>
      <div id="err" class="form-error" style="display:none;"></div>
      <button class="btn btn-primary btn-block" id="goBtn">Lanjutkan</button>
    </div>
  `;
  root.appendChild(wrap);
  wrap.querySelectorAll('[data-start]').forEach(b => b.onclick = () => {
    const t = db.tests[b.dataset.start];
    go('participantConsent', { code: t.code, date: t.date });
  });
  wrap.querySelector('#goBtn').onclick = () => {
    const date = wrap.querySelector('#pdate').value;
    const code = wrap.querySelector('#pcode').value.trim().toUpperCase();
    const errEl = wrap.querySelector('#err');
    if (!date || !code) { errEl.textContent = 'Tanggal dan kode wajib diisi.'; errEl.style.display = 'block'; return; }
    const t = db.tests[code];
    if (!t) { errEl.textContent = 'Kode tes tidak ditemukan. Periksa kembali kode yang diberikan.'; errEl.style.display = 'block'; return; }
    if (t.date !== date) { errEl.textContent = `Kode ini terdaftar untuk tanggal ${fmtDate(t.date)}, bukan tanggal yang kamu masukkan.`; errEl.style.display = 'block'; return; }
    errEl.style.display = 'none';
    go('participantConsent', { code, date });
  };
}

/* ────────────────────────────────────────────────────────────
   PARTICIPANT — CONSENT
   ──────────────────────────────────────────────────────────── */
function screenParticipantConsent() {
  root.appendChild(buildTopbar('peserta'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  const t = db.tests[state.code];
  const preview = !!state.preview;
  wrap.innerHTML = `
    ${preview ? previewBar(t) : ''}
    <div class="card narrow" style="margin:var(--sp-5) auto 0;">
      <h2 style="font-size:var(--text-2xl);margin:0 0 var(--sp-1);">${esc(t.title)}</h2>
      <p class="text-sm text-secondary" style="margin:0 0 var(--sp-4);">Sebelum mulai, bacalah ketentuan pengawasan berikut.</p>
      <ul style="font-size:var(--text-sm);color:var(--text-secondary);line-height:var(--leading-loose);padding-left:var(--sp-4);margin:0 0 var(--sp-5);">
        <li>Tes terdiri dari <strong>${t.sections.length} bagian</strong>${t.sections.some(x => x.kind === 'example') ? ` (termasuk ${t.sections.filter(x => x.kind === 'example').length} bagian contoh soal yang tidak dinilai)` : ''}, ${t.sections.some(x => x.untimed) ? 'sebagian dengan batas waktu sendiri.' : 'masing-masing dengan batas waktu sendiri.'}</li>
        <li>Kamera mengambil gambar setiap <strong>${fmtSnapInterval(t)}</strong> selama tes berlangsung.</li>
        <li>Jangan berpindah tab atau aplikasi lain. Setiap perpindahan terdeteksi sebagai pelanggaran. ${maxViolationsOf(t) > 0 ? `Pada pelanggaran ke-${maxViolationsOf(t)}, <strong>tes ditutup otomatis</strong> dan jawaban yang sudah ada tersimpan.` : 'Pelanggaran dicatat dan dilihat oleh penyelenggara.'}</li>
        <li>Jika waktu satu bagian habis, jawaban tersimpan dan tes lanjut ke bagian berikutnya.</li>
        <li>${t.showScore ? 'Skor akhir ditampilkan setelah tes selesai.' : 'Skor tidak ditampilkan ke peserta — hasil akan diinformasikan oleh penyelenggara.'}</li>
      </ul>
      <div id="camStatus" class="note note-warn" style="margin-bottom:var(--sp-4);">
        Klik tombol di bawah untuk memberi izin akses kamera dan memulai tes.
      </div>
      <button class="btn btn-primary btn-block" id="startBtn">Izinkan kamera & mulai tes</button>
    </div>
  `;
  root.appendChild(wrap);
  if (preview) {
    wrap.querySelector('#pvExit').onclick = () => exitPreview(t.code);
    wrap.querySelector('#camStatus').textContent = 'Pratinjau tidak memakai kamera.';
    wrap.querySelector('#startBtn').textContent = 'Mulai pratinjau';
    wrap.querySelector('#startBtn').onclick = () => go('participantTest', { code: state.code, date: state.date, preview: true, __stream: null });
    return;
  }
  wrap.querySelector('#startBtn').onclick = async () => {
    const statusEl = wrap.querySelector('#camStatus');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      go('participantTest', { code: state.code, date: state.date, __stream: stream });
    } catch (e) {
      statusEl.textContent = 'Akses kamera ditolak atau tidak tersedia. Tes tetap bisa dimulai tanpa rekaman kamera — ini akan tercatat pada hasil.';
      statusEl.className = 'note note-danger';
      wrap.querySelector('#startBtn').textContent = 'Mulai tanpa kamera';
      wrap.querySelector('#startBtn').onclick = () => go('participantTest', { code: state.code, date: state.date, __stream: null });
    }
  };
}

/* ────────────────────────────────────────────────────────────
   PARTICIPANT — TEST (exam runner)
   ──────────────────────────────────────────────────────────── */
let examTimer = null, snapTimer = null, examCtx = null;

function blankAnswer(type) {
  if (type === 'multi')  return [];
  if (type === 'essay')  return '';
  return null;
}

/* ── Zoom tampilan tes untuk peserta ── */
const ZOOM_KEY = 'ruangtes_zoom';
const ZOOM_MIN = 0.8, ZOOM_MAX = 2, ZOOM_STEP = 0.1;
let examZoom = 1;
try { const z = parseFloat(localStorage.getItem(ZOOM_KEY)); if (z >= ZOOM_MIN && z <= ZOOM_MAX) examZoom = z; } catch (e) { /* */ }

function removeZoomControls() { document.querySelector('.zoom-ctl')?.remove(); }

function mountZoomControls(target) {
  removeZoomControls();
  const apply = z => {
    examZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z * 10) / 10));
    target.style.zoom = examZoom === 1 ? '' : examZoom;
    ctl.querySelector('[data-zoom-val]').textContent = Math.round(examZoom * 100) + '%';
    ctl.querySelector('[data-zoom="out"]').disabled = examZoom <= ZOOM_MIN;
    ctl.querySelector('[data-zoom="in"]').disabled = examZoom >= ZOOM_MAX;
    try { localStorage.setItem(ZOOM_KEY, String(examZoom)); } catch (e) { /* */ }
  };
  const ctl = document.createElement('div');
  ctl.className = 'zoom-ctl';
  ctl.setAttribute('role', 'group');
  ctl.setAttribute('aria-label', 'Ukuran tampilan');
  ctl.innerHTML = `
    <button type="button" data-zoom="out" title="Perkecil tampilan" aria-label="Perkecil tampilan">A−</button>
    <button type="button" data-zoom-val title="Kembalikan ke 100%" aria-label="Kembalikan ukuran normal">100%</button>
    <button type="button" data-zoom="in" title="Perbesar tampilan" aria-label="Perbesar tampilan">A+</button>`;
  ctl.querySelector('[data-zoom="out"]').onclick = () => apply(examZoom - ZOOM_STEP);
  ctl.querySelector('[data-zoom="in"]').onclick  = () => apply(examZoom + ZOOM_STEP);
  ctl.querySelector('[data-zoom-val]').onclick   = () => apply(1);
  document.body.appendChild(ctl);
  apply(examZoom);
}

function screenParticipantTest() {
  const t = db.tests[state.code];
  const preview = !!state.preview;
  const ctx = (!preview && examCtx && examCtx.code === state.code) ? examCtx : {
    code: state.code, name: currentUser.name, email: currentUser.email, date: state.date,
    secIndex: 0, answers: t.sections.map(s => s.questions.map(q => blankAnswer(q.type))),
    qIndex: 0, remaining: t.sections[0].untimed ? null : t.sections[0].durationSec,
    intro: !!t.sections[0].description,
    violations: 0, autoClosed: false, snapshots: [],
    stream: state.__stream || null,
  };
  examCtx = ctx;

  const wrap = document.createElement('div');
  wrap.className = 'screen exam-shell';
  root.appendChild(wrap);
  mountZoomControls(wrap);
  drawExam();

  function curSec() { return t.sections[ctx.secIndex]; }

  function wirePreview() {
    if (!preview) return;
    wrap.querySelector('#pvExit').onclick = () => exitPreview(t.code);
    wrap.querySelector('#pvJump').onchange = e => { enterSection(+e.target.value); drawExam(); };
  }

  function enterSection(i) {
    ctx.secIndex = i;
    window.scrollTo(0, 0);
    ctx.qIndex = 0;
    const sec = t.sections[i];
    ctx.remaining = sec.untimed ? null : sec.durationSec;
    ctx.intro = !!sec.description;
  }

  function timerText() { return ctx.remaining == null ? 'Tanpa batas waktu' : fmtClock(ctx.remaining); }

  /* Umpan balik untuk section contoh soal */
  function exampleFeedback(q, given) {
    if (!['single', 'multi', 'truefalse'].includes(q.type)) return q.explanation?.trim() ? `<div class="note" style="margin-top:var(--sp-3);white-space:pre-wrap;"><strong>Pembahasan:</strong> ${esc(q.explanation)}</div>` : '';
    const answered = q.type === 'multi' ? (given || []).length > 0 : given != null;
    if (!answered) return '';
    const opts = q.type === 'truefalse' ? ['Benar', 'Salah'] : q.opts;
    let ok, corr;
    if (q.type === 'multi') {
      const g = (given || []).slice().sort((a, b) => a - b), c = (q.correct || []).slice().sort((a, b) => a - b);
      ok = JSON.stringify(g) === JSON.stringify(c);
      corr = c.map(i => optText(opts[i], i)).join(', ');
    } else {
      ok = given === q.correct;
      corr = optText(opts[q.correct], q.correct);
    }
    return `<div class="note ${ok ? '' : 'note-warn'}" style="margin-top:var(--sp-3);">
      <strong>${ok ? '✓ Jawaban Anda tepat.' : `Belum tepat. Jawaban yang benar: ${esc(corr)}`}</strong>
      ${q.explanation?.trim() ? `<div style="white-space:pre-wrap;margin-top:var(--sp-2);">${esc(q.explanation)}</div>` : ''}
    </div>`;
  }

  function drawIntro() {
    const sec = curSec();
    wrap.innerHTML = `
      ${preview ? previewBar(t, ctx.secIndex) : ''}
      <div class="exam-header">
        <div class="exam-meta"><b>${esc(t.title)}</b>Bagian ${ctx.secIndex + 1} dari ${t.sections.length}</div>
      </div>
      ${ctx.violations > 0
        ? `<div class="violation-banner">Peringatan ${ctx.violations}${maxViolationsOf(t) > 0 ? `/${maxViolationsOf(t)}` : ''} — jangan berpindah tab atau aplikasi lain.</div>`
        : ''}
      <div class="q-card">
        <div class="q-num">${sec.kind === 'example' ? 'Contoh soal · tidak dinilai' : `Bagian ${ctx.secIndex + 1}`}</div>
        <h2 style="font-size:var(--text-2xl);margin:0 0 var(--sp-3);">${esc(sec.name)}</h2>
        <p class="q-text" style="white-space:pre-wrap;">${esc(sec.description)}</p>
        <p class="text-sm text-secondary">${sec.questions.length} soal · ${sec.untimed ? 'tanpa batas waktu' : `waktu ${fmtClock(sec.durationSec)} (mulai berjalan setelah Anda menekan Mulai)`}</p>
        <div class="nav-row"><span></span><button class="btn btn-primary" id="startSec">Mulai</button></div>
      </div>`;
    wrap.querySelector('#startSec').onclick = () => { ctx.intro = false; drawExam(); };
    wirePreview();
    attachCam();
  }

  function attachCam() {
    if (!ctx.stream) return;
    let cam = document.querySelector('.cam-corner');
    if (!cam) {
      cam = document.createElement('div');
      cam.className = 'cam-corner';
      cam.innerHTML = `<video autoplay muted playsinline></video><div class="cam-lbl" id="camlbl">merekam</div>`;
      document.body.appendChild(cam);
      cam.querySelector('video').srcObject = ctx.stream;
    }
  }

  function answerBody(sec, q, qi) {
    const given = ctx.answers[ctx.secIndex][qi];
    if (q.type === 'single' || q.type === 'truefalse') {
      const opts   = q.type === 'truefalse' ? ['Benar','Salah'] : q.opts;
      const hasImg = q.type !== 'truefalse' && opts.some(o => o?.image);
      const items  = opts.map((op, oi) => `
        <label class="ans-opt${given===oi?' ans-opt--selected':''}" data-single="${oi}">
          <input type="radio" name="ans-${qi}" ${given===oi?'checked':''}>
          ${optLabel(op, q.type === 'truefalse' ? null : oi)}
        </label>`).join('');
      return hasImg ? `<div class="ans-grid">${items}</div>` : items;
    }
    if (q.type === 'multi') {
      const arr    = given || [];
      const hasImg = q.opts.some(o => o?.image);
      const items  = q.opts.map((op, oi) => `
        <label class="ans-opt${arr.includes(oi)?' ans-opt--selected':''}" data-multi="${oi}">
          <input type="checkbox" ${arr.includes(oi)?'checked':''}>
          ${optLabel(op, q.type === 'truefalse' ? null : oi)}
        </label>`).join('');
      return hasImg ? `<div class="ans-grid">${items}</div>` : items;
    }
    if (q.type === 'scale') {
      return `
        <div class="scale-row">
          ${[1,2,3,4,5].map(v => `<button type="button" class="scale-btn${given===v?' scale-btn--selected':''}" data-scale="${v}">${v}</button>`).join('')}
        </div>
        <div class="scale-labels"><span>${esc(q.minLabel||'')}</span><span>${esc(q.maxLabel||'')}</span></div>`;
    }
    if (q.type === 'essay') {
      return `<textarea class="form-field" data-essay placeholder="Tulis jawaban Anda di sini…" style="min-height:140px;">${esc(given||'')}</textarea>`;
    }
    return '';
  }

  function isAnswered(q, given) {
    if (q.type === 'multi') return (given || []).length > 0;
    if (q.type === 'essay') return !!(given && given.trim());
    return given != null;
  }

  /* Isi satu kartu soal (dipakai mode satu-per-satu maupun semua-sekaligus) */
  function questionBody(sec, q, qi, label) {
    return `
      <div class="q-num">${sec.kind === 'example' ? '<span class="badge">Contoh soal · tidak dinilai</span> ' : ''}${label}</div>
      ${q?.image ? `<img class="q-image" src="${q.image}" alt="Gambar soal">` : ''}
      ${q?.q ? `<p class="q-text">${esc(q.q)}</p>` : ''}
      <div>${answerBody(sec, q, qi)}</div>
      ${sec.kind === 'example' ? `<div data-fb>${exampleFeedback(q, ctx.answers[ctx.secIndex][qi])}</div>` : ''}`;
  }

  function nextLabel(sec) {
    return ctx.secIndex < t.sections.length - 1 ? 'Lanjut ke bagian berikutnya →' : 'Selesaikan tes';
  }

  function drawExam(keepScroll) {
    if (ctx.intro) { drawIntro(); return; }
    const sec = curSec();
    const all = sec.displayMode === 'all';
    const y = (all || keepScroll) ? window.scrollY : 0;
    let cards;
    if (all) {
      const done = sec.questions.filter((q, i) => isAnswered(q, ctx.answers[ctx.secIndex][i])).length;
      cards = sec.questions.map((q, qi) => `
        <div class="q-card" data-qcard="${qi}" style="margin-bottom:var(--sp-4);">
          ${questionBody(sec, q, qi, `${esc(sec.name)} · Soal ${qi + 1} / ${sec.questions.length}`)}
        </div>`).join('') + `
        <div class="q-card">
          <p class="text-sm text-secondary" id="doneCount" style="margin:0 0 var(--sp-3);">Terjawab ${done} dari ${sec.questions.length} soal.</p>
          <div class="nav-row"><span></span><button class="btn btn-primary" id="nextQ">${nextLabel(sec)}</button></div>
        </div>`;
    } else {
      const q = sec.questions[ctx.qIndex];
      cards = `
      <div class="q-card" data-qcard="${ctx.qIndex}">
        ${questionBody(sec, q, ctx.qIndex, `${esc(sec.name)} · Soal ${ctx.qIndex + 1} / ${sec.questions.length}`)}
        <div class="progress-track">
          ${sec.questions.map((_,i) => `<div class="prog-dot${i < ctx.qIndex ? ' prog-dot--done' : i === ctx.qIndex ? ' prog-dot--now' : ''}"></div>`).join('')}
        </div>
        <div class="nav-row">
          <button class="btn btn-secondary" id="prevQ" ${ctx.qIndex === 0 ? 'disabled' : ''}>← Sebelumnya</button>
          <button class="btn btn-primary"   id="nextQ">
            ${ctx.qIndex < sec.questions.length - 1 ? 'Selanjutnya →' : nextLabel(sec)}
          </button>
        </div>
      </div>`;
    }
    wrap.innerHTML = `
      ${preview ? previewBar(t, ctx.secIndex) : ''}
      <div class="exam-header">
        <div class="exam-meta">
          <b>${esc(t.title)}</b>
          ${esc(sec.name)} · ${all ? `${sec.questions.length} soal` : `Soal ${ctx.qIndex + 1} dari ${sec.questions.length}`}
        </div>
        <div class="exam-timer${ctx.remaining != null && ctx.remaining <= 30 ? ' exam-timer--low' : ''}" id="timerDisp">
          ${timerText()}
        </div>
      </div>
      ${ctx.violations > 0
        ? `<div class="violation-banner">Peringatan ${ctx.violations}${maxViolationsOf(t) > 0 ? `/${maxViolationsOf(t)}` : ''} — jangan berpindah tab atau aplikasi lain.</div>`
        : ''}
      ${cards}
    `;

    const qiOf = el => +el.closest('[data-qcard]').dataset.qcard;
    const answers = ctx.answers[ctx.secIndex];

    /* Perbarui kartu soal di tempat (tanpa menggambar ulang) agar posisi gulir dan gambar tidak berubah.
       Jawaban sudah dicatat di ctx.answers sebelum tampilan disesuaikan. */
    function syncCard(card) {
      const qi = +card.dataset.qcard, q = sec.questions[qi], given = answers[qi];
      const mark = (sel, key, on) => card.querySelectorAll(sel).forEach(el => {
        const isOn = on(+el.dataset[key]);
        el.classList.toggle(key === 'scale' ? 'scale-btn--selected' : 'ans-opt--selected', isOn);
        const inp = el.querySelector('input'); if (inp) inp.checked = isOn;
      });
      if (q.type === 'single' || q.type === 'truefalse') mark('[data-single]', 'single', v => v === given);
      else if (q.type === 'multi') mark('[data-multi]', 'multi', v => (given || []).includes(v));
      else if (q.type === 'scale') mark('[data-scale]', 'scale', v => v === given);
      const fb = card.querySelector('[data-fb]');
      if (fb) fb.innerHTML = exampleFeedback(q, given);
      const dc = wrap.querySelector('#doneCount');
      if (dc) dc.textContent = `Terjawab ${sec.questions.filter((qq, i) => isAnswered(qq, answers[i])).length} dari ${sec.questions.length} soal.`;
    }

    wrap.querySelectorAll('[data-single]').forEach(el =>
      el.addEventListener('click', e => {
        e.preventDefault();                          /* cegah klik ganda label→input */
        answers[qiOf(el)] = +el.dataset.single;
        syncCard(el.closest('[data-qcard]'));
      }));
    wrap.querySelectorAll('[data-multi]').forEach(el =>
      el.addEventListener('click', e => {
        e.preventDefault();
        const qi = qiOf(el), oi = +el.dataset.multi;
        const set = new Set(answers[qi] || []);
        set.has(oi) ? set.delete(oi) : set.add(oi);
        answers[qi] = Array.from(set).sort((a, b) => a - b);
        syncCard(el.closest('[data-qcard]'));
      }));
    wrap.querySelectorAll('[data-scale]').forEach(el =>
      el.addEventListener('click', () => {
        answers[qiOf(el)] = +el.dataset.scale;
        syncCard(el.closest('[data-qcard]'));
      }));
    wrap.querySelectorAll('[data-essay]').forEach(el =>
      el.oninput = () => {
        answers[qiOf(el)] = el.value;
        const dc = wrap.querySelector('#doneCount');
        if (dc) dc.textContent = `Terjawab ${sec.questions.filter((q, i) => isAnswered(q, answers[i])).length} dari ${sec.questions.length} soal.`;
      });

    wirePreview();
    const prev = wrap.querySelector('#prevQ');
    if (prev) prev.onclick = () => { ctx.qIndex = Math.max(0, ctx.qIndex - 1); drawExam(); };
    wrap.querySelector('#nextQ').onclick = () => advance();
    if (!y) window.scrollTo(0, 0);
    if (y) {
      window.scrollTo(0, y);
      wrap.querySelectorAll('img').forEach(im => { if (!im.complete) im.addEventListener('load', () => window.scrollTo(0, y), { once: true }); });
    }

    attachCam();
  }

  function advance() {
    const sec = curSec();
    if (sec.displayMode !== 'all' && ctx.qIndex < sec.questions.length - 1) { ctx.qIndex++; drawExam(); return; }
    if (ctx.secIndex < t.sections.length - 1) {
      enterSection(ctx.secIndex + 1);
      drawExam();
    } else {
      finishExam(false);
    }
  }

  function tick() {
    if (ctx.intro || ctx.remaining == null) return;
    ctx.remaining--;
    const disp = document.getElementById('timerDisp');
    if (disp) {
      disp.textContent = timerText();
      disp.className = `exam-timer${ctx.remaining <= 30 ? ' exam-timer--low' : ''}`;
    }
    if (preview && ctx.remaining <= 0) { ctx.remaining = 0; return; }
    if (ctx.remaining <= 0) {
      if (ctx.secIndex < t.sections.length - 1) {
        enterSection(ctx.secIndex + 1);
        drawExam();
      } else {
        finishExam(false);
      }
    }
  }
  clearInterval(examTimer);
  examTimer = setInterval(tick, 1000);

  /* Webcam snapshot loop */
  clearInterval(snapTimer);
  if (ctx.stream) {
    const rawSec = t.snapshotSec ?? (t.snapshotMinutes ?? 3) * 60;
    const ms = Math.max(1, rawSec) * 1000;
    snapTimer = setInterval(() => {
      try {
        const video = document.querySelector('.cam-corner video');
        if (!video) return;
        const canvas = document.createElement('canvas');
        canvas.width  = video.videoWidth  || 160;
        canvas.height = video.videoHeight || 120;
        canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
        ctx.snapshots.push({ t: Date.now(), data: canvas.toDataURL('image/jpeg', 0.5) });
        const lbl = document.getElementById('camlbl');
        if (lbl) { lbl.textContent = 'foto tersimpan'; setTimeout(() => { if (lbl) lbl.textContent = 'merekam'; }, 1200); }
      } catch (e) { /* ignore */ }
    }, ms);
  }

  /* Tab-switch detection */
  function onVisChange() {
    if (document.hidden) {
      ctx.violations++;
      const max = maxViolationsOf(t);
      max > 0 && ctx.violations >= max ? finishExam(true) : drawExam(true);
    }
  }
  document.removeEventListener('visibilitychange', window.__ruangtesVis || (() => {}));
  window.__ruangtesVis = onVisChange;
  if (!preview) document.addEventListener('visibilitychange', onVisChange);

  function finishExam(autoClosed) {
    clearInterval(examTimer);
    clearInterval(snapTimer);
    document.removeEventListener('visibilitychange', window.__ruangtesVis);
    ctx.stream?.getTracks().forEach(tr => tr.stop());
    document.querySelector('.cam-corner')?.remove();
    removeZoomControls();

    let score = 0, max = 0;
    t.sections.forEach((sec, si) => sec.questions.forEach((q, qi) => {
      if (sec.kind === 'example') return;
      const hasKeyEssay = q.type === 'essay' && q.answerKey?.trim();
      if (!AUTO_SCORE_TYPES.includes(q.type) && !hasKeyEssay) return;
      max++;
      const given = ctx.answers[si][qi];
      if (q.type === 'multi') {
        const g = (given||[]).slice().sort((a,b)=>a-b);
        const c = (q.correct||[]).slice().sort((a,b)=>a-b);
        if (c.length && JSON.stringify(g) === JSON.stringify(c)) score++;
      } else if (hasKeyEssay) {
        if (given && given.trim().toLowerCase() === q.answerKey.trim().toLowerCase()) score++;
      } else {
        if (given === q.correct) score++;
      }
    }));

    if (preview) {
      examCtx = null;
      go('participantDone', {
        preview: true, code: t.code,
        result: { score, maxScore: max, violations: 0, autoClosed: false }, title: t.title,
        showScore: t.showScore, useIqNorm: t.useIqNorm, iqNormTable: t.iqNormTable,
      });
      return;
    }
    const ri = t.results.length;
    const result = {
      name: ctx.name, email: ctx.email, date: ctx.date,
      submittedAt: Date.now(), score, maxScore: max,
      violations: ctx.violations, autoClosed, maxViolations: maxViolationsOf(t),
      answers: ctx.answers, snapshots: ctx.snapshots,
    };
    t.results.push(result);
    saveDB();
    if (window.Cloud?.state.configured && ctx.snapshots.length) {
      Cloud.uploadSnapshots(t.code, ri, ctx.snapshots).then(uploaded => {
        const cur = t.results[ri];
        if (cur) { cur.snapshots = uploaded; saveDB(); }
      });
    } else if (window.Drive?.state?.connected && ctx.snapshots.length) {
      Drive.uploadSnapshots(t.code, ri, ctx.snapshots).then(uploaded => {
        t.results[ri].snapshots = uploaded;
        saveDB();
      });
    }
    examCtx = null;
    go('participantDone', {
      result, title: t.title,
      showScore: t.showScore, useIqNorm: t.useIqNorm, iqNormTable: t.iqNormTable,
    });
  }

  window.__ruangtesFinish = () => { clearInterval(examTimer); clearInterval(snapTimer); };
}

/* ────────────────────────────────────────────────────────────
   PARTICIPANT — DONE
   ──────────────────────────────────────────────────────────── */
function screenParticipantDone() {
  root.appendChild(buildTopbar('peserta'));
  const wrap = document.createElement('div');
  wrap.className = 'screen shell';
  const r   = state.result;
  const iq  = state.useIqNorm ? computeIQ({ useIqNorm: true, iqNormTable: state.iqNormTable }, r.score) : null;
  const cat = iq != null ? iqCategory(iq) : null;
  const preview = !!state.preview;
  wrap.innerHTML = `
    ${preview ? previewBar({ sections: [] }) : ''}
    <div class="card narrow" style="margin:var(--sp-7) auto;text-align:center;padding:var(--sp-7) var(--sp-6);">
      <div class="text-sm text-tertiary" style="margin-bottom:var(--sp-2);">${esc(state.title)}</div>
      <h2 style="font-size:var(--text-2xl);margin:0 0 var(--sp-5);">Tes selesai</h2>
      ${state.showScore
        ? (iq != null
            ? `<div class="result-score" style="margin-bottom:var(--sp-2);">${iq}</div>
               <div class="text-xs text-tertiary" style="margin-bottom:var(--sp-3);">Skor IQ (dari skor mentah ${r.score}/${r.maxScore})</div>
               ${cat ? `<div class="badge badge-teal" style="font-size:var(--text-sm);padding:var(--sp-1) var(--sp-3);margin-bottom:var(--sp-4);">${esc(cat)}</div>` : ''}`
            : `<div class="result-score" style="margin-bottom:var(--sp-4);">${r.score}/${r.maxScore}</div>`)
        : `<p class="text-secondary" style="font-size:var(--text-base);margin:0 0 var(--sp-5);max-width:300px;margin-left:auto;margin-right:auto;">Terima kasih sudah menyelesaikan tes. Hasil akan diinformasikan oleh penyelenggara.</p>`}
      ${r.autoClosed
        ? `<div class="violation-banner" style="text-align:left;margin-bottom:var(--sp-4);">Tes ditutup otomatis karena ${r.maxViolations ?? 3} kali terdeteksi berpindah tab.</div>`
        : r.violations > 0
          ? `<div class="note note-warn" style="text-align:left;margin-bottom:var(--sp-4);">Terdeteksi ${r.violations} kali berpindah tab selama pengerjaan.</div>`
          : ''}
      <p class="text-sm text-tertiary" style="margin:0 0 var(--sp-5);">${preview ? 'Ini hanya pratinjau — tidak ada hasil yang disimpan.' : 'Jawaban dan rekaman kamera sudah tersimpan dan dapat ditinjau oleh admin.'}</p>
      <button class="btn btn-secondary" id="homeBtn">${preview ? 'Kembali ke hasil tes' : 'Kembali ke beranda'}</button>
    </div>
  `;
  root.appendChild(wrap);
  if (preview) wrap.querySelector('#pvExit').onclick = () => exitPreview(state.code);
  wrap.querySelector('#homeBtn').onclick = () => preview ? exitPreview(state.code) : go('home');
}

/* ────────────────────────────────────────────────────────────
   SCREEN REGISTRY & INIT
   ──────────────────────────────────────────────────────────── */
const SCREENS = {
  home:                   screenHome,
  authView:               () => screenAuth(state.mode || 'login', state.roleHint),
  adminDashboard:         screenAdminDashboard,
  adminCreateTest:        screenAdminCreateTest,
  adminTestCreated:       screenAdminTestCreated,
  adminResults:           screenAdminResults,
  adminResultDetail:      screenAdminResultDetail,
  adminParticipants:      screenAdminParticipants,
  adminParticipantProfile:screenAdminParticipantProfile,
  adminInvite:            screenAdminInvite,
  participantEntry:       screenParticipantEntry,
  participantConsent:     screenParticipantConsent,
  participantTest:        screenParticipantTest,
  participantDone:        screenParticipantDone,
};

applyTheme();
render();
syncFromCloud().then(changed => { if (changed && LIST_SCREENS.includes(state.screen)) render(); });

/* ────────────────────────────────────────────────────────────
   DRIVE INIT
   ──────────────────────────────────────────────────────────── */
if (window.Drive) {
  Drive.init(state => {
    render();
    if (state.connected && !state.syncing) {
      Drive.load().then(remote => {
        if (!remote) return;
        /* Merge: remote is source of truth; local adds any results not yet in remote */
        Object.entries(remote.tests || {}).forEach(([code, remoteTest]) => {
          const local = db.tests[code];
          if (!local) { db.tests[code] = remoteTest; return; }
          const remoteIds = new Set((remoteTest.results||[]).map(r => r.submittedAt));
          (local.results||[]).forEach(r => { if (!remoteIds.has(r.submittedAt)) remoteTest.results.push(r); });
          db.tests[code] = remoteTest;
        });
        (Object.entries(remote.users || {})).forEach(([k, v]) => { db.users[k] = db.users[k] || v; });
        saveDB();
        render();
      });
    }
  });
}
