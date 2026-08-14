// Gloria Biliard -- pembungkus desktop (Electron)
//
// SENGAJA memuat situs LIVE (bukan menyalin file HTML/JS ke dalam installer):
// supaya semua perbaikan/fitur baru di gloria-biliard.pages.dev otomatis
// langsung terpakai begitu app dibuka lagi -- TANPA perlu rebuild/redistribusi
// installer. Auto-updater di file ini cuma menangani update PEMBUNGKUS-nya
// sendiri (jarang berubah: perilaku jendela, izin Web Serial, dst), bukan
// konten billing yang tetap update instan seperti versi browser biasa.
const { app, BrowserWindow, Menu, session, dialog, shell, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { autoUpdater } = require('electron-updater');

const APP_URL = 'https://gloria-biliard.pages.dev/GloriaBilliard';
const OFFLINE_BUNDLE_DIR = path.join(__dirname, 'offline-bundle');
const OFFLINE_MIME = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

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
  let usingFallback = false;
  let fallbackServer = null;
  let fallbackPort = null;
  // SENGAJA tidak disimpan ke disk (reset ke false tiap app dibuka ulang) --
  // supaya tak mungkin "kelupaan" tertinggal di mode offline tanpa sadar.
  // Dipakai user utk sengaja mengisolasi app dari cloud saat mau uji coba,
  // lewat tombol yg disuntik ke halaman (lihat did-finish-load di bawah).
  let manualOfflineMode = false;
  // Cegah klik ganda/cepat pada tombol toggle menimpa satu sama lain --
  // direset begitu halaman baru selesai dimuat (lihat did-finish-load).
  let toggleInFlight = false;

  // Server statis lokal (127.0.0.1) khusus menyajikan offline-bundle/ --
  // JARING PENGAMAN DARURAT saja, dipakai loadApp() cuma kalau APP_URL live
  // gagal dimuat (mis. tidak ada internet). 127.0.0.1 dipilih (bukan file://)
  // supaya App Check/reCAPTCHA di dalam halaman tetap dilewati dgn benar
  // (kodenya cek location.hostname==='localhost'||'127.0.0.1'). Lihat
  // scripts/build-offline-bundle.js utk cara bundel ini dibuat/diperbarui.
  function startFallbackServer() {
    return new Promise((resolve, reject) => {
      if (fallbackServer) { resolve(fallbackPort); return; }
      fallbackServer = http.createServer((req, res) => {
        let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '/' || urlPath === '/GloriaBilliard') urlPath = '/GloriaBilliard.html';
        const filePath = path.join(OFFLINE_BUNDLE_DIR, urlPath);
        if (!filePath.startsWith(OFFLINE_BUNDLE_DIR)) { res.writeHead(403); res.end(); return; }
        fs.readFile(filePath, (err, data) => {
          if (err) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': OFFLINE_MIME[path.extname(filePath)] || 'application/octet-stream' });
          res.end(data);
        });
      });
      fallbackServer.on('error', reject);
      fallbackServer.listen(0, '127.0.0.1', () => {
        fallbackPort = fallbackServer.address().port;
        resolve(fallbackPort);
      });
    });
  }

  // Selalu coba versi LIVE dulu (supaya perbaikan bug ttp instan seperti biasa
  // -- ini prinsip yg sudah disepakati sejak awal proyek shell ini). Cuma
  // jatuh ke salinan offline lokal kalau navigasi ke APP_URL benar2 gagal,
  // lewat listener did-fail-load di createWindow(). loadApp() juga dipanggil
  // ulang oleh menu "Muat Ulang"/Ctrl+R, jadi reload manual = coba online lagi
  // (cara alami utk "naik" kembali ke versi live begitu internet pulih).
  function loadApp() {
    if (manualOfflineMode) {
      usingFallback = true;
      startFallbackServer()
        .then((port) => { mainWindow.loadURL(`http://127.0.0.1:${port}/GloriaBilliard.html`); })
        .catch(() => {});
      return;
    }
    usingFallback = false;
    mainWindow.loadURL(APP_URL);
  }

  // Tombol toggle dipencet (lihat suntikan di did-finish-load) -- selalu
  // tafsirkan sbg "coba mode SEBALIKNYA dari yg sedang tampil sekarang",
  // apa pun alasan kenapa sedang di mode itu (dipaksa atau internet mati
  // beneran). loadApp() yg baca manualOfflineMode akan urus sisanya.
  ipcMain.on('gloria:toggle-offline-mode', (event) => {
    // Keamanan: toggleOfflineMode diekspos via contextBridge ke SEMUA
    // halaman yg dimuat window ini, termasuk halaman LIVE produksi -- tanpa
    // cek ini, skrip apa pun di halaman itu (mis. XSS di masa depan) bisa
    // memutus sinkron cloud diam2 tanpa klik asli dari user sama sekali.
    const senderUrl = event.senderFrame && event.senderFrame.url;
    const isKnownOrigin = senderUrl && (senderUrl.startsWith(APP_URL) || senderUrl.startsWith('http://127.0.0.1:'));
    if (!isKnownOrigin || toggleInFlight) return;

    const goingOffline = !usingFallback;
    function proceed() {
      toggleInFlight = true;
      manualOfflineMode = goingOffline;
      loadApp();
    }

    if (goingOffline) {
      // Arah online->offline sengaja diminta konfirmasi -- ini yg berisiko
      // menarik keluar dari halaman live di tengah transaksi kalau tombolnya
      // kepencet tak sengaja (mis. layar sentuh kasir).
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Paksa Mode Offline?',
        message: 'Yakin mau paksa app ke mode Offline?',
        detail: 'App akan keluar dari halaman online saat ini. Data yang sudah tersimpan lokal aman, tapi pastikan tidak sedang di tengah transaksi penting.',
        buttons: ['Batal', 'Ya, Paksa Offline'],
        cancelId: 0,
        defaultId: 0,
      }).then(({ response }) => { if (response === 1) proceed(); });
    } else {
      proceed();
    }
  });

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
        preload: path.join(__dirname, 'preload.js'),
      },
    });

    loadApp();

    // Live gagal dimuat (mis. tidak ada internet saat app dibuka) -- jatuh ke
    // salinan offline lokal. errorCode -3 (ERR_ABORTED) dilewati krn itu efek
    // samping navigasi normal yg digantikan navigasi lain, bukan gagal betulan.
    mainWindow.webContents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || usingFallback || errorCode === -3) return;
      if (!validatedURL || !validatedURL.startsWith(APP_URL)) return;
      usingFallback = true;
      startFallbackServer()
        .then((port) => { mainWindow.loadURL(`http://127.0.0.1:${port}/GloriaBilliard.html`); })
        .catch(() => {}); // server lokal pun gagal -- biarkan halaman error bawaan Electron tampil
    });

    mainWindow.webContents.on('did-finish-load', () => {
      toggleInFlight = false;
      if (usingFallback) {
        mainWindow.webContents
          .executeJavaScript(
            "if(typeof showToast==='function'){showToast('Mode offline — pakai salinan cadangan, data tersimpan lokal & tersinkron otomatis saat online lagi.','warning');}"
          )
          .catch(() => {});
      }

      // Tombol kecil pojok kanan-bawah, disuntik dari sini (BUKAN bagian dari
      // GloriaBilliard.html) -- jadi cuma muncul di app desktop ini, tidak
      // pernah muncul di versi web/laptop kasir. Disuntik ulang tiap halaman
      // selesai dimuat supaya labelnya selalu cocok dgn mode yg sedang aktif.
      const label = usingFallback
        ? (manualOfflineMode ? '📴 Offline (dipaksa) — klik utk coba Online' : '📴 Offline (tak ada internet) — klik utk coba Online')
        : '🌐 Online — klik utk paksa Offline';
      const bg = usingFallback ? '#b45309' : '#15803d';
      mainWindow.webContents
        .executeJavaScript(`(function(){
          var old = document.getElementById('__gloria_net_toggle');
          if (old) old.remove();
          var btn = document.createElement('button');
          btn.id = '__gloria_net_toggle';
          btn.textContent = ${JSON.stringify(label)};
          btn.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;padding:8px 14px;border-radius:8px;border:none;font-size:12px;font-family:sans-serif;cursor:pointer;color:#fff;background:${bg};box-shadow:0 2px 8px rgba(0,0,0,.35);';
          btn.onclick = function(){ if (window.gloriaShell) window.gloriaShell.toggleOfflineMode(); };
          document.body.appendChild(btn);
        })();`)
        .catch(() => {});
    });

    // Buka tautan eksternal (kalau ada) di browser sungguhan, bukan di jendela app ini.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      if (!url.startsWith(APP_URL)) {
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

  // ── Menu minimal -- TETAP sertakan Toggle DevTools & Reload, keduanya
  // terbukti krusial malam ini utk diagnosa langsung lewat Console kalau
  // ada masalah sinkron/lampu di kemudian hari. Jangan dihapus. ──
  function setupMenu() {
    const template = [
      {
        label: 'Berkas',
        submenu: [
          { label: 'Muat Ulang', accelerator: 'CmdOrCtrl+R', click: () => loadApp() },
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
          { label: 'Cek Update Aplikasi', click: () => autoUpdater.checkForUpdatesAndNotify() },
          { label: 'Versi: ' + app.getVersion(), enabled: false },
        ],
      },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  app.whenReady().then(() => {
    setupSerialPermissions();
    setupMenu();
    createWindow();

    // Cek update beberapa detik setelah start (tidak menghalangi app kebuka
    // duluan) -- gagal (mis. offline) dibiarkan diam, app ttp jalan normal.
    setTimeout(() => {
      autoUpdater.checkForUpdatesAndNotify().catch(() => {});
    }, 5000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
