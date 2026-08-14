// Membuat salinan cadangan offline dari GloriaBilliard.html + vendor Firebase SDK
// lokal, dipakai main.js sbg fallback OTOMATIS HANYA saat live URL gagal dimuat
// (lihat loadApp() di main.js). Bukan dipakai sehari-hari -- versi live tetap
// prioritas utama setiap kali ada internet, supaya perbaikan bug tetap instan.
//
// Jalankan manual sebelum tiap `npm run dist`/`npm run publish` kalau ingin
// jaring pengamannya ikut memuat versi terbaru:
//   node scripts/build-offline-bundle.js
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

const OUT_DIR = path.join(__dirname, '..', 'offline-bundle');
const VENDOR_DIR = path.join(OUT_DIR, 'vendor');

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

async function main() {
  fs.mkdirSync(VENDOR_DIR, { recursive: true });

  console.log('Mengunduh halaman live:', LIVE_URL);
  let html = await fetchText(LIVE_URL);

  console.log('Mengunduh 5 file Firebase SDK v' + FIREBASE_VERSION + '...');
  for (const file of FIREBASE_FILES) {
    const url = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}/${file}`;
    const buf = await fetchBinary(url);
    fs.writeFileSync(path.join(VENDOR_DIR, file), buf);
    console.log('  ' + file + ' (' + buf.length + ' bytes)');

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
    if (html === before) {
      console.warn('  PERINGATAN: tag <script> utk ' + file + ' tidak ditemukan di HTML live -- cek manual!');
    }
  }

  const outHtmlPath = path.join(OUT_DIR, 'GloriaBilliard.html');
  fs.writeFileSync(outHtmlPath, html, 'utf8');
  console.log('Selesai. Bundel offline:', outHtmlPath);
}

main().catch((e) => {
  console.error('Gagal membuat bundel offline:', e && e.message);
  process.exit(1);
});
