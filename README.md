# mdoc-reader-macos

A premium Electron-based desktop application for macOS to read and verify ISO 18013-5 Mobile Driver's Licenses (mDL) over **NFC Negotiated Handover** transitioning to **Bluetooth Low Energy (BLE)**.

This verifier application establishes a secure connection with a mobile wallet, exchanges encrypted requests/responses, decrypts mDL attributes, and runs a comprehensive suite of cryptographic integrity audits.

---

## Features

- **NFC TNEP Negotiated Handover**: Negotiates BLE transfer parameters over NFC using a PC/SC compliant NFC reader (e.g., ACS ACR1252). Performs AID selection, capability container parsing, TNEP service selection, and reads the Handover Select (`Hs`) message.
- **Dynamic BLE Service UUID Injection**: Generates a random 128-bit UUID for each session, serializes it in little-endian format, and injects it into the Handover Request (`Hr`) BLE Carrier Configuration Record so the phone's wallet knows which service UUID to advertise.
- **Secure Key Agreement & Encryption**:
  - Derives `SKReader` and `SKDevice` session keys via ECDH (P-256) and HKDF-SHA256 with the CBOR Tag 24 wrapped `SessionTranscript`.
  - Encrypts/decrypts payloads using AES-256-GCM.
- **Cryptographic Audit Suite**:
  - Validates `DeviceAuth` signatures or `DeviceMAC` tag verification.
  - Verifies `IssuerAuth` signatures (Mobile Security Object - MSO) against trusted DS certificates.
  - Recalculates value digest hashes for each namespace element to ensure data integrity.
- **Interactive Dashboard UI**:
  - Premium dark-slate theme featuring responsive layouts, glowing status states, and a rotating radar welcome state.
  - Renders decrypted attributes (names, document number, DOB, portrait photo) and privileges side-by-side with the cryptographic audit results.
  - Terminal-like logs console displaying real-time APDU command blocks and BLE status.
  - Built-in Hardware Simulator mode for testing without physical readers.

---

## Project Structure

- `main.js`: Main Electron process (IPC controller, lifecycle, BLE peripheral scanning).
- `preload.js`: Exposes secure IPC API bridges to the renderer process.
- `renderer.js`: Binds DOM elements, controls button clicks, and prints logs.
- `nfc-handler.js`: Interfaces with `@pokusew/pcsclite` to run the NFC TNEP state machine.
- `ble-handler.js`: GATT client interfacing with `@abandonware/noble` to handle fragmented data transfer.
- `mdl-parser.js`: Parses CBOR, runs cryptographic audits, and formats date string outputs.
- `simulator.js`: Mimics NFC APDU transactions, BLE packet reassembly, and cryptographical validations for local demoing.
- `index.html` & `index.css`: Page structure and styling.

---

## Requirements

- **OS**: macOS
- **Hardware**: A PC/SC-compatible NFC Reader (e.g. ACS ACR1252) connected via USB.
- **Software Dependencies**:
  - Node.js (v18+)
  - PC/SC Smart Card Daemon (running natively on macOS)

---

## Installation & Setup

1. Clone the repository and navigate to the directory:
   ```bash
   git clone https://github.com/timbl-ont/mdoc-reader-macos.git
   cd mdoc-reader-macos
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Rebuild native modules (`@pokusew/pcsclite` and `@abandonware/noble`) for Electron:
   ```bash
   npm run rebuild
   ```

---

## Running the Application

To launch the Electron desktop interface:
```bash
npm start
```

### Modes of Operation:
- **Simulator Mode**: Click **"Run Hardware Simulator"** to execute a full mock verification protocol.
- **Live Device Tap**: Click **"Start Listening"**, tap a mobile wallet (e.g. Android Multipaz wallet) on your USB NFC reader, and follow the phone's authentication/consent prompts.
