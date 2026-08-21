// Gloria Biliard -- pembungkus desktop (Electron)
//
// 22 Agu 2026 (Rencana B -- user eksplisit minta app ini "cuma untuk 1 laptop
// kasir", jalan TANPA internet sama sekali utk operasional, internet HANYA
// utk update konten & sinkron cloud/absen): SEBELUM ini app selalu memuat
// situs LIVE (https://.../GloriaBilliard) sbg jendela utama, cuma jatuh ke
// salinan lokal kalau live gagal dimuat -- artinya app ini efektif MASIH
// "bergantung ke web yg aktif" tiap kali dibuka. SEKARANG DIBALIK: jendela
// utama SELALU memuat dari SALINAN LOKAL (server statis 127.0.0.1, sama pola
// yg dulu cuma dipakai sbg fallback) -- app 100% jalan tanpa internet sama
// sekali. Internet dipakai HANYA utk: (1) checkForContentUpdate() di latar
// belakang -- diam2 unduh HTML+vendor Firebase terbaru, simpan ke cache lokal
// TERPISAH dari yg sedang aktif, baru ditukar kalau berbeda -- supaya
// perbaikan bug tetap sampai TANPA staf perlu buka browser/situs sama sekali;
// (2) sinkron Firestore (sudah dari dulu, tak berubah); (3) fitur absen lewat
// absen.html terpisah (tak berubah). TIDAK PERNAH auto-reload jendela yg
// SEDANG dipakai staf saat update datang (bisa mengganggu transaksi yg lagi
// jalan) -- update baru TERPAKAI setelah app di-restart/"Muat Ulang" manual.
const { app, BrowserWindow, Menu, session, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');
const { buildContentBundle } = require('./scripts/build-offline-bundle.js');

const SEED_BUNDLE_DIR = path.join(__dirname, 'offline-bundle'); // dibundel ke installer, seeding awal saja
const CONTENT_CACHE_DIR = path.join(app.getPath('userData'), 'content-cache'); // AKTIF, dipakai server statis
const CONTENT_STAGING_DIR = path.join(app.getPath('userData'), 'content-cache-staging'); // unduhan sementara sblm ditukar
const CONTENT_BACKUP_DIR = path.join(app.getPath('userData'), 'content-cache-backup'); // jaring pengaman saat proses tukar
const CONTENT_MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };
// PORT TETAP (bukan 0/acak) -- WAJIB, ditemukan lewat testing user 22 Agu:
// localStorage & izin Web Serial (USB lampu) Chromium terikat ke ORIGIN PENUH
// (skema+host+PORT), bukan cuma hostname. Port acak tiap start = origin baru
// tiap restart = localStorage & izin USB yg sudah diberikan sebelumnya HILANG
// diam2 stlh restart -- inilah kenapa USB tadinya "Terhubung (otomatis)" jadi
// "USB terputus" setelah Rencana B (yg tadinya masih pakai listen(0,...)).
// Angka 58234 dipilih sembarang (tak lazim dipakai software lain) -- fallback
// ke port acak HANYA kalau port ini kebetulan sedang dipakai proses lain
// (lihat startContentServer()), supaya app tetap bisa jalan meski jarang
// kehilangan persistensi utk sesi itu saja.
const FIXED_CONTENT_PORT = 58234;
const CONTENT_UPDATE_INTERVAL_MS = 45 * 60 * 1000; // cek ulang tiap 45 menit selama app tetap terbuka

// Cegah 2 instance app jalan bersamaan di 1 komputer -- 2 jendela terpisah
// yg sama-sama sinkron ke cloud bisa membingungkan (mirip 2 tab browser).
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  let mainWindow = null;
  let contentServer = null;
  let contentServerPort = null;
  let contentUpdateTimer = null;
  let contentUpdateInFlight = false;

  function dirHasContent(dir) {
    try { return fs.existsSync(path.join(dir, 'GloriaBilliard.html')); } catch (e) { return false; }
  }

  // Copy rekursif sederhana (Node 16.7+ py fs.cpSync bawaan -- Electron 33 jauh
  // lebih baru dari itu, aman dipakai langsung tanpa dependency tambahan).
  function copyDirSync(src, dest) {
    fs.cpSync(src, dest, { recursive: true });
  }

  // Pertama kali app dipasang & dibuka (userData masih kosong): isi cache aktif
  // dari salinan yg DIBUNDEL ke installer (offline-bundle/), supaya app BISA
  // langsung jalan offline SEJAK DETIK PERTAMA tanpa perlu tunggu unduhan.
  // checkForContentUpdate() di bawah akan menyegarkannya begitu ada internet.
  function ensureContentCacheSeeded() {
    if (dirHasContent(CONTENT_CACHE_DIR)) return; // sudah ada (bukan first-run, atau sudah pernah diupdate)
    try {
      if (dirHasContent(SEED_BUNDLE_DIR)) {
        copyDirSync(SEED_BUNDLE_DIR, CONTENT_CACHE_DIR);
      }
    } catch (e) { /* first-run seeding gagal -- server statis di bawah akan 404, ditangani did-fail-load bawaan Electron */ }
  }

  // Listen() sekali, ditunggu via 'error'/'listening' EKSPLISIT (bukan callback
  // ke-3 di .listen()) -- ditemukan lewat testing: passing callback SEKALIGUS
  // register 'error' listener terpisah bisa membuat KEDUANYA terpanggil dlm
  // urutan tak terduga (callback listen tetap terpanggil "sukses" meski error
  // EADDRINUSE juga terjadi), bikin resolve() menang duluan dgn nilai SALAH.
  // Pola eksplisit ini teruji bebas dari race itu.
  function tryListen(server, port) {
    return new Promise((resolve, reject) => {
      function onError(err) { cleanup(); reject(err); }
      function onListening() { cleanup(); resolve(); }
      function cleanup() { server.removeListener('error', onError); server.removeListener('listening', onListening); }
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  // Server statis lokal (127.0.0.1) yg SELALU dipakai sbg sumber jendela utama
  // (bukan lagi fallback sesekali) -- 127.0.0.1 dipilih (bukan file://) supaya
  // App Check/reCAPTCHA di dalam halaman tetap dilewati dgn benar (kodenya cek
  // location.hostname==='localhost'||'127.0.0.1').
  async function startContentServer() {
    if (contentServer) return contentServerPort;
    contentServer = http.createServer((req, res) => {
      let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      if (urlPath === '/' || urlPath === '/GloriaBilliard') urlPath = '/GloriaBilliard.html';
      const filePath = path.join(CONTENT_CACHE_DIR, urlPath);
      if (!filePath.startsWith(CONTENT_CACHE_DIR)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': CONTENT_MIME[path.extname(filePath)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    // Coba FIXED_CONTENT_PORT dulu (WAJIB utk persistensi localStorage & izin
    // Web Serial USB antar-restart, lihat komentar deklarasinya) -- kalau
    // KEBETULAN sedang dipakai proses lain (EADDRINUSE, sangat jarang di
    // laptop kasir khusus), baru jatuh ke port acak sbg fallback supaya app
    // tetap bisa jalan (cuma kehilangan persistensi utk sesi start itu saja).
    try {
      await tryListen(contentServer, FIXED_CONTENT_PORT);
      contentServerPort = FIXED_CONTENT_PORT;
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        await tryListen(contentServer, 0);
        contentServerPort = contentServer.address().port;
      } else {
        throw err;
      }
    }
    contentServer.on('error', () => {}); // koneksi individual error setelah listen sukses -- abaikan, bukan fatal
    return contentServerPort;
  }

  function contentServerUrl() {
    return `http://127.0.0.1:${contentServerPort}/GloriaBilliard.html`;
  }

  // Tukar isi cache aktif dgn hasil unduhan staging -- SELALU aman: pada
  // setiap titik, CONTENT_CACHE_DIR atau CONTENT_BACKUP_DIR pasti berisi
  // salinan yg lengkap & bisa dipakai (tak pernah dua2nya kosong sekaligus),
  // jadi kalau proses tukar gagal di tengah jalan, app tetap py sesuatu utk
  // disajikan lewat server statis di atas.
  function swapCacheWithStaging() {
    if (fs.existsSync(CONTENT_BACKUP_DIR)) fs.rmSync(CONTENT_BACKUP_DIR, { recursive: true, force: true });
    if (fs.existsSync(CONTENT_CACHE_DIR)) fs.renameSync(CONTENT_CACHE_DIR, CONTENT_BACKUP_DIR);
    try {
      fs.renameSync(CONTENT_STAGING_DIR, CONTENT_CACHE_DIR);
      fs.rmSync(CONTENT_BACKUP_DIR, { recursive: true, force: true });
    } catch (e) {
      if (fs.existsSync(CONTENT_BACKUP_DIR)) fs.renameSync(CONTENT_BACKUP_DIR, CONTENT_CACHE_DIR);
      throw e;
    }
  }

  // Cek & unduh konten terbaru di LATAR BELAKANG -- dipanggil saat startup,
  // berkala tiap CONTENT_UPDATE_INTERVAL_MS, & dari menu "Muat Ulang" (manual).
  // Gagal (tidak ada internet, situs live down, dst) DIBIARKAN DIAM2 -- cache
  // aktif yg sudah ada TETAP DIPAKAI apa adanya, app tidak pernah "rusak"
  // gara2 gagal cek update. TIDAK PERNAH auto-reload jendela yg sedang
  // dipakai staf -- update baru TERPAKAI setelah restart/"Muat Ulang" manual
  // berikutnya (lihat komentar panjang di atas file ini).
  async function checkForContentUpdate() {
    if (contentUpdateInFlight) return false;
    contentUpdateInFlight = true;
    try {
      if (fs.existsSync(CONTENT_STAGING_DIR)) fs.rmSync(CONTENT_STAGING_DIR, { recursive: true, force: true });
      await buildContentBundle(CONTENT_STAGING_DIR, { quiet: true });

      const stagingHtmlPath = path.join(CONTENT_STAGING_DIR, 'GloriaBilliard.html');
      const activeHtmlPath = path.join(CONTENT_CACHE_DIR, 'GloriaBilliard.html');
      const stagingHtml = fs.readFileSync(stagingHtmlPath, 'utf8');
      const activeHtml = fs.existsSync(activeHtmlPath) ? fs.readFileSync(activeHtmlPath, 'utf8') : null;

      if (stagingHtml === activeHtml) {
        fs.rmSync(CONTENT_STAGING_DIR, { recursive: true, force: true }); // identik -- tak perlu ditukar
        return false;
      }

      swapCacheWithStaging();
      // Beri tahu staf HALUS (toast, bukan reload paksa) -- cuma kalau
      // sedang lihat jendela app ini (bukan menyusahkan kalau app di-minimize).
      if (mainWindow) {
        mainWindow.webContents
          .executeJavaScript(
            "if(typeof showToast==='function'){showToast('🔄 Versi baru tersedia -- Muat Ulang (Ctrl+R) atau restart app utk memakainya','info');}"
          )
          .catch(() => {});
      }
      return true;
    } catch (e) {
      // Offline / situs live down / dll -- diam2, cache aktif tetap dipakai.
      try { if (fs.existsSync(CONTENT_STAGING_DIR)) fs.rmSync(CONTENT_STAGING_DIR, { recursive: true, force: true }); } catch (_e) {}
      return false;
    } finally {
      contentUpdateInFlight = false;
    }
  }

  // Muat/segarkan jendela dari server lokal -- SELALU lokal, tak pernah
  // navigasi langsung ke situs live (lihat komentar panjang di atas file ini).
  async function loadApp() {
    await startContentServer();
    mainWindow.loadURL(contentServerUrl());
  }

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 900,
      minHeight: 600,
      icon: path.join(__dirname, 'build', 'icon.ico'),
      title: 'Gloria Biliard',
      autoHideMenuBar: true, // menu tetap ADA (bisa diakses via Alt) tapi tidak menuh-menuhi tampilan
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false, // Web Serial via session handler perlu ini nonaktif di sebagian versi Electron
        preload: path.join(__dirname, 'preload.js'), // 22 Agu 2026: jembatan print-senyap, lihat preload.js
      },
    });

    loadApp();

    // Buka tautan eksternal (kalau ada) di browser sungguhan, bukan di jendela app ini.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith('http://127.0.0.1:')) {
        shell.openExternal(url);
        return { action: 'deny' };
      }
      return { action: 'allow' };
    });

    mainWindow.on('closed', () => { mainWindow = null; });
  }

  // ── Izin Web Serial (mode USB/Hybrid lampu) ──
  // Browser biasa menampilkan dialog pilih-port BAWAAN saat
  // navigator.serial.requestPort() dipanggil. Electron TIDAK punya dialog
  // itu secara otomatis -- handler di bawah WAJIB ada, kalau tidak
  // requestPort() akan menggantung tanpa pernah resolve/reject.
  function setupSerialPermissions() {
    const ses = session.defaultSession;

    ses.on('select-serial-port', (event, portList, webContents, callback) => {
      event.preventDefault();
      if (portList.length === 0) {
        callback('');
        return;
      }
      if (portList.length === 1) {
        callback(portList[0].portId);
        return;
      }
      // Lebih dari 1 port terdeteksi -- tampilkan pilihan sederhana lewat
      // dialog native (bukan UI kustom, supaya tak perlu halaman HTML baru).
      const labels = portList.map((p, i) => `${i + 1}. ${p.displayName || p.portId}`);
      dialog.showMessageBox(mainWindow, {
        type: 'question',
        title: 'Pilih Port USB',
        message: 'Beberapa perangkat USB terdeteksi. Pilih port untuk lampu ESP32:',
        detail: labels.join('\n'),
        buttons: [...portList.map((_, i) => `Port ${i + 1}`), 'Batal'],
        cancelId: portList.length,
      }).then(({ response }) => {
        if (response < portList.length) {
          callback(portList[response].portId);
        } else {
          callback('');
        }
      });
    });

    // Izinkan permintaan izin 'serial' (dipanggil browser saat requestPort()).
    ses.setPermissionCheckHandler((_webContents, permission) => {
      if (permission === 'serial') return true;
      return true; // izin lain (notifications, dst) -- default izinkan, app ini domain sendiri terpercaya
    });

    // Izinkan device serial yg SUDAH dipilih via select-serial-port di atas
    // supaya navigator.serial.getPorts() (auto-reconnect diam-diam, dipakai
    // _tryAutoReconnectUsbLampu) mengenalinya sbg sudah diizinkan.
    ses.setDevicePermissionHandler((details) => {
      if (details.deviceType === 'serial') return true;
      return false;
    });
  }

  // ── Cetak struk SENYAP (22 Agu 2026) ──
  // window.print()/iframe.print() BIASA (dipakai _printThermal() di
  // GloriaBilliard.html) selalu munculkan dialog printer Chromium -- itu
  // perilaku BROWSER normal, tapi mengganggu utk app kasir yg cetak struk tiap
  // transaksi. HANYA proses utama yg bisa benar2 senyap (webContents.print
  // dgn {silent:true}) -- jendela CETAK TERSENDIRI (bukan iframe di jendela
  // utama) dipakai supaya konten yg ter-print PERSIS struknya saja, tak
  // tercampur UI app, & tak perlu utak-atik frame mana yg "fokus" di jendela
  // utama (jendela cetak ini dibuang lgs setelah selesai, tak pernah tampil).
  function setupSilentPrinting() {
    ipcMain.handle('print-silent', async (_event, html) => {
      return new Promise((resolve) => {
        const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        printWin.webContents.once('did-finish-load', () => {
          printWin.webContents.print({ silent: true, printBackground: true }, (success, reason) => {
            printWin.close();
            resolve({ success, reason: reason || null });
          });
        });
        printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      });
    });

    // Dipakai kalau nanti perlu UI pilih printer default struk (blm ada di
    // Pengaturan skrg) -- disiapkan skalian, murah & tak mengganggu apa pun
    // kalau belum dipakai.
    ipcMain.handle('list-printers', async () => {
      try { return await mainWindow.webContents.getPrintersAsync(); }
      catch (e) { return []; }
    });
  }

  // ── Menu minimal -- TETAP sertakan Toggle DevTools & Reload, keduanya
  // terbukti krusial malam ini utk diagnosa langsung lewat Console kalau
  // ada masalah sinkron/lampu di kemudian hari. Jangan dihapus. ──
  function setupMenu() {
    const template = [
      {
        label: 'Berkas',
        submenu: [
          {
            label: 'Muat Ulang',
            accelerator: 'CmdOrCtrl+R',
            click: async () => { await checkForContentUpdate(); loadApp(); },
          },
          { label: 'Keluar', accelerator: 'CmdOrCtrl+Q', click: () => app.quit() },
        ],
      },
      {
        label: 'Tampilan',
        submenu: [
          { label: 'Perbesar', role: 'zoomIn' },
          { label: 'Perkecil', role: 'zoomOut' },
          { label: 'Ukuran Normal', role: 'resetZoom' },
          { type: 'separator' },
          { label: 'Buka DevTools (utk diagnosa)', accelerator: 'F12', click: () => mainWindow?.webContents.toggleDevTools() },
          { type: 'separator' },
          { label: 'Layar Penuh', role: 'togglefullscreen' },
        ],
      },
      {
        label: 'Bantuan',
        submenu: [
          { label: 'Cek Update Konten Sekarang', click: async () => { await checkForContentUpdate(); } },
          { label: 'Cek Update Aplikasi', click: () => autoUpdater.checkForUpdatesAndNotify() },
          { label: 'Versi: ' + app.getVersion(), enabled: false },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  app.whenReady().then(() => {
    ensureContentCacheSeeded();
    setupSerialPermissions();
    setupSilentPrinting();
    setupMenu();
    createWindow();

    // Cek update konten beberapa detik setelah start (tidak menghalangi app
    // kebuka duluan), lalu berkala selama app tetap terbuka -- lihat
    // checkForContentUpdate() utk kenapa ini aman dipanggil kapan saja.
    setTimeout(() => { checkForContentUpdate(); }, 8000);
    contentUpdateTimer = setInterval(() => { checkForContentUpdate(); }, CONTENT_UPDATE_INTERVAL_MS);

    // Cek update WRAPPER (perilaku jendela/izin, dst -- BUKAN konten billing,
    // itu ditangani checkForContentUpdate() di atas) beberapa detik setelah
    // start -- gagal (mis. offline) dibiarkan diam, app ttp jalan normal.
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 5000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (contentUpdateTimer) clearInterval(contentUpdateTimer);
    if (process.platform !== 'darwin') app.quit();
  });
}
