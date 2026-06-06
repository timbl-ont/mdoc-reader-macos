// DOM Element References
const btnScan = document.getElementById('btn-scan');
const btnStop = document.getElementById('btn-stop');
const btnSimulate = document.getElementById('btn-simulate');
const btnClearConsole = document.getElementById('btn-clear-console');

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const statusDesc = document.getElementById('status-desc');

const viewPlaceholder = document.getElementById('view-placeholder');
const viewProfile = document.getElementById('view-profile');
const consoleOutput = document.getElementById('console-output');

// Card Elements
const mdlPhoto = document.getElementById('mdl-photo');
const mdlLastName = document.getElementById('mdl-lastname');
const mdlFirstName = document.getElementById('mdl-firstname');
const mdlDocNum = document.getElementById('mdl-docnum');
const mdlDob = document.getElementById('mdl-dob');
const mdlIssue = document.getElementById('mdl-issue');
const mdlExpiry = document.getElementById('mdl-expiry');
const mdlAuthority = document.getElementById('mdl-authority');

const privilegesBox = document.getElementById('mdl-privileges-box');
const privilegesList = document.getElementById('mdl-privileges-list');
const verificationList = document.getElementById('verification-list');

// Active State
let isListening = false;

// 1. Control Button Event Listeners
btnScan.addEventListener('click', async () => {
  if (isListening) return;
  isListening = true;
  
  btnScan.disabled = true;
  btnStop.disabled = false;
  btnSimulate.disabled = true;

  appendLog('[System] Starting NFC and BLE reader interfaces...', 'system');
  try {
    await window.api.startListening();
  } catch (err) {
    appendLog(`[System Error] Failed to start: ${err.message}`, 'error');
    resetButtons();
  }
});

btnStop.addEventListener('click', async () => {
  if (!isListening) return;
  isListening = false;
  
  btnScan.disabled = false;
  btnStop.disabled = true;
  btnSimulate.disabled = false;

  appendLog('[System] Stopping reader interfaces...', 'system');
  try {
    await window.api.stopListening();
  } catch (err) {
    appendLog(`[System Error] Stop error: ${err.message}`, 'error');
  }
});

btnSimulate.addEventListener('click', async () => {
  appendLog('[System] Initiating Hardware Simulator Mode...', 'system');
  
  // Temporarily disable actions during simulation
  btnScan.disabled = true;
  btnStop.disabled = true;
  btnSimulate.disabled = true;

  try {
    await window.api.runSimulator();
  } catch (err) {
    appendLog(`[System Error] Simulator failed: ${err.message}`, 'error');
    resetButtons();
  }
});

btnClearConsole.addEventListener('click', () => {
  consoleOutput.innerHTML = '';
});

function resetButtons() {
  isListening = false;
  btnScan.disabled = false;
  btnStop.disabled = true;
  btnSimulate.disabled = false;
}

// 2. Log Stream Receiver
window.api.onConsoleLog((text) => {
  let category = 'system';
  const upper = text.toUpperCase();

  if (upper.includes('APDU') || upper.includes('SENDING') || upper.includes('RESPONSE FOR')) {
    category = 'apdu';
  } else if (upper.includes('BLE') || upper.includes('GATT') || upper.includes('PERIPHERAL') || upper.includes('MTU') || upper.includes('SKREADER') || upper.includes('SKDEVICE')) {
    category = 'ble';
  } else if (upper.includes('ERROR') || upper.includes('FAILED')) {
    category = 'error';
  } else if (upper.includes('SUCCESS') || upper.includes('VERIFIED') || upper.includes('PASSED')) {
    category = 'success';
  }

  appendLog(text, category);
});

function appendLog(text, category) {
  const line = document.createElement('div');
  line.className = `log-line ${category}`;
  
  // Format timestamps
  const now = new Date();
  const timeStr = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}.${now.getMilliseconds().toString().padStart(3, '0')}`;
  
  line.innerText = `[${timeStr}] ${text}`;
  consoleOutput.appendChild(line);

  // Auto scroll
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

// 3. Status Change Handler
window.api.onStatusUpdate(({ state, message }) => {
  statusText.innerText = state.replace(/_/g, ' ');
  statusDesc.innerText = message;

  // Reset status indicator classes
  statusDot.className = 'status-dot';

  // Apply state-specific classes
  switch (state) {
    case 'IDLE':
      statusDot.classList.add('state-idle');
      resetButtons();
      break;
    case 'NFC_WAITING':
    case 'NFC_READING':
      statusDot.classList.add('state-listening');
      break;
    case 'BLE_SCANNING':
    case 'BLE_CONNECTING':
      statusDot.classList.add('state-ble-active');
      break;
    case 'BLE_TRANSFERRING':
      statusDot.classList.add('state-transferring');
      break;
    case 'VERIFYING':
      statusDot.classList.add('state-verifying');
      break;
    case 'SUCCESS':
      statusDot.classList.add('state-success');
      resetButtons();
      break;
    case 'ERROR':
      statusDot.classList.add('state-error');
      resetButtons();
      break;
  }
});

// 4. Decoded Card Profile Handler
window.api.onProfileDecoded((profile) => {
  // Update view panel visibility
  viewPlaceholder.classList.remove('active');
  viewProfile.classList.add('active');

  // Fill in card fields
  mdlLastName.innerText = profile.familyName;
  mdlFirstName.innerText = profile.givenName;
  mdlDocNum.innerText = profile.documentNumber;
  mdlDob.innerText = profile.birthDate;
  mdlIssue.innerText = profile.issueDate;
  mdlExpiry.innerText = profile.expiryDate;
  mdlAuthority.innerText = profile.issuingAuthority;

  // Update verification status badge
  const statusBadge = document.getElementById('verification-status-badge');
  const badgeText = statusBadge.querySelector('.badge-text');
  
  if (profile.verification && profile.verification.length > 0) {
    const hasFailedChecks = profile.verification.some(check => check.status === 'FAILED');
    if (hasFailedChecks) {
      statusBadge.className = 'verification-status-badge warning';
      badgeText.innerText = 'VERIFICATION WARNING';
    } else {
      statusBadge.className = 'verification-status-badge verified';
      badgeText.innerText = 'VERIFIED';
    }
  } else {
    statusBadge.className = 'verification-status-badge unverified';
    badgeText.innerText = 'UNVERIFIED';
  }

  // Set Portrait photo
  if (profile.photo) {
    mdlPhoto.src = profile.photo;
    mdlPhoto.style.display = 'block';
  } else {
    mdlPhoto.style.display = 'none';
  }

  // Populate driving privileges
  privilegesList.innerHTML = '';
  if (profile.drivingPrivileges && profile.drivingPrivileges.length > 0) {
    privilegesBox.classList.add('active');
    
    profile.drivingPrivileges.forEach(priv => {
      const badge = document.createElement('div');
      badge.className = 'privilege-badge';
      
      const code = document.createElement('span');
      code.className = 'code';
      code.innerText = priv.vehicleCode;
      
      const dates = document.createElement('span');
      dates.className = 'dates';
      dates.innerText = `${priv.issueDate} / ${priv.expiryDate}`;
      
      badge.appendChild(code);
      badge.appendChild(dates);
      privilegesList.appendChild(badge);
    });
  } else {
    privilegesBox.classList.remove('active');
  }

  // Populate Cryptographic Verification Audit log
  verificationList.innerHTML = '';
  if (profile.verification && profile.verification.length > 0) {
    profile.verification.forEach(check => {
      const item = document.createElement('li');
      const passed = check.status === 'PASSED';
      item.className = `verification-item ${passed ? 'passed' : 'failed'}`;

      const name = document.createElement('span');
      name.className = 'check-name';
      name.innerText = check.check;

      const status = document.createElement('span');
      status.className = 'check-status';
      status.innerText = check.status;

      item.appendChild(name);
      item.appendChild(status);
      verificationList.appendChild(item);
    });
  }
});
