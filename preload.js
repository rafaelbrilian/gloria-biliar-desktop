// Jembatan aman (contextBridge, contextIsolation tetap ON) supaya halaman web
// bisa minta print SENYAP (tanpa dialog printer) ke proses utama Electron --
// 22 Agu 2026, laporan user: struk masih munculkan popup printer, tak otomatis
// hilang spt yg diharapkan utk app kasir. window.print()/iframe.print() biasa
// SELALU munculkan dialog Chromium (perilaku browser normal) -- hanya proses
// utama (webContents.print({silent:true})) yg bisa benar2 senyap, jadi
// GloriaBilliard.html (kode SAMA yg jg dipakai di browser biasa) perlu
// mendeteksi window.gloriaDesktop di sini & pakai jalur ini KALAU ADA,
// fallback ke window.print() biasa kalau tidak (mis. dibuka di browser).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gloriaDesktop', {
  isElectron: true,
  printSilently: (html, deviceName) => ipcRenderer.invoke('print-silent', html, deviceName),
  listPrinters: () => ipcRenderer.invoke('list-printers'),
  // 11 Sep 2026: jembatan "Koneksi WiFi Toko" -- lihat setupWifiHandlers() di
  // main.js. Halaman (GloriaBilliard.html, kode SAMA yg jg dipakai di browser
  // biasa) WAJIB feature-detect method2 ini satu-satu (bukan cuma isElectron)
  // sebelum dipakai -- konten web di-update terpisah & lebih sering dari shell
  // Electron ini (lihat checkForContentUpdate di main.js), jadi ada jendela
  // waktu konten BARU dimuat di shell LAMA yg belum punya method2 ini.
  listWifiProfiles: () => ipcRenderer.invoke('wifi-list-profiles'),
  getWifiStatus: () => ipcRenderer.invoke('wifi-status'),
  connectWifi: (profileName) => ipcRenderer.invoke('wifi-connect', profileName),
  getSavedWifiProfile: () => ipcRenderer.invoke('wifi-get-saved-profile'),
  setSavedWifiProfile: (profileName) => ipcRenderer.invoke('wifi-set-saved-profile', profileName),
});
