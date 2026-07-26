const { app, BrowserWindow } = require('electron');
const path = require('path');
const { execSync } = require('child_process');

let mainWindow;

function getMachineUUID() {
  try {
    if (process.platform === 'win32') {
      const output = execSync('wmic path win32_computersystemproduct get uuid', { encoding: 'utf8' });
      const lines = output.trim().split('\n');
      return lines[1] ? lines[1].trim() : 'MOCK-WIN-UUID-12345';
    } else if (process.platform === 'darwin') {
      const output = execSync("ioreg -rd1 -c IOPlatformExpertDevice | grep 'IOPlatformUUID'", { encoding: 'utf8' });
      const match = output.match(/"IOPlatformUUID"\s*=\s*"(.*)"/);
      return match ? match[1].trim() : 'MOCK-MAC-UUID-12345';
    } else {
      return 'MOCK-LINUX-UUID-12345';
    }
  } catch (err) {
    console.warn("Failed to get hardware UUID, falling back to mock identifier:", err.message);
    return 'FALLBACK-UUID-99999';
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    minWidth: 1000,
    minHeight: 800,
    title: "VIGIL QC Forensic Platform",
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  const hwUuid = getMachineUUID();
  console.log(`Extracted system hardware UUID for device lock: ${hwUuid}`);

  // Load local client assets directly inside the Chromium shell
  // Query parameters carry the device hardware identification key
  const indexPath = path.join(__dirname, 'public', 'index.html');
  mainWindow.loadURL(`file://${indexPath}?hw_uuid=${encodeURIComponent(hwUuid)}`);

  mainWindow.on('closed', function () {
    mainWindow = null;
  });
}

app.on('ready', createWindow);

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', function () {
  if (mainWindow === null) {
    createWindow();
  }
});
