const noble = require('@abandonware/noble');

const STATE_UUID = '00000001-a123-48ce-896b-4c76973373e6';
const CLIENT2SERVER_UUID = '00000002-a123-48ce-896b-4c76973373e6';
const SERVER2CLIENT_UUID = '00000003-a123-48ce-896b-4c76973373e6';

class BLEHandler {
  constructor(logger, onResponseReceived) {
    this.logger = logger || console.log;
    this.onResponseReceived = onResponseReceived;
    this.targetServiceUuid = null;
    
    this.discoveredPeripheral = null;
    this.stateChar = null;
    this.client2ServerChar = null;
    this.server2ClientChar = null;

    // Buffer to reassemble fragmented responses
    this.responseBuffer = Buffer.alloc(0);
    this.isTransferring = false;
    
    this.bindEvents();
  }

  bindEvents() {
    noble.on('stateChange', (state) => {
      this.logger(`BLE Adapter State changed to: ${state}`);
    });

    noble.on('discover', (peripheral) => {
      const serviceUuids = peripheral.advertisement.serviceUuids || [];
      this.logger(`Discovered BLE device: "${peripheral.advertisement.localName || 'Unknown'}" (ID: ${peripheral.id}, RSSI: ${peripheral.rssi}) Services: [${serviceUuids}]`);

      // Check if this peripheral advertises our target service UUID
      // Normalize UUIDs (remove hyphens, convert to lowercase)
      const targetNormal = this.targetServiceUuid.replace(/-/g, '').toLowerCase();
      const match = serviceUuids.some(uuid => uuid.replace(/-/g, '').toLowerCase() === targetNormal);

      if (match) {
        this.logger(`Found target mDL Peripheral: ${peripheral.id}`);
        this.discoveredPeripheral = peripheral;
        this.stopScanning();
        this.connectToDevice(peripheral);
      }
    });

    noble.on('scanStart', () => {
      this.logger('BLE Scan started.');
    });

    noble.on('scanStop', () => {
      this.logger('BLE Scan stopped.');
    });
  }

  /**
   * Starts scanning for a specific BLE Service UUID extracted from DeviceEngagement.
   * 
   * @param {String} serviceUuid 128-bit BLE Service UUID
   */
  startScanning(serviceUuid) {
    this.targetServiceUuid = serviceUuid;
    this.discoveredPeripheral = null;
    this.isTransferring = false;
    this.responseBuffer = Buffer.alloc(0);

    const normalUuid = serviceUuid.replace(/-/g, '').toLowerCase();
    this.logger(`Starting scan for BLE peripheral service: ${serviceUuid} (normalized: ${normalUuid})`);

    // Ensure adapter is powered on
    if (noble.state === 'poweredOn') {
      noble.startScanning([normalUuid], false);
    } else {
      this.logger('Warning: BLE adapter is not powered on. Waiting for powerOn state...');
      noble.once('stateChange', (state) => {
        if (state === 'poweredOn') {
          noble.startScanning([normalUuid], false);
        } else {
          this.logger(`Cannot scan, BLE adapter state is: ${state}`);
        }
      });
    }
  }

  stopScanning() {
    this.logger('Stopping BLE scan...');
    noble.stopScanning();
  }

  connectToDevice(peripheral) {
    this.logger(`Connecting to peripheral ${peripheral.id} (${peripheral.advertisement.localName || 'mDL device'})...`);

    peripheral.connect((err) => {
      if (err) {
        this.logger(`Connection error: ${err.message}`);
        return;
      }
      this.logger('Connected successfully to mDL device.');

      // Discover mDL service and characteristics
      const targetServiceNormal = this.targetServiceUuid.replace(/-/g, '').toLowerCase();
      
      const normalStateChar = STATE_UUID.replace(/-/g, '').toLowerCase();
      const normalC2SChar = CLIENT2SERVER_UUID.replace(/-/g, '').toLowerCase();
      const normalS2CChar = SERVER2CLIENT_UUID.replace(/-/g, '').toLowerCase();

      this.logger('Discovering GATT Service and Characteristics...');
      peripheral.discoverSomeServicesAndCharacteristics(
        [targetServiceNormal],
        [], // Discover all characteristics to avoid noble filtering issues
        (err, services, characteristics) => {
          if (err) {
            this.logger(`Discovery error: ${err.message}`);
            this.disconnect();
            return;
          }

          this.logger(`Discovered ${services.length} services and ${characteristics.length} characteristics.`);
          for (const char of characteristics) {
            this.logger(`- Discovered characteristic: UUID=${char.uuid}, properties=${char.properties}`);
          }

          // Map characteristics
          for (const char of characteristics) {
            const uuid = char.uuid.replace(/-/g, '').toLowerCase();
            if (uuid === normalStateChar) {
              this.stateChar = char;
            } else if (uuid === normalC2SChar) {
              this.client2ServerChar = char;
            } else if (uuid === normalS2CChar) {
              this.server2ClientChar = char;
            }
          }

          if (!this.stateChar || !this.client2ServerChar || !this.server2ClientChar) {
            this.logger('Error: Required GATT characteristics (State, Client2Server, Server2Client) were not fully discovered.');
            this.disconnect();
            return;
          }

          this.logger('GATT characteristics mapped successfully. Initializing data transfer...');
          this.setupTransfer(peripheral);
        }
      );
    });

    peripheral.on('disconnect', () => {
      this.logger('BLE Peripheral disconnected.');
      this.stateChar = null;
      this.client2ServerChar = null;
      this.server2ClientChar = null;
      this.discoveredPeripheral = null;
    });
  }

  setupTransfer(peripheral) {
    // 1. Subscribe to notifications on Server2Client
    this.logger('Subscribing to Server2Client notifications...');
    this.server2ClientChar.subscribe((err) => {
      if (err) {
        this.logger(`Subscribe error: ${err.message}`);
        this.disconnect();
        return;
      }
      this.logger('Subscribed to Server2Client successfully.');

      this.server2ClientChar.on('data', (data, isNotification) => {
        this.handleIncomingNotification(data);
      });

      // 2. Write 0x01 (Start) command to State characteristic
      this.logger('Sending START command (0x01) to State characteristic...');
      // write(data, withoutResponse, callback)
      this.stateChar.write(Buffer.from([0x01]), true, (err) => {
        if (err) {
          this.logger(`Write START error: ${err.message}`);
          this.disconnect();
          return;
        }
        this.logger('START command sent. Triggering request transmission...');
        
        // Notify main process to compile and send the request payload
        if (this.onReadyToSendRequest) {
          this.onReadyToSendRequest();
        }
      });
    });
  }

  /**
   * Sends the SessionEstablishment request to the peripheral using fragmentation.
   * 
   * @param {Buffer} requestPayload CBOR-encoded SessionEstablishment
   */
  async sendRequestPayload(requestPayload) {
    if (!this.client2ServerChar) {
      this.logger('Error: Cannot send request, Client2Server characteristic not available.');
      return;
    }

    this.logger(`Sending request payload (${requestPayload.length} bytes)...`);
    this.isTransferring = true;
    this.responseBuffer = Buffer.alloc(0);

    // Negotiated MTU check (macOS usually negotiates 247-512, noble handles this under the hood)
    // Safe chunk size: GATT MTU - 3 overhead.
    // If peripheral.mtu is not set or accessible, default to 244 byte packet size (247 MTU).
    const mtu = this.discoveredPeripheral.mtu || 247;
    const maxPacketSize = mtu - 3;
    const maxDataSize = maxPacketSize - 1; // Subtract 1 byte for the fragmentation flag

    this.logger(`Negotiated MTU: ${mtu}. Usable packet size: ${maxPacketSize} bytes. Max fragment data: ${maxDataSize} bytes.`);

    let offset = 0;
    let chunkCounter = 0;

    while (offset < requestPayload.length) {
      const remaining = requestPayload.length - offset;
      const readLen = Math.min(maxDataSize, remaining);
      const isLast = (offset + readLen) >= requestPayload.length;

      // First byte flag: 0x01 = more packets, 0x00 = last packet
      const flag = isLast ? 0x00 : 0x01;
      const chunkData = requestPayload.subarray(offset, offset + readLen);
      const packet = Buffer.concat([Buffer.from([flag]), chunkData]);

      chunkCounter++;
      this.logger(`Writing request fragment #${chunkCounter} (size: ${packet.length} bytes, flag: ${flag})...`);

      await this.writeFragment(this.client2ServerChar, packet);
      offset += readLen;

      // Small throttling delay to prevent flooding BLE buffer on macOS
      await new Promise(resolve => setTimeout(resolve, 30));
    }

    this.logger('All request fragments written. Waiting for response notifications...');
  }

  writeFragment(characteristic, packet) {
    return new Promise((resolve, reject) => {
      characteristic.write(packet, true, (err) => {
        if (err) {
          return reject(err);
        }
        resolve();
      });
    });
  }

  handleIncomingNotification(data) {
    if (data.length < 1) {
      this.logger('Warning: Received empty notification on Server2Client.');
      return;
    }

    const flag = data[0];
    const payload = data.subarray(1);

    this.logger(`Received response fragment (${payload.length} bytes, flag: ${flag})`);
    this.responseBuffer = Buffer.concat([this.responseBuffer, payload]);

    if (flag === 0x00) {
      this.logger(`Response reassembly complete. Total size: ${this.responseBuffer.length} bytes.`);
      this.isTransferring = false;

      // Trigger callback to process response
      if (this.onResponseReceived) {
        this.onResponseReceived(this.responseBuffer);
      }

      // Finish transaction
      this.endTransaction();
    }
  }

  async endTransaction() {
    if (!this.stateChar) return;

    this.logger('Sending END command (0x02) to State characteristic...');
    this.stateChar.write(Buffer.from([0x02]), true, (err) => {
      if (err) {
        this.logger(`Write END error: ${err.message}`);
      } else {
        this.logger('END command sent successfully.');
      }
      this.disconnect();
    });
  }

  disconnect() {
    if (this.discoveredPeripheral) {
      this.logger('Disconnecting BLE peripheral...');
      this.discoveredPeripheral.disconnect();
    }
  }
}

module.exports = BLEHandler;
