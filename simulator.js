const crypto = require('crypto');

// A high-quality mock base64 JPEG portrait for a premium card visual
const MOCK_PORTRAIT_BASE64 = 
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAHgAoABREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

class HardwareSimulator {
  constructor(logger, onStatusChange, onDataReceived) {
    this.logger = logger || console.log;
    this.onStatusChange = onStatusChange || (() => {});
    this.onDataReceived = onDataReceived || (() => {});
    this.isRunning = false;
  }

  async runDemo() {
    if (this.isRunning) return;
    this.isRunning = true;

    this.onStatusChange('NFC_WAITING', 'Waiting for mDL device tap...');
    await this.delay(1500);

    // NFC Tap detected
    this.onStatusChange('NFC_READING', 'Device detected! Selecting NDEF Application...');
    this.logger('NFC Card/Device detected.');
    
    // Simulate NDEF Selection
    await this.delay(800);
    this.logger('Sending Select NDEF Tag App: 00A4040007D2760000850101');
    this.logger('Response: 9000');
    
    await this.delay(400);
    this.logger('Sending Select CC File: 00A4000C02E103');
    this.logger('Response: 9000');
    
    await this.delay(400);
    this.logger('Sending Read CC File: 00B000000F');
    this.logger('Response: 000F2000FF00FF0406E104040000009000');
    this.logger('Found NDEF File ID in CC: E104');
    
    await this.delay(400);
    this.logger('Sending Select NDEF File: 00A4000C02E104');
    this.logger('Response: 9000');
    
    await this.delay(250);
    this.logger('Waiting 250ms for HCE NDEF data preparation...');
    this.logger('Sending Read NLEN: 00B0000002');
    this.logger('Response: 001F9000');
    this.logger('NDEF Message Length: 31 bytes');
    this.logger('Sending Read NDEF Chunk offset 2: 00B000021F');
    this.logger('Response: D1021A5470101375726E3A6E66633A736E3A68616E646F76657200000FFFFF9000');
    this.logger('Parsed NDEF Record: type=Tp, tnf=1, payload=101375726E3A6E66633A736E3A68616E646F76657200000FFFFF');
    this.logger('TNEP Service Parameter ("Tp") for service "urn:nfc:sn:handover" detected.');

    // Simulate Ts Service Select Write
    await this.delay(600);
    this.logger('Writing NDEF message (25 bytes)...');
    this.logger('Sending Disable NDEF parser (NLEN=0000): 00D60000020000');
    this.logger('Response for Disable NDEF parser (NLEN=0000): 9000');
    this.logger('Sending Write NDEF payload chunk offset 2 (length 25): 00D6000219D1021454731375726E3A6E66633A736E3A68616E646F766572');
    this.logger('Response for Write NDEF payload chunk offset 2 (length 25): 9000');
    this.logger('Sending Enable NDEF parser (NLEN=25): 00D60000020019');
    this.logger('Response for Enable NDEF parser (NLEN=25): 9000');
    
    // Simulate Te Status Read
    await this.delay(500);
    this.logger('Reading TNEP Status (Te)...');
    this.logger('Sending Read NLEN: 00B0000002');
    this.logger('Response for Read NLEN: 00069000');
    this.logger('NDEF Message Length: 6 bytes');
    this.logger('Sending Read NDEF Chunk offset 2: 00B0000206');
    this.logger('Response for Read NDEF Chunk offset 2: D102015465009000');
    this.logger('TNEP Status (Te) value: 0');

    // Simulate Hr Handover Request Write
    await this.delay(600);
    this.logger('Constructing and writing Handover Request (Hr) NDEF message...');
    this.logger('Writing NDEF message (89 bytes)...');
    this.logger('Sending Disable NDEF parser (NLEN=0000): 00D60000020000');
    this.logger('Response for Disable NDEF parser (NLEN=0000): 9000');
    this.logger('Sending Write NDEF payload chunk offset 2 (length 89): 00D6000259910211487215910202637201025102046163010130005A201E016170706C69636174696F6E2F766E642E626C7565746F6F74682E6C652E6F6F6230081B00000000000000021C011107E6733397764C6B89CE4823A101000000');
    this.logger('Response for Write NDEF payload chunk offset 2 (length 89): 9000');
    this.logger('Sending Enable NDEF parser (NLEN=89): 00D60000020059');
    this.logger('Response for Enable NDEF parser (NLEN=89): 9000');

    // Simulate Hs Handover Select Read
    await this.delay(500);
    this.logger('Reading Handover Select (Hs) NDEF message...');
    this.logger('Sending Read NLEN: 00B0000002');
    this.logger('Response for Read NLEN: 009F9000');
    this.logger('NDEF Message Length: 159 bytes');
    this.logger('Sending Read NDEF Chunk offset 2: 00B000029F');
    const mockServiceUuid = '00000001-A123-48CE-896B-4C76973373E6';
    this.logger('Response for Read NDEF Chunk offset 2: D1019F589A...9000');
    this.logger('Successfully retrieved DeviceEngagement via TNEP negotiated handover.');
    this.logger(`Extracted BLE Service UUID: ${mockServiceUuid}`);

    // Transition to BLE Scanning
    await this.delay(1200);
    this.onStatusChange('BLE_SCANNING', `Scanning for BLE Service: ${mockServiceUuid}...`);
    this.logger(`BLE Central Mode: Scanning for peripheral advertising service ${mockServiceUuid}`);

    await this.delay(2000);
    const mockDeviceId = 'E3:F4:A8:12:09:BC';
    this.logger(`BLE Device Discovered: "iPhone 15 Pro - Wallet" (ID: ${mockDeviceId}, RSSI: -58dBm)`);
    this.onStatusChange('BLE_CONNECTING', `Connecting to device ${mockDeviceId}...`);
    
    await this.delay(1200);
    this.logger('BLE connected successfully. Negotiating MTU...');
    this.logger('BLE MTU size negotiated: 512 bytes.');
    
    await this.delay(800);
    this.onStatusChange('BLE_CONNECTING', 'Discovering GATT characteristics...');
    this.logger('Discovering GATT Service and Characteristics...');
    this.logger(`Discovered Characteristics:
  - State [Notify, Write]: ${STATE_UUID}
  - Client2Server [Write No Response]: ${CLIENT2SERVER_UUID}
  - Server2Client [Notify]: ${SERVER2CLIENT_UUID}`);

    await this.delay(1000);
    this.onStatusChange('BLE_CONNECTING', 'Subscribing to GATT notifications...');
    this.logger('Subscribed to Server2Client notifications successfully.');
    this.logger('Sending START command (0x01) to State characteristic...');

    // Ephemeral key generation log
    await this.delay(600);
    this.logger('Generated Ephemeral Reader Key Pair (P-256)');
    this.logger('Session Transcript constructed.');
    this.logger('ECDH Shared Secret computed successfully.');
    this.logger('Derived SKReader: F3A18C52B9DE4019...');
    this.logger('Derived SKDevice: C40E8A837F82A1B8...');

    // Sending request
    await this.delay(800);
    this.onStatusChange('BLE_TRANSFERRING', 'Encrypting and sending request payload...');
    this.logger('Constructing Device Request for mDL attributes...');
    this.logger('Plaintext DeviceRequest CBOR length: 112 bytes');
    this.logger('Encrypted request ciphertext length: 128 bytes');
    this.logger('Writing request fragment #1 (size: 129 bytes, flag: 0)...');
    
    // Waiting for response
    await this.delay(1500);
    this.onStatusChange('BLE_TRANSFERRING', 'Waiting for encrypted response packets...');
    
    // Simulate receiving fragments
    this.logger('Received response fragment #1 (size: 240 bytes, flag: 1)');
    await this.delay(400);
    this.logger('Received response fragment #2 (size: 240 bytes, flag: 1)');
    await this.delay(400);
    this.logger('Received response fragment #3 (size: 184 bytes, flag: 0)');
    this.logger('Response reassembly complete. Total size: 664 bytes.');

    // Cryptographic verification logs
    await this.delay(800);
    this.onStatusChange('VERIFYING', 'Decrypting and verifying signatures...');
    this.logger('Decrypting response payload...');
    this.logger('Decoded DeviceResponse (version: 1.0)');
    this.logger('Verifying signatures & crypto integrity...');

    const checks = [
      { check: 'Device Response must include "version" element.', status: 'PASSED', category: 'DOCUMENT_FORMAT' },
      { check: 'Device Response must not include documents or at least one document.', status: 'PASSED', category: 'DOCUMENT_FORMAT' },
      { check: 'Verify Device Authentication signature against ephemeral reader key.', status: 'PASSED', category: 'CRYPTO' },
      { check: 'Verify MSO Signature against trusted certificate.', status: 'PASSED', category: 'CRYPTO' },
      { check: 'Verify document integrity hashes in ValueDigests.', status: 'PASSED', category: 'CRYPTO' }
    ];

    for (const check of checks) {
      await this.delay(400);
      this.logger(`[Verification] ${check.check}: ${check.status}`);
    }

    // Success and Data Parsing
    await this.delay(800);
    this.logger('Sending END command (0x02) to State characteristic...');
    this.logger('Disconnecting BLE peripheral...');
    this.logger('BLE Peripheral disconnected.');

    // Compile mock profile data
    const mockProfile = {
      docType: 'org.iso.18013.5.1.mDL',
      familyName: 'SMITH',
      givenName: 'JANE ELEANOR',
      birthDate: '1990-04-12',
      issueDate: '2022-06-15',
      expiryDate: '2028-06-15',
      issuingAuthority: 'STATE OF CALIFORNIA DMV',
      documentNumber: 'DL-98234812',
      drivingPrivileges: [
        { vehicleCode: 'C', issueDate: '2008-05-20', expiryDate: '2028-06-15' }
      ],
      photo: MOCK_PORTRAIT_BASE64,
      verification: checks
    };

    this.onStatusChange('SUCCESS', 'mDL Verified Successfully!');
    this.onDataReceived(mockProfile);
    this.isRunning = false;
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export same UUID constants for consistency
const STATE_UUID = '00000001-a123-48ce-896b-4c76973373e6';
const CLIENT2SERVER_UUID = '00000002-a123-48ce-896b-4c76973373e6';
const SERVER2CLIENT_UUID = '00000003-a123-48ce-896b-4c76973373e6';

module.exports = HardwareSimulator;
