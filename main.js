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
  // 22 Agu 2026 (review mandiri): komentar lama di sini bilang "server statis
  // 404 ditangani did-fail-load bawaan Electron" -- itu SISA dari arsitektur
  // SEBELUM Rencana B (waktu itu did-fail-load memang ada, dipakai utk jatuh
  // dari live ke offline). Rencana B menghapus handler itu (tak perlu lagi,
  // krn tak ada lagi "live" utk dicoba duluan) TAPI lupa comment ini ikut
  // diperbarui -- SEBENARNYA kalau seeding gagal (mis. offline-bundle korup/
  // hilang dari instalasi) & belum pernah ada internet sama sekali utk
  // checkForContentUpdate() menyelamatkan, jendela utama akan 404 TANPA
  // penanganan apa pun. Ditambahkan didFailLoad handler eksplisit di
  // createWindow() di bawah utk menutup celah ini (kasus sangat jarang,
  // tapi lebih baik ada pesan jelas drpd layar putih/error bawaan Electron).
  function ensureContentCacheSeeded() {
    if (dirHasContent(CONTENT_CACHE_DIR)) return; // sudah ada (bukan first-run, atau sudah pernah diupdate)
    try {
      if (dirHasContent(SEED_BUNDLE_DIR)) {
        copyDirSync(SEED_BUNDLE_DIR, CONTENT_CACHE_DIR);
      }
    } catch (e) { /* first-run seeding gagal -- lihat didFailLoad handler di createWindow() */ }
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
      // 28 Agu 2026 (audit menyeluruh): SEBELUMNYA cek containment cuma
      // string-prefix polos (filePath.startsWith(CONTENT_CACHE_DIR)) --
      // CONTENT_STAGING_DIR/CONTENT_BACKUP_DIR (folder SAUDARA, nama
      // "content-cache-staging"/"content-cache-backup") kebetulan berbagi
      // PREFIX STRING PERSIS SAMA dgn "content-cache" (tanpa pemisah jalur
      // di antaranya) -- path traversal (mis. "/../content-cache-staging/
      // GloriaBilliard.html") lolos cek startsWith INI padahal SECARA
      // NYATA sudah keluar dari folder yg dimaksud. Dampak nyata rendah
      // (server cuma dengar 127.0.0.1, & isi folder saudara itu bukan
      // rahasia -- sama2 salinan GloriaBilliard.html publik), TAPI tetap
      // celah nyata yg wajib ditutup benar -- pola path.relative() di bawah
      // JAUH lebih aman drpd string-prefix apa pun (menangani kasus batas
      // pemisah jalur & path traversal dgan benar).
      const relPath = path.relative(CONTENT_CACHE_DIR, filePath);
      if (relPath.startsWith('..') || path.isAbsolute(relPath)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        // FIXED 29 Agu 2026 (audit putaran ke-13): server ini cuma dengar
        // 127.0.0.1 tapi TANPA autentikasi/pengecekan asal permintaan apa
        // pun -- tanpa header ini, browser BIASA (bukan app Electron ini)
        // yg kebetulan dipakai di laptop kasir yg sama bisa memuat
        // http://127.0.0.1:PORT/GloriaBilliard.html di dalam <iframe>
        // tersembunyi milik halaman pihak ketiga mana pun (celah UI-redress/
        // clickjacking klasik) -- instance di dalam iframe itu tetap
        // terhubung ke Firestore PRODUKSI yg sama (config sama persis, bukan
        // salinan statis beku).
        res.writeHead(200, {
          'Content-Type': CONTENT_MIME[path.extname(filePath)] || 'application/octet-stream',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "frame-ancestors 'none'",
        });
        res.end(data);
      });
    });
    // Coba FIXED_CONTENT_PORT dulu (WAJIB utk persistensi localStorage & izin
    // Web Serial USB antar-restart, lihat komentar deklarasinya) -- kalau
    // KEBETULAN sedang dipakai proses lain (EADDRINUSE, sangat jarang di
    // laptop kasir khusus), baru jatuh ke port acak sbg fallback supaya app
    // tetap bisa jalan (cuma kehilangan persistensi utk sesi start itu saja).
    // FIXED 29 Agu 2026 (audit putaran ke-13): dulu HANYA err.code==='EADDRINUSE'
    // yg di-fallback ke port acak -- 58234 kebetulan JATUH DI DALAM rentang
    // dynamic/ephemeral port bawaan Windows (49152-65535, dipakai OS utk
    // source port koneksi keluar APA PUN), jadi peluang bentrok lebih tinggi
    // dari asumsi komentar lama. Laptop dgn Hyper-V/WSL2/Docker Desktop aktif
    // (makin umum, kadang aktif tanpa user sadar) rutin punya "excluded port
    // range" dinamis -- kalau 58234 masuk situ, bind() gagal dgn EACCES,
    // BUKAN EADDRINUSE, & sebelumnya di-throw mentah (bikin loadApp() reject
    // tanpa pernah loadURL() dipanggil sama sekali -- jendela putih kosong
    // SELAMANYA, lihat catch(.) di createWindow()/menu Muat Ulang di bawah).
    // Fallback ke port acak sekarang berlaku utk error listen APA PUN dari
    // port tetap (bukan cuma EADDRINUSE) -- app selalu berhasil jalan, walau
    // (spt sudah didokumentasikan) kehilangan persistensi localStorage/izin
    // USB Serial utk sesi start itu saja kalau sampai fallback ini kepakai.
    try {
      await tryListen(contentServer, FIXED_CONTENT_PORT);
      contentServerPort = FIXED_CONTENT_PORT;
    } catch (err) {
      await tryListen(contentServer, 0);
      contentServerPort = contentServer.address().port;
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
  // 27 Agu 2026 (review mandiri, rapikan): SEBELUMNYA balas boolean polos
  // (true=ditukar, false=SAMA-SAMA dipakai utk "sudah terbaru" MAUPUN "gagal
  // cek/offline" -- tak bisa dibedakan). Cukup utk 3 pemanggil OTOMATIS (aman
  // tetap diam2 apa pun hasilnya), tapi menu "Cek Update Konten Sekarang" yg
  // DIPICU MANUAL staf sebelumnya TIDAK PERNAH memberi tahu apa pun -- klik,
  // tak ada respons terlihat, staf tak tahu apakah berhasil/gagal/memang sudah
  // terbaru. Sekarang balas {updated, error} -- pemanggil otomatis tetap
  // abaikan field ini (perilaku tak berubah), menu manual di bawah pakai utk
  // kasih tahu hasilnya eksplisit.
  async function checkForContentUpdate() {
    if (contentUpdateInFlight) return { updated: false, error: null };
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
        return { updated: false, error: null };
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
      return { updated: true, error: null };
    } catch (e) {
      // Offline / situs live down / dll -- diam2utk pemanggil otomatis, cache
      // aktif tetap dipakai. Pesan errornya tetap dikembalikan (dipakai menu
      // manual di bawah), bukan dibuang.
      try { if (fs.existsSync(CONTENT_STAGING_DIR)) fs.rmSync(CONTENT_STAGING_DIR, { recursive: true, force: true }); } catch (_e) {}
      return { updated: false, error: (e && e.message) || String(e) };
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
  // FIXED 29 Agu 2026 (audit putaran ke-13): loadApp() dulu dipanggil di 3
  // tempat (createWindow saat startup, tombol "Coba Lagi", menu Muat Ulang)
  // TANPA .catch() sama sekali -- did-fail-load HANYA menangkap kegagalan
  // navigasi SETELAH loadURL() berhasil dipanggil; kalau loadApp() sendiri
  // reject SEBELUM sempat memanggil loadURL() (mis. startContentServer()
  // melempar error yg tak diantisipasi), rejection itu jadi unhandled
  // promise rejection senyap -- jendela app tetap terbuka tapi KOSONG PUTIH
  // SELAMANYA, tanpa dialog error apa pun (persis skenario yg justru ingin
  // dicegah did-fail-load). Wrapper ini jadi jaring pengaman terakhir --
  // fix di startContentServer() di atas SUDAH menutup penyebab paling nyata
  // (EACCES), ini cuma lapisan tambahan kalau ada penyebab lain di masa depan.
  function loadAppSafe() {
    loadApp().catch((err) => {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Gagal memuat aplikasi',
        message: 'Gloria Biliard gagal memuat halamannya sendiri (' + ((err && err.message) || String(err)) + ').',
        detail: 'Ini seharusnya sangat jarang terjadi. Coba: (1) tutup & buka lagi aplikasi ini, (2) pastikan laptop terhubung internet lalu buka lagi (supaya app bisa mengunduh ulang kontennya), (3) kalau tetap gagal, hubungi yang memasang aplikasi ini.',
        buttons: ['Coba Lagi', 'Tutup'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) loadAppSafe();
      });
    });
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

    loadAppSafe();

    // 22 Agu 2026 (review mandiri, jaring pengaman kasus sangat jarang): kalau
    // server statis lokal gagal menyajikan GloriaBilliard.html (mis. cache
    // kosong krn seeding pertama gagal, DAN belum pernah online sekalipun utk
    // checkForContentUpdate() menyelamatkan) -- tanpa handler ini, staf cuma
    // lihat layar putih/error bawaan Electron tanpa penjelasan apa pun.
    // errorCode -3 (ERR_ABORTED) DILEWATI -- itu efek samping navigasi normal
    // yg digantikan navigasi lain (mis. klik Muat Ulang di tengah loading
    // sebelumnya), bukan kegagalan sungguhan.
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return;
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Gagal memuat aplikasi',
        message: 'Gloria Biliard gagal memuat halamannya sendiri (' + errorDescription + ').',
        detail: 'Ini seharusnya sangat jarang terjadi. Coba: (1) tutup & buka lagi aplikasi ini, (2) pastikan laptop terhubung internet lalu buka lagi (supaya app bisa mengunduh ulang kontennya), (3) kalau tetap gagal, hubungi yang memasang aplikasi ini.',
        buttons: ['Coba Lagi', 'Tutup'],
        defaultId: 0,
      }).then(({ response }) => {
        if (response === 0) loadAppSafe();
      });
    });

    // Buka tautan eksternal (kalau ada) di browser sungguhan, bukan di jendela app ini.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      // FIXED 30 Agu 2026 (audit putaran ke-14, KRITIS): window.open('','_blank')
      // -- dipakai GloriaBilliard.html utk 3 fitur cetak/PDF on-the-fly
      // (printLaporanHarian/printAbsensi/exportAbsensiPDF, document.write ke
      // popup) -- me-resolve ke navigasi 'about:blank', BUKAN url eksternal.
      // SEBELUMNYA url ini ikut kena cek di bawah (tak diawali http://127.0.0.1:)
      // -> dianggap "eksternal" -> shell.openExternal('about:blank') (buka
      // browser OS ke tab kosong, efek samping tak diminta) + deny (window
      // baru TAK PERNAH benar2 dibuat, window.open() balik null di renderer)
      // -> w.document.write(html) crash TypeError tak tertangkap -> 3 fitur
      // cetak/PDF di atas GAGAL TOTAL & SENYAP (tanpa toast) di app Desktop
      // ini, padahal normal di browser biasa. Izinkan about:blank secara
      // eksplisit sebelum cek eksternal.
      if (url === 'about:blank' || url === '') {
        return { action: 'allow' };
      }
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
    // FIXED 30 Agu 2026 (audit putaran ke-14, KRITIS): setDevicePermissionHandler
    // di bawah SEBELUMNYA meng-otorisasi SEMUA device bertipe 'serial' tanpa
    // syarat -- komentarnya bilang niatnya "izinkan device yg SUDAH dipilih
    // via select-serial-port", tapi kodenya tak pernah benar2 mencocokkan
    // itu. Akibatnya navigator.serial.getPorts() (dipakai
    // _tryAutoReconnectUsbLampu() auto-reconnect diam2 di GloriaBilliard.html)
    // mengembalikan SEMUA port serial yg terpasang di laptop, bukan cuma yg
    // pernah dipilih via dialog app ini -- kalau ada device serial LAIN
    // tercolok (printer serial, RFID reader/absensi yg direncanakan, dongle
    // apa pun), auto-reconnect (yg blind ambil ports[0]) bisa nyambung ke
    // device yg SALAH tanpa terdeteksi (write() ke device salah biasanya
    // tak throw, jadi tak ada toast error -- kasir percaya lampu USB
    // tersambung normal padahal tidak). Fix: catat portId yg BENAR2
    // disetujui lewat select-serial-port di bawah, setDevicePermissionHandler
    // cuma approve portId yg ADA di daftar itu.
    const approvedSerialPortIds = new Set();

    ses.on('select-serial-port', (event, portList, webContents, callback) => {
      event.preventDefault();
      if (portList.length === 0) {
        callback('');
        return;
      }
      if (portList.length === 1) {
        approvedSerialPortIds.add(portList[0].portId);
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
          approvedSerialPortIds.add(portList[response].portId);
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

    // Izinkan HANYA device serial yg portId-nya benar2 pernah disetujui lewat
    // select-serial-port di atas (lihat komentar panjang di deklarasi
    // approvedSerialPortIds -- SEBELUMNYA blanket-true utk SEMUA device 'serial').
    ses.setDevicePermissionHandler((details) => {
      if (details.deviceType !== 'serial') return false;
      return approvedSerialPortIds.has(details.device && details.device.portId);
    });
  }

  // ── Unduhan (Export CSV/Excel) SENYAP (30 Agu 2026, audit putaran ke-14) ──
  // Browser biasa (Chrome/Edge setelan default) langsung simpan file blob
  // unduhan (tombol Export CSV/Excel di tab Laporan/Turnamen/Histori Shift)
  // ke folder Downloads TANPA dialog apa pun. Electron TANPA
  // session.on('will-download') terdaftar menampilkan dialog "Save As"
  // bawaan Windows utk SETIAP unduhan (perilaku default Electron kalau
  // savePath tak diset lewat API) -- dialog sistem yg tak pernah ada di
  // versi web. Karena kode Export (GloriaBilliard.html) menembak toast
  // "✅ ... berhasil!" SEGERA sesudah memicu unduhan (tanpa menunggu dialog
  // itu selesai), staf yg meng-Cancel dialog (kaget krn dialog sistem
  // tiba2 muncul, sesuatu yg tak pernah terjadi sebelumnya) tetap melihat
  // pesan "berhasil" walau file SAMA SEKALI tak tersimpan. Fix: simpan
  // otomatis ke folder Downloads, meniru persis perilaku default browser --
  // tanpa dialog sama sekali.
  function setupSilentDownloads() {
    session.defaultSession.on('will-download', (_event, item) => {
      item.setSavePath(path.join(app.getPath('downloads'), item.getFilename()));
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
    ipcMain.handle('print-silent', async (_event, html, deviceName) => {
      return new Promise((resolve) => {
        const printWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
        const printOpts = { silent: true, printBackground: true };
        // deviceName eksplisit (dipilih di Pengaturan > Pengaturan Printer) --
        // kosong/null = pakai printer default Windows saat ini (perilaku lama).
        if (deviceName) printOpts.deviceName = deviceName;
        // 22 Agu 2026 (review mandiri, blm ada laporan nyata): SEBELUMNYA tak
        // py jaring pengaman kalau 'did-finish-load' tak pernah terpanggil
        // (data: URL nyaris tak pernah gagal, tapi kalau terjadi -- HTML
        // rusak/terlalu besar -- jendela print tersembunyi ini NYANGKUT
        // SELAMANYA & panggilan cetak dari halaman tak pernah selesai/gagal
        // sama sekali, cuma diam menggantung). settled+timer memastikan
        // Promise SELALU resolve & jendela SELALU ditutup, apa pun yg terjadi.
        let settled = false;
        const finish = (result) => {
          if (settled) return;
          settled = true;
          clearTimeout(safetyTimer);
          try { if (!printWin.isDestroyed()) printWin.close(); } catch (e) {}
          resolve(result);
        };
        const safetyTimer = setTimeout(() => {
          finish({ success: false, reason: 'timeout: halaman cetak tidak selesai dimuat' });
        }, 15000);
        printWin.webContents.once('did-fail-load', (_e, errorCode, errorDescription) => {
          finish({ success: false, reason: 'gagal memuat halaman cetak: ' + errorDescription });
        });
        printWin.webContents.once('did-finish-load', () => {
          printWin.webContents.print(printOpts, (success, reason) => {
            finish({ success, reason: reason || null });
          });
        });
        printWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      });
    });

    // Dipakai UI Pengaturan > Pengaturan Printer utk pilih printer target
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
            click: async () => { await checkForContentUpdate(); loadAppSafe(); },
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
          {
            label: 'Cek Update Konten Sekarang',
            click: async () => {
              const result = await checkForContentUpdate();
              if (result.error) {
                dialog.showMessageBox(mainWindow, {
                  type: 'warning',
                  title: 'Cek Update Konten',
                  message: 'Gagal memeriksa pembaruan konten.',
                  detail: 'Pastikan laptop terhubung internet lalu coba lagi.\n\nDetail teknis: ' + result.error,
                });
              } else if (result.updated) {
                dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  title: 'Cek Update Konten',
                  message: 'Pembaruan konten ditemukan & sudah diunduh.',
                  detail: 'Klik "Muat Ulang" (Ctrl+R) atau restart aplikasi ini untuk memakainya.',
                });
              } else {
                dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  title: 'Cek Update Konten',
                  message: 'Konten aplikasi sudah versi terbaru.',
                });
              }
            },
          },
          {
            label: 'Cek Update Aplikasi',
            click: () => {
              autoUpdater.checkForUpdatesAndNotify().catch((e) => {
                dialog.showMessageBox(mainWindow, {
                  type: 'warning',
                  title: 'Cek Update Aplikasi',
                  message: 'Gagal memeriksa pembaruan aplikasi.',
                  detail: 'Pastikan laptop terhubung internet lalu coba lagi.\n\nDetail teknis: ' + ((e && e.message) || String(e)),
                });
              });
            },
          },
          { label: 'Versi: ' + app.getVersion(), enabled: false },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  app.whenReady().then(() => {
    ensureContentCacheSeeded();
    setupSerialPermissions();
    setupSilentDownloads();
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
