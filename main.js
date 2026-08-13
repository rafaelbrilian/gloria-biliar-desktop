// Gloria Biliard -- pembungkus desktop (Electron)
//
// SENGAJA memuat situs LIVE (bukan menyalin file HTML/JS ke dalam installer):
// supaya semua perbaikan/fitur baru di gloria-biliard.pages.dev otomatis
// langsung terpakai begitu app dibuka lagi -- TANPA perlu rebuild/redistribusi
// installer. Auto-updater di file ini cuma menangani update PEMBUNGKUS-nya
// sendiri (jarang berubah: perilaku jendela, izin Web Serial, dst), bukan
// konten billing yang tetap update instan seperti versi browser biasa.
const { app, BrowserWindow, Menu, session, dialog, shell } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');

const APP_URL = 'https://gloria-biliard.pages.dev/GloriaBilliard';

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
      },
    });

    mainWindow.loadURL(APP_URL);

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
          { label: 'Muat Ulang', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
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
