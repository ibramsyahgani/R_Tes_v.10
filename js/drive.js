/* ================================================================
   DRIVE.JS — Google Drive integration for Ruang Tes
   Uses Google Identity Services (GIS) + Drive REST API v3.

   Folder structure in Drive:
     RuangTes/
       ruangtes_db.json          ← database (tanpa base64 foto)
       snapshots/{code}_{ri}/
         snap_001.jpg            ← foto kamera tiap peserta

   SETUP: Ganti __GOOGLE_CLIENT_ID__ di bawah dengan Client ID
   dari Google Cloud Console (lihat README atau panduan admin).
   ================================================================ */

'use strict';

const DRIVE_CLIENT_ID = '__GOOGLE_CLIENT_ID__';
const DRIVE_SCOPES    = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME     = 'RuangTes';
const DB_FILENAME     = 'ruangtes_db.json';
const GAPI            = 'https://www.googleapis.com/';

/* ── Internal state ──────────────────────────────────────────── */
let _token       = null;
let _folderId    = null;
let _dbFileId    = null;
let _tokenClient = null;
let _onStateChange = () => {};

const _state = { connected: false, syncing: false, error: null, configured: DRIVE_CLIENT_ID !== '__GOOGLE_CLIENT_ID__' };

function _notify() { _onStateChange({ ..._state }); }

/* ── Auth ────────────────────────────────────────────────────── */
function driveInit(onStateChange) {
  _onStateChange = onStateChange || (() => {});
  if (!_state.configured) { _state.error = 'Client ID belum dikonfigurasi.'; _notify(); return; }
  if (document.getElementById('_gis')) return;
  const s   = document.createElement('script');
  s.id      = '_gis';
  s.src     = 'https://accounts.google.com/gsi/client';
  s.async   = true;
  s.onload  = () => {
    _tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: DRIVE_CLIENT_ID,
      scope:     DRIVE_SCOPES,
      callback:  async (resp) => {
        if (resp.error) { _state.error = resp.error; _notify(); return; }
        _token = resp.access_token;
        _state.connected = true;
        _state.error     = null;
        _notify();
        try { await _ensureFolder(); await _findDbFile(); }
        catch (e) { _state.error = e.message; _notify(); }
      },
    });
    _notify();
  };
  document.head.appendChild(s);
}

function driveSignIn() {
  if (!_state.configured) { alert('Google Client ID belum diisi di js/drive.js.'); return; }
  if (!_tokenClient)      { alert('Skrip Google Identity Services belum dimuat. Coba muat ulang halaman.'); return; }
  _tokenClient.requestAccessToken({ prompt: '' });
}

function driveSignOut() {
  if (_token) { try { google.accounts.oauth2.revoke(_token); } catch (e) { /* */ } }
  _token = null; _folderId = null; _dbFileId = null;
  _state.connected = false; _state.error = null;
  _notify();
}

/* ── REST helpers ────────────────────────────────────────────── */
async function _api(method, path, params, body, contentType) {
  const url = new URL(GAPI + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const headers = { Authorization: `Bearer ${_token}` };
  if (contentType) headers['Content-Type'] = contentType;
  const res = await fetch(url, { method, headers, body });
  if (!res.ok) { const t = await res.text(); throw new Error(`Drive ${res.status}: ${t}`); }
  const ct = res.headers.get('content-type') || '';
  return ct.includes('json') ? res.json() : res;
}

async function _ensureFolder() {
  if (_folderId) return;
  const q = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await _api('GET', 'drive/v3/files', { q, fields: 'files(id)' });
  if (r.files.length) { _folderId = r.files[0].id; return; }
  const c = await _api('POST', 'drive/v3/files', null,
    JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
    'application/json');
  _folderId = c.id;
}

async function _ensureSubfolder(name) {
  const q = `name='${name}' and '${_folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const r = await _api('GET', 'drive/v3/files', { q, fields: 'files(id)' });
  if (r.files.length) return r.files[0].id;
  const c = await _api('POST', 'drive/v3/files', null,
    JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [_folderId] }),
    'application/json');
  return c.id;
}

async function _findDbFile() {
  if (!_folderId) return;
  const q = `name='${DB_FILENAME}' and '${_folderId}' in parents and trashed=false`;
  const r = await _api('GET', 'drive/v3/files', { q, fields: 'files(id)' });
  if (r.files.length) _dbFileId = r.files[0].id;
}

function _stripSnapshots(data) {
  const clean = JSON.parse(JSON.stringify(data));
  Object.values(clean.tests || {}).forEach(t =>
    (t.results || []).forEach(r => {
      r.snapshots = (r.snapshots || []).map(s => ({ t: s.t, driveId: s.driveId || null }));
    })
  );
  return clean;
}

/* ── Public API ──────────────────────────────────────────────── */
async function driveLoad() {
  if (!_token || !_folderId) return null;
  await _findDbFile();
  if (!_dbFileId) return null;
  _state.syncing = true; _notify();
  try {
    const res  = await _api('GET', `drive/v3/files/${_dbFileId}`, { alt: 'media' });
    const text = await res.text();
    _state.syncing = false; _notify();
    return JSON.parse(text);
  } catch (e) {
    _state.syncing = false; _state.error = e.message; _notify();
    return null;
  }
}

async function driveSave(data) {
  if (!_token || !_folderId) return;
  const body = JSON.stringify(_stripSnapshots(data), null, 2);
  _state.syncing = true; _notify();
  try {
    if (_dbFileId) {
      await fetch(`${GAPI}upload/drive/v3/files/${_dbFileId}?uploadType=media`, {
        method:  'PATCH',
        headers: { Authorization: `Bearer ${_token}`, 'Content-Type': 'application/json' },
        body,
      });
    } else {
      const meta = JSON.stringify({ name: DB_FILENAME, parents: [_folderId] });
      const fd   = new FormData();
      fd.append('metadata', new Blob([meta], { type: 'application/json' }));
      fd.append('file',     new Blob([body], { type: 'application/json' }));
      const res  = await fetch(`${GAPI}upload/drive/v3/files?uploadType=multipart`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${_token}` },
        body:    fd,
      });
      const json = await res.json();
      _dbFileId  = json.id;
    }
    _state.syncing = false; _notify();
  } catch (e) {
    _state.syncing = false; _state.error = e.message; _notify();
  }
}

async function driveUploadSnapshots(testCode, resultIndex, snapshots) {
  if (!_token || !_folderId || !snapshots.length) return snapshots;
  let subId;
  try { subId = await _ensureSubfolder(`${testCode}_${resultIndex}`); }
  catch (e) { return snapshots; }

  const updated = [];
  for (let i = 0; i < snapshots.length; i++) {
    const snap = snapshots[i];
    if (snap.driveId || !snap.data) { updated.push(snap); continue; }
    try {
      const b64  = snap.data.split(',')[1];
      const bin  = atob(b64);
      const arr  = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) arr[j] = bin.charCodeAt(j);
      const blob = new Blob([arr], { type: 'image/jpeg' });
      const meta = JSON.stringify({ name: `snap_${String(i + 1).padStart(3, '0')}.jpg`, parents: [subId] });
      const fd   = new FormData();
      fd.append('metadata', new Blob([meta], { type: 'application/json' }));
      fd.append('file', blob, `snap_${i + 1}.jpg`);
      const res  = await fetch(`${GAPI}upload/drive/v3/files?uploadType=multipart`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${_token}` },
        body:    fd,
      });
      const json = await res.json();
      /* Buat file bisa dilihat siapapun yang punya link */
      await _api('POST', `drive/v3/files/${json.id}/permissions`, null,
        JSON.stringify({ type: 'anyone', role: 'reader' }), 'application/json');
      updated.push({ t: snap.t, driveId: json.id });
    } catch (e) {
      updated.push(snap);
    }
  }
  return updated;
}

function driveThumbUrl(driveId, size = 200) {
  return `https://drive.google.com/thumbnail?id=${driveId}&sz=w${size}`;
}

window.Drive = {
  init:             driveInit,
  signIn:           driveSignIn,
  signOut:          driveSignOut,
  load:             driveLoad,
  save:             driveSave,
  uploadSnapshots:  driveUploadSnapshots,
  thumbUrl:         driveThumbUrl,
  get state()       { return { ..._state }; },
};
