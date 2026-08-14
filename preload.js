// Jembatan sempit & aman antara halaman (contextIsolation aktif, tak ada
// nodeIntegration) dgn main process -- SATU-SATUNYA fungsi yg diekspos:
// toggle mode Online/Offline lewat tombol yg disuntik main.js. Tidak ada
// akses Node/filesystem lain yg dibocorkan ke halaman.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('gloriaShell', {
  toggleOfflineMode: () => ipcRenderer.send('gloria:toggle-offline-mode'),
});
