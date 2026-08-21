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
const FIREBASE_VERSION = '10.12.0';
const FIREBASE_FILES = [
  'firebase-app-compat.js',
  'firebase-auth-compat.js',
  'firebase-firestore-compat.js',
  'firebase-database-compat.js',
  'firebase-app-check-compat.js',
];

function fetchText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchText(res.headers.location).then(resolve, reject);
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
    }).on('error', reject);
  });
}

function fetchBinary(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBinary(res.headers.location).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} -> HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
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
