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
  printSilently: (html) => ipcRenderer.invoke('print-silent', html),
  listPrinters: () => ipcRenderer.invoke('list-printers'),
});
