// Mengunduh salinan GloriaBilliard.html + vendor Firebase SDK lokal ke sebuah
// folder tujuan. Dipakai 2 cara:
// 1. CLI manual sebelum `npm run dist`/`npm run publish` -- menyegarkan
//    offline-bundle/ (salinan yg DIBUNDEL ke installer, dipakai sbg SEEDING
//    awal isi cache konten saat aplikasi pertama kali dipasang):
//      node scripts/build-offline-bundle.js
// 2. Dipanggil LANGSUNG oleh main.js saat aplikasi jalan (22 Agu 2026, Rencana
//    B) -- mengunduh ke folder staging sementara, lalu main.js yg memutuskan
//    kapan menukar isi cache aktif kalau kontennya berbeda dari yg lama.
'use strict';
const https = require('https');
const fs = require('fs');
const path = require('path');

const LIVE_URL = 'https://gloria-biliard.pages.dev/GloriaBilliard';
// 27 Agu 2026 (review mandiri, rapikan): fetchText/fetchBinary di bawah
// SEBELUMNYA tak py timeout sama sekali -- https.get() cuma reject via
// .on('error',...) utk kegagalan KONEKSI (DNS gagal, connection refused,
// dst), TAPI koneksi yg sempat tersambung lalu NYANGKUT diam2 (mis. firewall
// venue diam2 membuang paket setelah handshake, bukan menolaknya) tak pernah
// memicu error/reject apa pun -- Promise ini bisa MENGGANTUNG SELAMANYA.
// checkForContentUpdate() di main.js memakai flag contentUpdateInFlight utk
// cegah pemanggilan tumpang-tindih -- kalau fetch ini nyangkut permanen,
// flag itu TAK PERNAH direset, memblokir SEMUA pengecekan update berikutnya
// (otomatis maupun manual) sampai app di-restart. Pola bug identik sudah
// berkali-kali ditemukan & diperbaiki di GloriaBilliard.html sendiri (semua
// pembacaan Firestore langsung dibungkus Promise.race+timeout) -- diterapkan
// pola sama di sini, pakai req.setTimeout+destroy bawaan Node (lebih bersih
// drpd Promise.race krn benar2 MEMBATALKAN koneksi yg nyangkut, bukan cuma
// mengabaikan Promise-nya sementara koneksi lama tetap jalan diam2).
const FETCH_TIMEOUT_MS = 20000;
const FIREBASE_VERSION = '10.12.0';
const FIREBASE_FILES = [
  'firebase-app-compat.js',
  'firebase-auth-compat.js',
  'firebase-firestore-compat.js',
  'firebase-database-compat.js',
  'firebase-app-check-compat.js',
];

// FIXED 29 Agu 2026 (audit putaran ke-13): dulu rekursi redirect (di bawah)
// tak dibatasi jumlah hop -- FETCH_TIMEOUT_MS cuma membatasi waktu PER hop,
// bukan waktu TOTAL akumulasi. Server/proxy yg saling memantul (redirect
// loop) bikin fungsi ini menggantung JAUH melampaui 20 detik (berpotensi tak
// pernah selesai), sehingga celah "menggantung selamanya -> contentUpdateInFlight
// terkunci selamanya" yg katanya sudah ditutup oleh FETCH_TIMEOUT_MS,
// sebenarnya masih terbuka lewat jalur redirect ini. Batasi maks 5 hop.
const MAX_REDIRECTS = 5;
function fetchText(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) { reject(new Error(`GET ${url} -> terlalu banyak redirect (kemungkinan loop)`)); return; }
        fetchText(res.headers.location, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`GET ${url} -> timeout setelah ${FETCH_TIMEOUT_MS}ms (koneksi nyangkut)`));
    });
  });
}

function fetchBinary(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirectsLeft <= 0) { reject(new Error(`GET ${url} -> terlalu banyak redirect (kemungkinan loop)`)); return; }
        fetchBinary(res.headers.location, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => {
      req.destroy(new Error(`GET ${url} -> timeout setelah ${FETCH_TIMEOUT_MS}ms (koneksi nyangkut)`));
    });
  });
}

// Unduh HTML live + vendor Firebase, tulis ke outDir. Melempar error kalau
// gagal (offline dsb) -- pemanggil (CLI atau main.js) yg menentukan cara
// menanganinya (CLI: keluar dgn kode error; main.js/Rencana B: tangkap diam2
// & pertahankan cache lama, lihat komentar checkForContentUpdate()).
async function buildContentBundle(outDir, opts) {
  opts = opts || {};
  const log = opts.quiet ? function () {} : console.log;
  const vendorDir = path.join(outDir, 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });

  log('Mengunduh halaman live:', LIVE_URL);
  let html = await fetchText(LIVE_URL);

  log('Mengunduh 5 file Firebase SDK v' + FIREBASE_VERSION + '...');
  for (const file of FIREBASE_FILES) {
    const url = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/${file}`;
    const buf = await fetchBinary(url);
    fs.writeFileSync(path.join(vendorDir, file), buf);
    log('  ' + file + ' (' + buf.length + ' bytes)');

    // Arahkan <script src="https://www.gstatic.com/firebasejs/.../file.js" ...>
    // ke salinan lokal ./vendor/file.js -- SATU-SATUNYA hal yg diubah dari HTML
    // live, sisanya dibiarkan persis sama (dependensi lain sudah berdegradasi
    // aman tanpa internet, tak perlu di-vendor).
    const cdnPattern = new RegExp(
      `https://www\\.gstatic\\.com/firebasejs/${FIREBASE_VERSION}/${file}`,
      'g'
    );
    const before = html;
    html = html.replace(cdnPattern, './vendor/' + file);
    if (html === before && !opts.quiet) {
      console.warn('  PERINGATAN: tag <script> utk ' + file + ' tidak ditemukan di HTML live -- cek manual!');
    }
  }

  const outHtmlPath = path.join(outDir, 'GloriaBilliard.html');
  fs.writeFileSync(outHtmlPath, html, 'utf8');
  log('Selesai. Bundel:', outHtmlPath);
  return outHtmlPath;
}

module.exports = { buildContentBundle, LIVE_URL };

// Jalan sbg CLI (`node scripts/build-offline-bundle.js`) -- target default
// offline-bundle/ (salinan yg dibundel ke installer). TIDAK jalan kalau
// di-require() dari main.js (require.main !== module saat itu).
if (require.main === module) {
  const OUT_DIR = path.join(__dirname, '..', 'offline-bundle');
  buildContentBundle(OUT_DIR).catch((e) => {
    console.error('Gagal membuat bundel offline:', e && e.message);
    process.exit(1);
  });
}
