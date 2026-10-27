# Ruang Tes (R_Tes_v.10)

Platform psikotes daring (SPA statis, deploy di Vercel).

## Agar data sama di semua browser (Supabase)

1. Buat project di https://supabase.com.
2. Buka **SQL Editor**, jalankan isi `supabase.sql`.
3. Salin **Project URL** dan **anon public key** (Project Settings → API) ke `js/config.js`.
4. Deploy ulang. Setelah itu akun, tes, hasil, dan foto kamera tersimpan di Supabase.

Tanpa konfigurasi, aplikasi tetap jalan tetapi data hanya di `localStorage` browser.

Catatan: ini sinkronisasi data saja. Kata sandi masih plaintext dan login masih diperiksa di sisi klien; policy di `supabase.sql` mengizinkan akses anon. Untuk produksi, pindahkan auth ke Supabase Auth.
