# mdoc-reader-macos

A premium Electron-based desktop application for macOS to read and verify ISO 18013-5 Mobile Driver's Licenses (mDL) over **NFC Negotiated Handover** transitioning to **Bluetooth Low Energy (BLE)**.

This verifier application establishes a secure connection with a mobile wallet, exchanges encrypted requests/responses, decrypts mDL attributes, and runs a comprehensive suite of cryptographic integrity audits.

---

## Features

- **NFC TNEP Negotiated Handover**: Negotiates BLE transfer parameters over NFC using a PC/SC compliant NFC reader (e.g., ACS ACR1252). Performs AID selection, capability container parsing, TNEP service selection, and reads the Handover Select (`Hs`) message.
  - **HCE Connection Recovery**: Terminates connections with the `SCARD_RESET_CARD` disposition to recycle the card state and reset the phone's HCE stack. This prevents the phone from getting into a wedged state that causes `SCARD_E_NOT_TRANSACTED (0x80100016)` on subsequent taps.
  - **Stabilization Delays**: Implements a 150ms reader channel stabilization delay and a 100ms NDEF preparation delay to allow mobile wallets sufficient time to bind background services and generate keys.
- **Dynamic BLE Service UUID Injection**: Generates a random 128-bit UUID for each session, serializes it in little-endian format, and injects it into the Handover Request (`Hr`) BLE Carrier Configuration Record so the phone's wallet knows which service UUID to advertise.
- **Robust BLE Transfer & Spec Compliance**:
  - **CoreBluetooth MTU Fallback**: Falls back to a conservative, spec-compliant MTU of 23 bytes (19-byte data fragments) to ensure reliable writes on macOS CoreBluetooth without relying on explicit MTU negotiation.
  - **Spec-Compliant BLE Teardown**: Implements a GATT disconnect wait sequence where the verifier waits for the phone's wallet app to cleanly terminate the BLE session after writing the `0x02` (END) command, preventing phone GATT resource lockups, with a 5-second fallback forced disconnect.
  - **Session Active Tracking**: Tracks the active session state (`sessionActive`) so that unexpected disconnects (e.g. before data transmission finishes) trigger a connection drop error rather than a silent failure.
  - **Scanning Timeout & Recovery**: Implements a 15-second scanning timeout that cancels pending scans and triggers error callbacks if the target peripheral cannot be found.
  - **GATT & Transfer Error Handling**: Full error boundary propagation for adapter state changes, connection failures, service/characteristic discovery errors, notification subscription failures, and individual fragment write failures, ensuring that the reader lock is released and the UI is notified.
- **Secure Key Agreement & Encryption**:
  - Derives `SKReader` and `SKDevice` session keys via ECDH (P-256) and HKDF-SHA256 with the CBOR Tag 24 wrapped `SessionTranscript`.
  - Derives the device authentication MAC key (`EMacKey`) using the raw, unhashed `SessionTranscript` bytes as the KDF salt, complying with ISO/IEC 18013-5 Section 9.1.1.4.
  - Encrypts/decrypts payloads using AES-256-GCM.
- **Cryptographic Audit Suite**:
  - Validates `DeviceAuth` signatures or `DeviceMAC` tag verification. Includes a parser translation workaround in `cose.mac0.verify` to reconstruct the standard 4-element `MAC0_structure` array `["MAC0", protectedHeaders, h'', payload]` when the underlying library generates a buggy 3-element array.
  - Fixes verification fall-through in `@owf/mdoc` library by patching `DeviceAuth.verify` with a clean return exit on successful `DeviceMAC` validation, preventing fall-through to the default signature error handler.
  - Verifies `IssuerAuth` signatures (Mobile Security Object - MSO) against trusted DS certificates.
  - Recalculates value digest hashes for each namespace element to ensure data integrity.
- **Interactive Dashboard UI**:
  - Premium dark-slate theme featuring responsive layouts, glowing status states, and a rotating radar welcome state.
  - **Side-by-Side Responsive Flex Layout**: Places the decoded mDL card and the Cryptographic Audit log panel side-by-side, wrapping cleanly on narrower viewports.
  - **State-Driven UI Resets**: Instantly clears old attributes and resets status indicators to unverified `'-'` states on starting a new reader session or simulator demo to prevent data persistence across scans. Instantly resets UI results on both `NFC_WAITING` and `NFC_READING` states to handle subsequent scans cleanly.
  - **CSS Specificity Bug Fix**: Configures `#view-profile` to default to `display: none;` and `#view-profile.active { display: flex; }` to resolve the CSS ID specificity collision that prevented result panels from hiding.
  - **Bulletproof Inline Style Overrides**: Uses explicit JavaScript inline style overrides (`display: none` / `display: flex`) with comprehensive try/catch debug logging to bypass stylesheet caching issues in Electron.
  - **DateObject Serialization Translation**: Formats claims to `YYYY-MM-DD` strings before IPC transport to avoid serialization prototype loss across Electron processes.
  - Terminal-like logs console displaying real-time APDU command blocks and BLE status.
  - Built-in Hardware Simulator mode for testing without physical readers.

---

## Project Structure

- `main.js`: Main Electron process (IPC controller, lifecycle, BLE peripheral scanning).
- `preload.js`: Exposes secure IPC API bridges to the renderer process.
- `renderer.js`: Binds DOM elements, controls button clicks, and prints logs. Handles state-driven clearing and updates.
- `nfc-handler.js`: Interfaces with `@pokusew/pcsclite` to run the NFC TNEP state machine and handle connection drop retap prompts.
- `ble-handler.js`: GATT client interfacing with `@abandonware/noble` to handle fragmented data transfer, conservative MTU fallback, compliance teardown, session tracking, scan timeouts, and error propagation.
- `mdl-parser.js`: Parses CBOR, derives MAC/session keys, executes cryptographic audits, and formats date string outputs.
- `simulator.js`: Mimics NFC APDU transactions, BLE packet reassembly, and cryptographical validations for local demoing.
- `index.html` & `index.css`: Page structure and responsive side-by-side stylesheet rules.

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
