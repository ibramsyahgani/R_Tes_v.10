/* ================================================================
   CLOUD.JS — sinkronisasi database ke Supabase agar data sama di
   semua browser. localStorage tetap dipakai sebagai cache.

   - pull(): ambil data server, gabungkan ke db lokal.
   - push(): kirim db ke server dengan pengecekan versi (optimistic
     lock); jika bentrok, tarik + gabung lalu coba lagi.
   - uploadSnapshots(): foto kamera ke Supabase Storage.
   ================================================================ */

'use strict';

(function () {
  const cfg = window.RUANGTES_CONFIG || {};
  const BASE = (cfg.supabaseUrl || '').replace(/\/$/, '');
  const KEY  = cfg.supabaseAnonKey || '';
  const configured = !!(BASE && KEY);
  const ROW = 'main';

  let version = null;       /* versi baris server yang terakhir kita lihat */
  let pushTimer = null;
  let pushing = null;
  let dirty = false;
  const listeners = new Set();
  const status = { configured, online: false, syncing: false, error: null };

  function notify() { listeners.forEach(fn => fn({ ...status })); }
  function headers(extra) {
    return Object.assign({ apikey: KEY, Authorization: `Bearer ${KEY}` }, extra || {});
  }

  /* ── Penggabungan dua database ─────────────────────────────── */
  const hasPhoto = s => !!(s && (s.url || s.driveId));
  const resultKey = r => `${r.submittedAt}|${r.email}`;

  function mergeSnapshots(a, b) {
    const out = [];
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i], y = b[i];
      out.push(!x ? y : !y ? x : (hasPhoto(x) || !hasPhoto(y) ? x : y));
    }
    return out;
  }

  function mergeResults(preferred, other) {
    const map = new Map();
    (other || []).forEach(r => map.set(resultKey(r), r));
    (preferred || []).forEach(r => {
      const o = map.get(resultKey(r));
      map.set(resultKey(r), o ? { ...o, ...r, snapshots: mergeSnapshots(r.snapshots || [], o.snapshots || []) } : r);
    });
    return [...map.values()].sort((a, b) => a.submittedAt - b.submittedAt);
  }

  function mergeInvited(preferred, other) {
    const map = new Map();
    (other || []).forEach(i => map.set(i.email, i));
    (preferred || []).forEach(i => map.set(i.email, i));
    return [...map.values()];
  }

  /* Gabungkan `src` ke `dst` (dimutasi). prefer: 'src' | 'dst' untuk
     field yang bentrok. Hasil tes dan undangan selalu di-union. */
  function mergeDB(dst, src, prefer) {
    dst.tombstones = dst.tombstones || { tests: {}, users: {}, results: {} };
    const ts = src.tombstones || {};
    ['tests', 'users', 'results'].forEach(k => {
      dst.tombstones[k] = Object.assign({}, ts[k] || {}, dst.tombstones[k] || {});
    });

    Object.entries(src.users || {}).forEach(([em, u]) => {
      if (!dst.users[em] || prefer === 'src') dst.users[em] = u;
    });

    Object.entries(src.tests || {}).forEach(([code, st]) => {
      const dt = dst.tests[code];
      if (!dt) { dst.tests[code] = st; return; }
      const winner = prefer === 'src' ? st : dt;
      const loser  = prefer === 'src' ? dt : st;
      dst.tests[code] = {
        ...loser, ...winner,
        results: mergeResults(winner.results, loser.results),
        invited: mergeInvited(winner.invited, loser.invited),
        entries: mergeInvited(winner.entries, loser.entries),
      };
    });

    /* Terapkan penghapusan */
    const goneResults = dst.tombstones.results || {};
    Object.values(dst.tests).forEach(t => {
      t.results = (t.results || []).filter(r => !(resultKey(r) in goneResults));
    });
    Object.keys(dst.tombstones.tests).forEach(c => { delete dst.tests[c]; });
    /* Akun yang dibuat ulang setelah dihapus (createdAt > waktu hapus) tetap hidup */
    Object.entries(dst.tombstones.users).forEach(([e, ts]) => {
      if (!((dst.users[e]?.createdAt || 0) > ts)) delete dst.users[e];
    });
    return dst;
  }

  /* Salinan untuk server: tanpa base64 foto */
  function forServer(db) {
    const copy = JSON.parse(JSON.stringify(db));
    Object.values(copy.tests || {}).forEach(t =>
      (t.results || []).forEach(r => {
        r.snapshots = (r.snapshots || []).map(s => {
          const o = { t: s.t };
          if (s.url) o.url = s.url;
          if (s.driveId) o.driveId = s.driveId;
          return o;
        });
      }));
    return copy;
  }

  /* ── Jaringan ──────────────────────────────────────────────── */
  async function fetchRow() {
    const res = await fetch(`${BASE}/rest/v1/app_state?id=eq.${ROW}&select=data,version`, { headers: headers() });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    if (!rows.length) throw new Error('Baris app_state "main" belum ada. Jalankan supabase.sql.');
    return rows[0];
  }

  /* Tarik data server → gabung ke db (remote menang). Return true bila db berubah. */
  async function pull(db) {
    if (!configured) return false;
    try {
      const row = await fetchRow();
      const before = JSON.stringify(db);
      mergeDB(db, row.data || {}, 'src');
      version = row.version;
      status.online = true; status.error = null; notify();
      return JSON.stringify(db) !== before;
    } catch (e) {
      status.online = false; status.error = e.message; notify();
      return false;
    }
  }

  async function tryPush(db) {
    const next = version == null ? 0 : version + 1;
    const filter = version == null ? '' : `&version=eq.${version}`;
    const res = await fetch(`${BASE}/rest/v1/app_state?id=eq.${ROW}${filter}`, {
      method: 'PATCH',
      headers: headers({ 'Content-Type': 'application/json', Prefer: 'return=representation' }),
      body: JSON.stringify({ data: forServer(db), version: next, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    if (rows.length) { version = next; return true; }
    return false; /* versi sudah berubah: ada yang menulis lebih dulu */
  }

  async function doPush(db, onMerged) {
    status.syncing = true; notify();
    try {
      if (version == null) {   /* belum pernah tarik data: jangan menimpa server */
        const row = await fetchRow();
        mergeDB(db, row.data || {}, 'dst');
        version = row.version;
      }
      for (let i = 0; i < 4; i++) {
        if (await tryPush(db)) { status.online = true; status.error = null; break; }
        const row = await fetchRow();
        mergeDB(db, row.data || {}, 'dst');   /* perubahan lokal menang */
        version = row.version;
        onMerged && onMerged();
        if (i === 3) throw new Error('Gagal menyimpan: terlalu banyak bentrok.');
      }
    } catch (e) {
      status.online = false; status.error = e.message;
    }
    status.syncing = false; notify();
  }

  /* Jadwalkan push (debounce). Panggil setelah setiap saveDB(). */
  function push(db, onMerged) {
    if (!configured) return;
    dirty = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      if (pushing) await pushing;
      if (!dirty) return;
      dirty = false;
      pushing = doPush(db, onMerged).finally(() => { pushing = null; });
    }, 400);
  }

  /* ── Foto kamera → Supabase Storage ────────────────────────── */
  async function uploadSnapshots(code, index, snapshots) {
    if (!configured || !snapshots.length) return snapshots;
    const out = [];
    for (let i = 0; i < snapshots.length; i++) {
      const s = snapshots[i];
      if (hasPhoto(s) || !s.data) { out.push(s); continue; }
      try {
        const bin = atob(s.data.split(',')[1]);
        const arr = new Uint8Array(bin.length);
        for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
        const path = `${code}_${index}_${Date.now()}/snap_${String(i + 1).padStart(3, '0')}.jpg`;
        const res = await fetch(`${BASE}/storage/v1/object/snapshots/${path}`, {
          method: 'POST',
          headers: headers({ 'Content-Type': 'image/jpeg' }),
          body: new Blob([arr], { type: 'image/jpeg' }),
        });
        if (!res.ok) throw new Error(await res.text());
        out.push({ t: s.t, url: `${BASE}/storage/v1/object/public/snapshots/${path}` });
      } catch (e) {
        out.push(s);
      }
    }
    return out;
  }

  /* Hapus foto riwayat dari Storage (butuh policy delete; gagal diam-diam bila tidak ada) */
  async function deleteSnapshots(snapshots) {
    if (!configured) return;
    const prefix = `${BASE}/storage/v1/object/public/snapshots/`;
    const paths = (snapshots || []).map(s => s.url).filter(u => u && u.startsWith(prefix)).map(u => u.slice(prefix.length));
    if (!paths.length) return;
    try {
      await fetch(`${BASE}/storage/v1/object/snapshots`, {
        method: 'DELETE',
        headers: headers({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prefixes: paths }),
      });
    } catch (e) { /* abaikan */ }
  }

  window.Cloud = {
    pull, push, uploadSnapshots, deleteSnapshots,
    onChange(fn) { listeners.add(fn); },
    get state() { return { ...status }; },
    /* tunggu push yang sedang berjalan/terjadwal selesai */
    async flush(db) {
      if (!configured) return;
      clearTimeout(pushTimer);
      if (pushing) await pushing;
      if (dirty) { dirty = false; pushing = doPush(db).finally(() => { pushing = null; }); await pushing; }
    },
  };
})();
