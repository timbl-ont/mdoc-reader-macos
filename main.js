const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const NFCHandler = require('./nfc-handler');
const BLEHandler = require('./ble-handler');
const MDLParser = require('./mdl-parser');
const HardwareSimulator = require('./simulator');

let mainWindow;
let nfcHandler;
let bleHandler;
let mdlParser;
let simulator;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 950,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0F172A' // Premium Slate dark background
  });

  mainWindow.loadFile('index.html');

  mainWindow.on('closed', () => {
    mainWindow = null;
    stopAllDevices();
  });
}

function logToRenderer(text) {
  if (mainWindow) {
    mainWindow.webContents.send('console-log', text);
  }
}

function sendStatus(state, message) {
  if (mainWindow) {
    mainWindow.webContents.send('status-update', { state, message });
  }
  if (nfcHandler && (state === 'SUCCESS' || state === 'ERROR' || state === 'IDLE')) {
    nfcHandler.isProcessing = false;
  }
}

function stopAllDevices() {
  if (nfcHandler) {
    nfcHandler.stop();
  }
  if (bleHandler) {
    bleHandler.stopScanning();
    bleHandler.disconnect();
  }
}

app.whenReady().then(() => {
  // Initialize Core Parser
  mdlParser = new MDLParser(logToRenderer);

  // Initialize NFC Handler
  nfcHandler = new NFCHandler(
    logToRenderer,
    async (deviceEngagementBytes, ndefSelectMessageBytes, ndefRequestMessageBytes) => {
      // NFC Tap callback: extracts engagement payload
      sendStatus('NFC_READING', 'Device Engagement read. Initializing cryptographic session...');
      
      try {
        const isDirectNfc = nfcHandler.isDirectMdlEngagement;
        
        await mdlParser.initializeSession(deviceEngagementBytes, ndefSelectMessageBytes, isDirectNfc, ndefRequestMessageBytes);
        
        // Extract BLE Service UUID
        let bleServiceUuid;
        if (ndefSelectMessageBytes && nfcHandler.bleServiceUuid) {
          bleServiceUuid = nfcHandler.bleServiceUuid;
          logToRenderer(`Using TNEP negotiated BLE Service UUID: ${bleServiceUuid}`);
        } else {
          bleServiceUuid = extractBleServiceUuid(mdlParser.deviceEngagement);
          if (!bleServiceUuid) {
            throw new Error('No compatible BLE Retrieval Method found in Device Engagement.');
          }
          logToRenderer(`BLE Service UUID Extracted: ${bleServiceUuid}`);
        }
        
        // Start BLE scanning
        bleHandler.startScanning(bleServiceUuid);
      } catch (err) {
        logToRenderer(`Session Initialization Error: ${err.message}`);
        sendStatus('ERROR', err.message);
      }
    },
    (state, msg) => {
      sendStatus(state, msg);
    }
  );

  // Initialize BLE Handler
  bleHandler = new BLEHandler(
    logToRenderer,
    async (responseBytes) => {
      // BLE response received callback
      sendStatus('VERIFYING', 'Decrypting and verifying response signatures...');
      try {
        const profile = await mdlParser.processSessionResponse(responseBytes);
        sendStatus('SUCCESS', 'mDL Verified Successfully!');
        
        // Log attributes summary
        logToRenderer('--------------------------------------------------');
        logToRenderer('DECRYPTED mDL ATTRIBUTES SHARED:');
        logToRenderer(`Family Name: ${profile.familyName}`);
        logToRenderer(`Given Name(s): ${profile.givenName}`);
        logToRenderer(`Document Number: ${profile.documentNumber}`);
        logToRenderer(`Date of Birth: ${profile.birthDate}`);
        logToRenderer(`Issue Date: ${profile.issueDate}`);
        logToRenderer(`Expiry Date: ${profile.expiryDate}`);
        logToRenderer(`Issuing Authority: ${profile.issuingAuthority}`);
        if (profile.drivingPrivileges && profile.drivingPrivileges.length > 0) {
          logToRenderer(`Driving Privileges: ${JSON.stringify(profile.drivingPrivileges)}`);
        }
        const hasFailedChecks = profile.verification.some(check => check.status === 'FAILED');
        const finalResult = hasFailedChecks ? 'VERIFICATION WARNING' : 'VERIFIED';
        logToRenderer(`OVERALL VERIFICATION RESULT: ${finalResult}`);
        logToRenderer('--------------------------------------------------');
        
        mainWindow.webContents.send('profile-decoded', profile);
      } catch (err) {
        logToRenderer(`Error processing SessionResponse: ${err.message}`);
        sendStatus('ERROR', err.message);
      }
    },
    (err) => {
      logToRenderer(`BLE Error: ${err.message}`);
      sendStatus('ERROR', err.message);
    }
  );

  // Set up BLE request sender trigger
  bleHandler.onReadyToSendRequest = async () => {
    try {
      const requestPayload = await mdlParser.createSessionEstablishment();
      bleHandler.sendRequestPayload(requestPayload);
      sendStatus('BLE_TRANSFERRING', 'Exchanging encrypted mDL request...');
    } catch (err) {
      logToRenderer(`Error creating SessionEstablishment: ${err.message}`);
      sendStatus('ERROR', err.message);
    }
  };

  // Initialize Hardware Simulator / Demo Mode
  simulator = new HardwareSimulator(
    logToRenderer,
    (state, msg) => sendStatus(state, msg),
    (profile) => {
      if (mainWindow) {
        // Log attributes summary for simulated run too
        logToRenderer('--------------------------------------------------');
        logToRenderer('DECRYPTED mDL ATTRIBUTES SHARED (SIMULATED):');
        logToRenderer(`Family Name: ${profile.familyName}`);
        logToRenderer(`Given Name(s): ${profile.givenName}`);
        logToRenderer(`Document Number: ${profile.documentNumber}`);
        logToRenderer(`Date of Birth: ${profile.birthDate}`);
        logToRenderer(`Issue Date: ${profile.issueDate}`);
        logToRenderer(`Expiry Date: ${profile.expiryDate}`);
        logToRenderer(`Issuing Authority: ${profile.issuingAuthority}`);
        if (profile.drivingPrivileges && profile.drivingPrivileges.length > 0) {
          logToRenderer(`Driving Privileges: ${JSON.stringify(profile.drivingPrivileges)}`);
        }
        const hasFailedChecks = profile.verification.some(check => check.status === 'FAILED');
        const finalResult = hasFailedChecks ? 'VERIFICATION WARNING' : 'VERIFIED';
        logToRenderer(`OVERALL VERIFICATION RESULT: ${finalResult}`);
        logToRenderer('--------------------------------------------------');

        mainWindow.webContents.send('profile-decoded', profile);
      }
    }
  );

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Helper to parse BLE Service UUID from DeviceEngagement
function extractBleServiceUuid(deviceEngagement) {
  if (!deviceEngagement || !deviceEngagement.deviceRetrievalMethods) return null;
  
  for (const method of deviceEngagement.deviceRetrievalMethods) {
    // BLE method type is 2
    if (method.type === 2 || method.type === 'Ble') {
      const opts = method.retrievalOptions;
      if (opts && opts.peripheralServerMode) {
        let uuid = opts.peripheralServerModeUuid;
        if (uuid instanceof Uint8Array || Buffer.isBuffer(uuid)) {
          // Convert 16 bytes UUID buffer to 128-bit String representation (e.g. 8-4-4-4-12)
          const hex = Buffer.from(uuid).toString('hex').toLowerCase();
          return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}`;
        }
        return uuid; // If already a string
      }
    }
  }
  return null;
}

// IPC Handlers from Renderer
ipcMain.handle('start-listening', () => {
  sendStatus('NFC_WAITING', 'Waiting for NFC Device Tap...');
  nfcHandler.start();
});

ipcMain.handle('stop-listening', () => {
  stopAllDevices();
  sendStatus('IDLE', 'Reader Stopped.');
});

ipcMain.handle('run-simulator', () => {
  simulator.runDemo();
});
