const pcsclite = require('@pokusew/pcsclite');
const crypto = require('crypto');


class NFCHandler {
  constructor(logger, onDeviceEngagement) {
    this.logger = logger || console.log;
    this.onDeviceEngagement = onDeviceEngagement;
    this.pcsc = null;
    this.activeReader = null;
    
    // Status tracking for direct ISO 18013-5 selection vs NDEF handover
    this.isDirectMdlEngagement = false;
    this.directMdlEngagementBytes = null;
    this.lastNdefMessage = null;
  }

  start() {
    this.logger('Initializing PC/SC NFC Daemon...');
    try {
      this.pcsc = pcsclite();
    } catch (err) {
      this.logger(`Failed to initialize pcsclite: ${err.message}. Ensure pcscd is running.`);
      return;
    }

    this.pcsc.on('reader', (reader) => {
      this.logger(`NFC Reader detected: ${reader.name}`);
      this.activeReader = reader;

      let cardPresent = false;

      reader.on('status', (status) => {
        const changes = reader.state ^ status.state;
        if (changes) {
          // Check if card is present now
          if ((changes & reader.SCARD_STATE_PRESENT) && (status.state & reader.SCARD_STATE_PRESENT)) {
            if (!cardPresent) {
              cardPresent = true;
              this.logger(`Card/Device tapped on NFC reader.`);
              this.handleCardTap(reader);
            }
          } 
          // Check if card is empty now
          else if ((changes & reader.SCARD_STATE_EMPTY) && (status.state & reader.SCARD_STATE_EMPTY)) {
            if (cardPresent) {
              cardPresent = false;
              this.logger('NFC Card/Device removed.');
            }
          }
        }
      });

      reader.on('error', (err) => {
        this.logger(`NFC Reader error: ${err.message}`);
      });

      reader.on('end', () => {
        this.logger(`NFC Reader disconnected: ${reader.name}`);
        if (this.activeReader === reader) {
          this.activeReader = null;
        }
      });
    });

    this.pcsc.on('error', (err) => {
      this.logger(`PC/SC Error: ${err.message}`);
    });
  }

  stop() {
    if (this.pcsc) {
      this.logger('Stopping PC/SC NFC Daemon...');
      this.pcsc.close();
      this.pcsc = null;
      this.activeReader = null;
    }
  }

  handleCardTap(reader) {
    // Connect with EXCLUSIVE mode to prevent com.apple.ifdreader sharing conflicts
    reader.connect({ share_mode: reader.SCARD_SHARE_EXCLUSIVE }, (err, protocol) => {
      if (err) {
        this.logger(`NFC connection error: ${err.message}. Retrying with SHARED mode...`);
        // Fallback to SHARED if EXCLUSIVE fails
        reader.connect({ share_mode: reader.SCARD_SHARE_SHARED }, (err2, protocol2) => {
          if (err2) {
            this.logger(`NFC fallback connection failed: ${err2.message}`);
            return;
          }
          this.executeHandoverFlow(reader, protocol2);
        });
        return;
      }
      this.executeHandoverFlow(reader, protocol);
    });
  }

  executeHandoverFlow(reader, protocol) {
    this.logger(`NFC connected. Protocol: ${protocol}`);

    this.isDirectMdlEngagement = false;
    this.directMdlEngagementBytes = null;
    this.lastNdefMessage = null;
    this.lastHrMessage = null;
    this.bleServiceUuid = crypto.randomUUID();

    // Introduce 10ms delay to allow phone HCE binding to stabilize
    this.logger('Waiting 10ms for card channel stabilization...');
    setTimeout(() => {
      this.readNDEFData(reader, protocol)
        .then(async (dataBuffer) => {
          if (this.isDirectMdlEngagement) {
            this.lastNdefMessage = null;
            this.lastHrMessage = null;
            this.logger('Successfully retrieved Device Engagement via direct mDL AID selection.');
            if (this.onDeviceEngagement) {
              this.onDeviceEngagement(dataBuffer, null, null);
            }
          } else {
            this.lastNdefMessage = dataBuffer;
            this.logger(`Successfully read NDEF message (${dataBuffer.length} bytes).`);
            await this.parseNDEFDeviceEngagement(dataBuffer, reader, protocol);
          }
        })
        .catch((err) => {
          this.logger(`NFC Reading failed: ${err.message}`);
        })
        .finally(() => {
          reader.disconnect(reader.SCARD_LEAVE_CARD, (err) => {
            if (err) {
              this.logger(`NFC disconnect error: ${err.message}`);
            } else {
              this.logger('NFC disconnected successfully.');
            }
          });
        });
    }, 10);
  }

  async transmitAPDU(reader, protocol, apduBytes, desc = 'APDU') {
    const apdu = Buffer.from(apduBytes);
    this.logger(`Sending ${desc}: ${apdu.toString('hex').toUpperCase()}`);

    return new Promise((resolve, reject) => {
      // Expecting up to 258 bytes in response (256 data bytes + 2 status bytes)
      reader.transmit(apdu, 258, protocol, (err, response) => {
        if (err) {
          return reject(err);
        }

        const hexResponse = response.toString('hex').toUpperCase();
        this.logger(`Response for ${desc}: ${hexResponse}`);

        if (response.length < 2) {
          return reject(new Error('Invalid response length (no status bytes)'));
        }

        const sw1 = response[response.length - 2];
        const sw2 = response[response.length - 1];

        if (sw1 !== 0x90 || sw2 !== 0x00) {
          return reject(new Error(`APDU returned error status: ${sw1.toString(16).padStart(2, '0')}${sw2.toString(16).padStart(2, '0')}`));
        }

        // Return only the payload data, excluding the 2 status bytes
        resolve(response.subarray(0, response.length - 2));
      });
    });
  }

  async readNDEFData(reader, protocol) {
    this.isDirectMdlEngagement = false;
    this.directMdlEngagementBytes = null;
    this.lastNdefMessage = null;
    this.lastHrMessage = null;
    this.ndefFileId = Buffer.from([0xE1, 0x04]); // Default fallback NDEF file ID

    this.logger('Attempting NDEF Tag App selection...');
    try {
      // 1. Select NDEF Tag Application
      // AID: D2 76 00 00 85 01 01
      await this.transmitAPDU(
        reader,
        protocol,
        [0x00, 0xA4, 0x04, 0x00, 0x07, 0xD2, 0x76, 0x00, 0x00, 0x85, 0x01, 0x01],
        'Select NDEF Tag App'
      );

      // 2. Select Capability Container (CC) File
      // File ID: E1 03
      await this.transmitAPDU(
        reader,
        protocol,
        [0x00, 0xA4, 0x00, 0x0C, 0x02, 0xE1, 0x03],
        'Select CC File'
      );

      // 3. Read CC File to find NDEF File ID
      const ccData = await this.transmitAPDU(
        reader,
        protocol,
        [0x00, 0xB0, 0x00, 0x00, 0x0F],
        'Read CC File'
      );

      if (ccData && ccData.length >= 7) {
        // Parse CC file for NDEF File Control TLV (Tag 04)
        let offset = 7; // Bytes 0-2: CC length, Mapping Version, Max Read, Max Write
        while (offset < ccData.length - 2) {
          const tag = ccData[offset];
          const len = ccData[offset + 1];
          if (tag === 0x04 && len >= 6) {
            this.ndefFileId = ccData.subarray(offset + 2, offset + 4);
            this.logger(`Found NDEF File ID in CC: ${this.ndefFileId.toString('hex').toUpperCase()}`);
            break;
          }
          offset += 2 + len;
        }
      }

      // Read NDEF message
      const ndefMessage = await this.readNDEFMessage(reader, protocol, this.ndefFileId);
      return ndefMessage;

    } catch (err) {
      this.logger(`NDEF selection failed: ${err.message}. Falling back to direct mDL AID selection...`);
    }

    // --- FALLBACK TO DIRECT MDL AID SELECTION ---
    this.logger('Attempting direct mDL AID selection (ISO 18013-5)...');
    // 1. Select mDL Application
    // AID: A0 00 00 02 48 04 00
    await this.transmitAPDU(
      reader,
      protocol,
      [0x00, 0xA4, 0x04, 0x00, 0x07, 0xA0, 0x00, 0x00, 0x02, 0x48, 0x04, 0x00],
      'Select mDL App'
    );

    // 2. Get DeviceEngagement data
    // Command: 00 CA 01 00 00
    const deData = await this.transmitAPDU(
      reader,
      protocol,
      [0x00, 0xCA, 0x01, 0x00, 0x00],
      'Get DeviceEngagement'
    );

    this.logger(`Direct mDL selection successful. DeviceEngagement length: ${deData.length} bytes`);
    this.isDirectMdlEngagement = true;
    this.directMdlEngagementBytes = deData;
    return deData;
  }

  async readNDEFMessage(reader, protocol, ndefFileId, skipSelect = false) {
    if (!skipSelect) {
      // Select NDEF File
      await this.transmitAPDU(
        reader,
        protocol,
        [0x00, 0xA4, 0x00, 0x0C, 0x02, ndefFileId[0], ndefFileId[1]],
        'Select NDEF File'
      );

      // Wait 10ms for the phone's HCE service to prepare/serialize the NDEF data (e.g. key generation)
      this.logger('Waiting 10ms for HCE NDEF data preparation...');
      await this.delay(10);
    }

    // Read NLEN (first 2 bytes of NDEF File)
    const nlenBuffer = await this.transmitAPDU(
      reader,
      protocol,
      [0x00, 0xB0, 0x00, 0x00, 0x02],
      'Read NLEN'
    );

    if (nlenBuffer.length < 2) {
      throw new Error(`Invalid NLEN: expected 2 bytes, got ${nlenBuffer.length}`);
    }

    const ndefLength = (nlenBuffer[0] << 8) | nlenBuffer[1];
    this.logger(`NDEF Message Length: ${ndefLength} bytes`);

    if (ndefLength === 0) {
      return Buffer.alloc(0);
    }

    // Read NDEF message bytes in chunks (maximum read block of 240 bytes)
    const chunkSize = 240;
    let accumulated = Buffer.alloc(0);
    let offset = 2; // Skip first 2 bytes containing NLEN

    while (accumulated.length < ndefLength) {
      const remaining = ndefLength - accumulated.length;
      const readLen = Math.min(chunkSize, remaining);
      const offsetHigh = (offset >> 8) & 0xFF;
      const offsetLow = offset & 0xFF;

      const chunk = await this.transmitAPDU(
        reader,
        protocol,
        [0x00, 0xB0, offsetHigh, offsetLow, readLen],
        `Read NDEF Chunk offset ${offset}`
      );

      accumulated = Buffer.concat([accumulated, chunk]);
      offset += chunk.length;
    }

    this.lastNdefMessage = accumulated;
    return accumulated;
  }

  async writeNDEFData(reader, protocol, ndefBytes, ndefFileId, skipSelect = false) {
    this.logger(`Writing NDEF message (${ndefBytes.length} bytes)...`);

    // 1. Select NDEF File (skip if persistent select is requested to avoid resetting TNEP state)
    if (!skipSelect) {
      await this.transmitAPDU(
        reader,
        protocol,
        [0x00, 0xA4, 0x00, 0x0C, 0x02, ndefFileId[0], ndefFileId[1]],
        'Select NDEF File for writing'
      );
    }

    // 2. Step 1: Write NLEN = 0000 to disable NDEF parser
    await this.transmitAPDU(
      reader,
      protocol,
      [0x00, 0xD6, 0x00, 0x00, 0x02, 0x00, 0x00],
      'Disable NDEF parser (NLEN=0000)'
    );

    // 3. Step 2: Write NDEF payload starting at offset 0x0002.
    // Write in chunks of up to 240 bytes
    const chunkSize = 240;
    let offset = 2; // Offset in NDEF file
    let bytesWritten = 0;
    while (bytesWritten < ndefBytes.length) {
      const chunkLen = Math.min(chunkSize, ndefBytes.length - bytesWritten);
      const chunk = ndefBytes.subarray(bytesWritten, bytesWritten + chunkLen);
      const offsetHigh = (offset >> 8) & 0xFF;
      const offsetLow = offset & 0xFF;

      const payloadApdu = Buffer.concat([
        Buffer.from([0x00, 0xD6, offsetHigh, offsetLow, chunkLen]),
        chunk
      ]);

      await this.transmitAPDU(
        reader,
        protocol,
        payloadApdu,
        `Write NDEF payload chunk offset ${offset} (length ${chunkLen})`
      );
      offset += chunkLen;
      bytesWritten += chunkLen;
    }

    // 4. Step 3: Write NLEN = actual length to enable parser and trigger HCE state machine
    const lenHigh = (ndefBytes.length >> 8) & 0xFF;
    const lenLow = ndefBytes.length & 0xFF;
    await this.transmitAPDU(
      reader,
      protocol,
      [0x00, 0xD6, 0x00, 0x00, 0x02, lenHigh, lenLow],
      `Enable NDEF parser (NLEN=${ndefBytes.length})`
    );
  }

  uuidToLittleEndianBuffer(uuidStr) {
    const hex = uuidStr.replace(/-/g, '');
    if (hex.length !== 32) {
      throw new Error(`Invalid UUID length: ${uuidStr}`);
    }
    const buf = Buffer.from(hex, 'hex');
    return buf.reverse();
  }

  buildHandoverRequest(uuidStr) {
    const version = 0x15; // CH 1.5
    
    // cr record (Collision Resolution)
    const crPayload = Buffer.from([0x01, 0x02]);
    const crRecord = Buffer.concat([
      Buffer.from([0x91, 0x02, crPayload.length]), // Header (MB=1, ME=0, SR=1, TNF=1), Type Length, Payload Length
      Buffer.from('cr', 'ascii'),
      crPayload
    ]);

    // ac record (Alternative Carrier)
    const acPayload = Buffer.from([0x01, 0x01, 0x30, 0x00]); // CPS=Active, Ref Len=1, Ref='0', Aux Ref Count=0
    const acRecord = Buffer.concat([
      Buffer.from([0x51, 0x02, acPayload.length]), // Header (MB=0, ME=1, SR=1, TNF=1), Type Length, Payload Length
      Buffer.from('ac', 'ascii'),
      acPayload
    ]);

    // Nested NDEF message payload for Hr
    const nestedMessage = Buffer.concat([crRecord, acRecord]);
    const hrPayload = Buffer.concat([
      Buffer.from([version]),
      nestedMessage
    ]);

    // Hr Record
    const hrRecord = Buffer.concat([
      Buffer.from([0x91, 0x02, hrPayload.length]), // Header (MB=1, ME=0, SR=1, TNF=1), Type Length, Payload Length
      Buffer.from('Hr', 'ascii'),
      hrPayload
    ]);

    // BLE Carrier Configuration Record
    const bleType = 'application/vnd.bluetooth.le.oob';
    
    const uuidBytes = this.uuidToLittleEndianBuffer(uuidStr);
    
    // AD Type 0x07 (Complete List of 128-bit Service Class UUIDs)
    // Length: 17 bytes (1 byte AD Type + 16 bytes UUID)
    const uuidAdStructure = Buffer.concat([
      Buffer.from([0x11, 0x07]),
      uuidBytes
    ]);

    const blePayload = Buffer.concat([
      Buffer.from([
        0x08, 0x1B, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // 0x1B (Address): len 8, type 0x1B, public type 0x00, address 00:00:00:00:00:00
        0x02, 0x1C, 0x01                                      // 0x1C (Role): len 2, type 0x1C, central role 0x01
      ]),
      uuidAdStructure
    ]);

    const bleRecord = Buffer.concat([
      Buffer.from([0x5A, bleType.length, blePayload.length, 1]), // Header (MB=0, ME=1, SR=1, IL=1, TNF=2), Type Length, Payload Length, ID Length
      Buffer.from(bleType, 'ascii'),
      Buffer.from('0', 'ascii'),
      blePayload
    ]);

    return Buffer.concat([hrRecord, bleRecord]);
  }

  parseNDEF(ndefBuffer) {
    const records = [];
    let offset = 0;
    while (offset < ndefBuffer.length) {
      if (offset + 2 > ndefBuffer.length) break;
      const header = ndefBuffer[offset];
      const tnf = header & 0x07;
      const sr = (header & 0x10) !== 0;
      const il = (header & 0x08) !== 0;

      const typeLength = ndefBuffer[offset + 1];
      
      let payloadLength = 0;
      let bytesRead = 2;

      if (sr) {
        if (offset + bytesRead + 1 > ndefBuffer.length) break;
        payloadLength = ndefBuffer[offset + bytesRead];
        bytesRead += 1;
      } else {
        if (offset + bytesRead + 4 > ndefBuffer.length) break;
        payloadLength = (ndefBuffer[offset + bytesRead] << 24) |
                        (ndefBuffer[offset + bytesRead + 1] << 16) |
                        (ndefBuffer[offset + bytesRead + 2] << 8) |
                        ndefBuffer[offset + bytesRead + 3];
        bytesRead += 4;
      }

      let idLength = 0;
      if (il) {
        if (offset + bytesRead + 1 > ndefBuffer.length) break;
        idLength = ndefBuffer[offset + bytesRead];
        bytesRead += 1;
      }

      if (offset + bytesRead + typeLength + idLength + payloadLength > ndefBuffer.length) break;

      const typeOffset = offset + bytesRead;
      const idOffset = typeOffset + typeLength;
      const payloadOffset = idOffset + idLength;

      const type = ndefBuffer.toString('utf8', typeOffset, typeOffset + typeLength);
      const id = idLength > 0 ? ndefBuffer.toString('utf8', idOffset, idOffset + idLength) : '';
      const payload = ndefBuffer.subarray(payloadOffset, payloadOffset + payloadLength);

      records.push({ tnf, type, id, payload, header });

      offset = payloadOffset + payloadLength;
    }
    return records;
  }

  async parseNDEFDeviceEngagement(ndefBuffer, reader, protocol) {
    try {
      this.logger('Parsing NDEF Message records...');
      const records = this.parseNDEF(ndefBuffer);

      for (const rec of records) {
        this.logger(`NDEF Record Type: ${rec.type}, TNF: ${rec.tnf}, Payload Length: ${rec.payload.length}`);
        this.logger(`NDEF Record Payload (Hex): ${rec.payload.toString('hex').toUpperCase()}`);
        this.logger(`NDEF Record Payload (UTF8): ${rec.payload.toString('utf8').replace(/[\x00-\x1F]/g, '.')}`);
      }

      // Check for TNEP Service Parameter Record (Tp) with service "urn:nfc:sn:handover"
      const tpRecord = records.find(r => r.type === 'Tp');
      if (tpRecord && tpRecord.payload.length > 2) {
        const uriLen = tpRecord.payload[1];
        const uri = tpRecord.payload.toString('utf8', 2, 2 + uriLen);

        if (uri === 'urn:nfc:sn:handover') {
          this.logger('TNEP Negotiated Handover service detected ("urn:nfc:sn:handover"). Initiating TNEP flow...');

          // 1. Construct Service Select (Ts) NDEF Message
          const tsPayload = Buffer.concat([
            Buffer.from([0x13]), // URI Length (19)
            Buffer.from('urn:nfc:sn:handover', 'ascii')
          ]);
          const tsRecord = Buffer.concat([
            Buffer.from([0xD1, 0x02, tsPayload.length]), // MB=1, ME=1, SR=1, TNF=1
            Buffer.from('Ts', 'ascii'),
            tsPayload
          ]);

          // 2. Write Ts NDEF message (skip select to maintain persistent TNEP HCE state)
          await this.writeNDEFData(reader, protocol, tsRecord, this.ndefFileId, true);

          // 3. Wait brief moment and read Te status record
          // Wait 50ms and skip Select NDEF File command to prevent phone's HCE stack from resetting the written data
          await this.delay(50);
          this.logger('Reading TNEP Status (Te)...');
          const teNdef = await this.readNDEFMessage(reader, protocol, this.ndefFileId, true);
          const teRecords = this.parseNDEF(teNdef);
          const teRecord = teRecords.find(r => r.type === 'Te');

          if (!teRecord || teRecord.payload.length < 1) {
            throw new Error('TNEP Status (Te) record not found or invalid.');
          }

          const statusVal = teRecord.payload[0];
          this.logger(`TNEP Status (Te) value: ${statusVal}`);
          if (statusVal === 0x02) {
            throw new Error('TNEP Service Select returned protocol error (status 0x02).');
          }

          // 4. Construct and write Handover Request (Hr) NDEF Message
          this.logger('Constructing and writing Handover Request (Hr) NDEF message...');
          const hrMessage = this.buildHandoverRequest(this.bleServiceUuid);
          await this.writeNDEFData(reader, protocol, hrMessage, this.ndefFileId, true);

          // 5. Wait brief moment and read Handover Select (Hs) NDEF Message
          // Wait 50ms and skip Select NDEF File command to prevent phone's HCE stack from resetting the written data
          await this.delay(50);
          this.logger('Reading Handover Select (Hs) NDEF message...');
          const hsNdef = await this.readNDEFMessage(reader, protocol, this.ndefFileId, true);
          const hsRecords = this.parseNDEF(hsNdef);

          // 6. Find the auxiliary Device Engagement record inside the Hs message
          const deRecord = hsRecords.find(r => r.type === 'iso.org:18013:deviceengagement');
          if (!deRecord) {
            throw new Error('Handover Select (Hs) NDEF message did not contain a "iso.org:18013:deviceengagement" record.');
          }

          this.logger('Successfully retrieved DeviceEngagement via TNEP negotiated handover.');
          this.lastNdefMessage = hsNdef;
          this.lastHrMessage = hrMessage;

          if (this.onDeviceEngagement) {
            this.onDeviceEngagement(deRecord.payload, hsNdef, hrMessage);
          }
          return;
        }
      }

      // Check for Static Handover Device Engagement record
      const deRecord = records.find(r => r.type === 'iso.org:18013:deviceengagement');
      if (deRecord) {
        this.logger('Found DeviceEngagement in static NDEF message.');
        this.lastNdefMessage = ndefBuffer;
        this.lastHrMessage = null;
        if (this.onDeviceEngagement) {
          this.onDeviceEngagement(deRecord.payload, ndefBuffer, null);
        }
        return;
      }

      throw new Error('NDEF message does not contain mDL DeviceEngagement or TNEP negotiated handover.');
    } catch (err) {
      this.logger(`Error parsing NDEF: ${err.message}`);
      throw err;
    }
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = NFCHandler;
