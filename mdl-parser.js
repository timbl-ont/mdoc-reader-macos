const crypto = require('crypto');

// ESM Module dynamic import bindings
let mdoc = null;
let DeviceEngagement, DeviceRequest, DocRequest, ItemsRequest, SessionTranscript, NfcHandover, QrHandover, EReaderKey, DeviceResponse, Verifier, cborEncode, cborDecode, Security, EDeviceKey, DataItem, CoseKey, KeyType, CoseKeyParameter;

async function ensureMdocLoaded() {
  if (mdoc) return;
  
  // Dynamically import the ES module
  mdoc = await import('@owf/mdoc');
  
  // Bind exports to module-level variables
  ({
    DeviceEngagement,
    DeviceRequest,
    DocRequest,
    ItemsRequest,
    SessionTranscript,
    NfcHandover,
    QrHandover,
    EReaderKey,
    DeviceResponse,
    Verifier,
    cborEncode,
    cborDecode,
    Security,
    EDeviceKey,
    DataItem,
    CoseKey,
    KeyType,
    CoseKeyParameter
  } = mdoc);
}

class MDLParser {
  constructor(logger) {
    this.logger = logger || console.log;
    this.ephemeralReaderKey = null;
    this.deviceEngagement = null;
    this.sessionTranscript = null;
    
    // Session keys
    this.skReader = null;
    this.skDevice = null;
    
    // Message counters (independently maintained, starting at 1)
    this.readerCounter = 1;
    this.deviceCounter = 1;
  }

  /**
   * Initializes the session parameters from the NFC-retrieved DeviceEngagement payload.
   * Generates ephemeral reader key pair and computes SKReader and SKDevice.
   * 
   * @param {Buffer} deviceEngagementBytes 
   * @param {Buffer} ndefSelectMessageBytes 
   * @param {Boolean} isDirectNfc
   * @param {Buffer} ndefRequestMessageBytes
   */
  async initializeSession(deviceEngagementBytes, ndefSelectMessageBytes, isDirectNfc = false, ndefRequestMessageBytes = null) {
    this.logger('Initializing ISO 18013-5 Session...');
    await ensureMdocLoaded();

    // 1. Decode Device Engagement
    try {
      this.deviceEngagement = DeviceEngagement.decode(deviceEngagementBytes);
      this.logger(`Decoded Device Engagement (version: ${this.deviceEngagement.version})`);
    } catch (err) {
      this.logger(`Error decoding Device Engagement: ${err.message}`);
      throw err;
    }

    // 2. Generate Ephemeral Reader Key Pair
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const jwk = privateKey.export({ format: 'jwk' });
    this.ephemeralReaderKey = EReaderKey.fromJwk(jwk);
    this.logger('Generated Ephemeral Reader Key Pair (P-256)');

    // 3. Construct Session Transcript
    let handover;
    if (isDirectNfc || !ndefSelectMessageBytes) {
      this.logger('Using direct NFC engagement (no connection handover). Handover is null.');
      handover = QrHandover.create();
    } else {
      this.logger('Using NFC Connection Handover.');
      handover = NfcHandover.create({
        selectMessage: new Uint8Array(ndefSelectMessageBytes),
        requestMessage: ndefRequestMessageBytes ? new Uint8Array(ndefRequestMessageBytes) : undefined
      });
    }

    // Strip private key coordinate d for the Session Transcript (must only contain public key parameters)
    const publicJwk = {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y
    };
    const ephemeralReaderPublicKey = EReaderKey.fromJwk(publicJwk);

    this.sessionTranscript = SessionTranscript.create({
      deviceEngagement: this.deviceEngagement,
      eReaderKey: ephemeralReaderPublicKey,
      handover: handover
    });
    const sessionTranscriptBytes = this.sessionTranscript.encode({ asDataItem: true });
    this.logger(`Session Transcript constructed (${sessionTranscriptBytes.length} bytes)`);

    // 4. Derive ECDH Shared Secret
    const eDeviceKey = this.deviceEngagement.security.eDeviceKey;
    const x = eDeviceKey.x;
    const y = eDeviceKey.y;

    // Construct raw uncompressed public key buffer (0x04 || x || y)
    const rawPublicKey = Buffer.concat([
      Buffer.from([0x04]),
      Buffer.from(x),
      Buffer.from(y)
    ]);

    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(Buffer.from(this.ephemeralReaderKey.d));
    const sharedSecret = ecdh.computeSecret(rawPublicKey);
    this.logger('ECDH Shared Secret computed successfully.');

    // 5. Derive Symmetric Session Keys (HKDF-SHA256)
    const salt = crypto.createHash('sha256').update(sessionTranscriptBytes).digest();
    
    this.skReader = crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from('SKReader', 'utf8'), 32);
    this.skDevice = crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from('SKDevice', 'utf8'), 32);

    this.logger(`Derived SKReader: ${Buffer.from(this.skReader).toString('hex').toUpperCase().substring(0, 16)}...`);
    this.logger(`Derived SKDevice: ${Buffer.from(this.skDevice).toString('hex').toUpperCase().substring(0, 16)}...`);

    // Reset counters
    this.readerCounter = 1;
    this.deviceCounter = 1;
  }

  /**
   * Generates the encrypted SessionEstablishment payload containing the DeviceRequest.
   * 
   * @returns {Promise<Buffer>} CBOR-encoded SessionEstablishment message
   */
  async createSessionEstablishment() {
    this.logger('Constructing Device Request for mDL attributes...');
    await ensureMdocLoaded();

    // Request standard attributes from primary namespace
    const itemsRequest = ItemsRequest.create({
      docType: 'org.iso.18013.5.1.mDL',
      namespaces: {
        'org.iso.18013.5.1': {
          'family_name': true,
          'given_name': true,
          'birth_date': true,
          'issue_date': true,
          'expiry_date': true,
          'issuing_authority': true,
          'document_number': true,
          'portrait': true,
          'driving_privileges': true
        }
      }
    });

    const docRequest = DocRequest.create({
      itemsRequest: itemsRequest
    });

    const deviceRequest = DeviceRequest.create({
      docRequests: [docRequest]
    });

    const deviceRequestBytes = cborEncode(deviceRequest.encodedStructure);
    this.logger(`Plaintext DeviceRequest CBOR length: ${deviceRequestBytes.length} bytes`);

    // Encrypt the request using SKReader
    const encryptedData = this.encryptMessage(deviceRequestBytes, this.skReader, this.readerCounter++);
    this.logger(`Encrypted request ciphertext length: ${encryptedData.length} bytes`);

    // Extract reader public key from the ephemeral key structure (must remove private key d parameter)
    const eReaderKeyCose = new Map(this.ephemeralReaderKey.encodedStructure);
    eReaderKeyCose.delete(-4); // Remove private key 'd' coordinate

    // Wrap into SessionEstablishment Map
    const sessionEstablishment = new Map([
      ['eReaderKey', DataItem.fromData(eReaderKeyCose)],
      ['data', encryptedData]
    ]);

    const sessionEstablishmentBytes = cborEncode(sessionEstablishment);
    this.logger(`Constructed SessionEstablishment CBOR bytes (${sessionEstablishmentBytes.length} bytes)`);

    return sessionEstablishmentBytes;
  }

  /**
   * Decrypts and parses the incoming BLE SessionResponse message.
   * 
   * @param {Buffer} sessionResponseBytes CBOR-encoded SessionResponse map
   * @returns {Promise<Object>} Decoded identity data
   */
  async processSessionResponse(sessionResponseBytes) {
    this.logger('Processing Session Response...');
    await ensureMdocLoaded();

    let sessionDataMap;
    try {
      sessionDataMap = cborDecode(sessionResponseBytes);
    } catch (err) {
      throw new Error(`Failed to decode response CBOR: ${err.message}`);
    }

    // Check status
    if (sessionDataMap.has('status')) {
      const status = sessionDataMap.get('status');
      this.logger(`Response contains status code: ${status}`);
      if (status !== 0) {
        throw new Error(`Device returned session error status: ${status}`);
      }
    }

    if (!sessionDataMap.has('data')) {
      throw new Error('Response does not contain encrypted data field');
    }

    const encryptedData = sessionDataMap.get('data');
    this.logger(`Decrypting response payload (${encryptedData.length} bytes)...`);

    // Decrypt the data using SKDevice
    const decryptedBytes = this.decryptMessage(encryptedData, this.skDevice, this.deviceCounter++);
    this.logger(`Decrypted response CBOR length: ${decryptedBytes.length} bytes`);

    // Parse DeviceResponse
    let deviceResponse;
    try {
      deviceResponse = DeviceResponse.decode(decryptedBytes);
      this.logger(`Decoded DeviceResponse (version: ${deviceResponse.structure.get('version')})`);
    } catch (err) {
      throw new Error(`Failed to parse DeviceResponse: ${err.message}`);
    }

    // Verify Device Signature & Issuer Signatures
    this.logger('Verifying signatures & crypto integrity...');
    const checks = [];
    const onCheck = (checkEvent) => {
      checks.push(checkEvent);
      let logMsg = `[Verification] ${checkEvent.check}: ${checkEvent.status}`;
      if (checkEvent.reason) {
        logMsg += ` (Reason: ${checkEvent.reason})`;
      }
      this.logger(logMsg);
    };

    const getDnField = (dn, field) => {
      const parts = dn.split(/(?<!\\),/);
      const results = [];
      for (const part of parts) {
        const [k, v] = part.split('=');
        if (k && v && k.trim().toUpperCase() === field.toUpperCase()) {
          results.push(v.trim().replace(/\\(.)/g, '$1'));
        }
      }
      return results;
    };

    const getHashAlgorithm = (coseAlgName) => {
      switch (coseAlgName) {
        case 'ES256': return 'sha256';
        case 'ES384': return 'sha384';
        case 'ES512': return 'sha512';
        case 'EdDSA': return null;
        default: return 'sha256';
      }
    };

    const verificationCtx = {
      crypto: {
        random: (length) => new Uint8Array(crypto.randomBytes(length)),
        digest: async ({ digestAlgorithm, bytes }) => {
          const algo = digestAlgorithm.replace('-', '').toLowerCase();
          return new Uint8Array(crypto.createHash(algo).update(bytes).digest());
        },
        calculateEphemeralMacKey: async ({ privateKey, publicKey, sessionTranscriptBytes, info }) => {
          let privKeyBytes;
          if (privateKey instanceof Uint8Array) {
            privKeyBytes = privateKey;
          } else if (privateKey && privateKey.d) {
            privKeyBytes = privateKey.d;
          } else {
            privKeyBytes = privateKey;
          }

          let pubKeyBytes;
          if (publicKey instanceof Uint8Array) {
            pubKeyBytes = publicKey;
          } else if (publicKey && publicKey.x && publicKey.y) {
            pubKeyBytes = Buffer.concat([
              Buffer.from([0x04]),
              Buffer.from(publicKey.x),
              Buffer.from(publicKey.y)
            ]);
          } else {
            pubKeyBytes = publicKey;
          }

          this.logger(`[DEBUG EMacKey] privKeyBytes: ${Buffer.from(privKeyBytes).toString('hex').toUpperCase()}`);
          this.logger(`[DEBUG EMacKey] pubKeyBytes: ${Buffer.from(pubKeyBytes).toString('hex').toUpperCase()}`);

          const ecdh = crypto.createECDH('prime256v1');
          ecdh.setPrivateKey(Buffer.from(privKeyBytes));
          const sharedSecret = ecdh.computeSecret(Buffer.from(pubKeyBytes));
          this.logger(`[DEBUG EMacKey] sharedSecret: ${sharedSecret.toString('hex').toUpperCase()}`);

          const salt = sessionTranscriptBytes;
          this.logger(`[DEBUG EMacKey] salt (len ${salt.length}): ${salt.toString('hex').toUpperCase()}`);
          this.logger(`[DEBUG EMacKey] info: "${info}"`);
          this.logger(`[DEBUG EMacKey] sessionTranscriptBytes (len ${sessionTranscriptBytes.length}): ${Buffer.from(sessionTranscriptBytes).toString('hex').toUpperCase()}`);

          const derivedKeyBytes = crypto.hkdfSync('sha256', sharedSecret, salt, Buffer.from(info, 'utf8'), 32);
          this.logger(`[DEBUG EMacKey] derivedKeyBytes: ${Buffer.from(derivedKeyBytes).toString('hex').toUpperCase()}`);

          return CoseKey.create({ keyType: KeyType.Oct, curve: new Uint8Array(derivedKeyBytes) });
        }
      },
      cose: {
        sign1: {
          sign: async () => {
            throw new Error('Not implemented');
          },
          verify: async ({ key, sign1 }) => {
            try {
              const publicKeyObject = crypto.createPublicKey({
                key: key.jwk,
                format: 'jwk'
              });
              const hashAlgo = getHashAlgorithm(sign1.signatureAlgorithmName);
              const toBeSigned = sign1.toBeSigned;
              const signature = sign1.signature;

              return crypto.verify(
                hashAlgo,
                Buffer.from(toBeSigned),
                {
                  key: publicKeyObject,
                  dsaEncoding: 'ieee-p1363'
                },
                Buffer.from(signature)
              );
            } catch (err) {
              this.logger(`[Verification] Sign1 verify error: ${err.message}`);
              return false;
            }
          }
        },
        mac0: {
          sign: async ({ key, toBeAuthenticated }) => {
            const keyBytes = key.structure.get(-1) || key.k || key.structure.get(CoseKeyParameter.CurveOrK);
            return new Uint8Array(
              crypto.createHmac('sha256', keyBytes)
                    .update(toBeAuthenticated)
                    .digest()
            );
          },
          verify: async ({ mac0, key }) => {
            try {
              const keyBytes = key.structure.get(-1) || key.k || key.structure.get(CoseKeyParameter.CurveOrK);
              const toBeAuthenticated = mac0.toBeAuthenticated;
              const expectedTag = mac0.tag;

              this.logger(`[Verification] Mac0 key extracted: ${keyBytes ? Buffer.from(keyBytes).toString('hex').toUpperCase() : 'undefined'}`);
              this.logger(`[Verification] Mac0 keyType: ${key.keyType}`);
              this.logger(`[Verification] Mac0 expectedTag: ${Buffer.from(expectedTag).toString('hex').toUpperCase()}`);

              if (!keyBytes) {
                this.logger('[Verification] Mac0 error: keyBytes is undefined');
                return false;
              }

              // Translate 3-element array (buggy library output) to standard 4-element array (expected by wallet)
              let dataToVerify = toBeAuthenticated;
              try {
                const decoded = cborDecode(toBeAuthenticated);
                if (decoded && decoded.length === 3) {
                  const standardArray = [
                    decoded[0],      // 'MAC0'
                    decoded[1],      // protectedHeaders
                    Buffer.alloc(0), // empty externalAad
                    decoded[2]       // payload
                  ];
                  dataToVerify = cborEncode(standardArray);
                  this.logger(`[Verification] Mac0 translated 3-element array to standard 4-element array (new len: ${dataToVerify.length})`);
                }
              } catch (decodeErr) {
                this.logger(`[Verification] Mac0 CBOR translation failed, using original: ${decodeErr.message}`);
              }

              this.logger(`[Verification] Mac0 dataToVerify (len ${dataToVerify.length}): ${Buffer.from(dataToVerify).toString('hex').toUpperCase()}`);

              const computedTag = crypto.createHmac('sha256', keyBytes)
                                        .update(dataToVerify)
                                        .digest();

              this.logger(`[Verification] Mac0 computedTag: ${computedTag.toString('hex').toUpperCase()}`);

              return crypto.timingSafeEqual(computedTag, Buffer.from(expectedTag));
            } catch (err) {
              this.logger(`[Verification] Mac0 verify error: ${err.message}`);
              return false;
            }
          }
        }
      },
      x509: {
        getIssuerNameField: ({ certificate, field }) => {
          const cert = new crypto.X509Certificate(Buffer.from(certificate));
          return getDnField(cert.subject, field);
        },
        getPublicKey: ({ certificate, alg }) => {
          const cert = new crypto.X509Certificate(Buffer.from(certificate));
          const jwk = cert.publicKey.export({ format: 'jwk' });
          if (alg) {
            jwk.alg = alg;
          }
          return CoseKey.fromJwk(jwk);
        },
        verifyCertificateChain: () => {
          return;
        },
        getCertificateData: ({ certificate }) => {
          const cert = new crypto.X509Certificate(Buffer.from(certificate));
          return {
            issuerName: cert.issuer,
            subjectName: cert.subject,
            serialNumber: cert.serialNumber,
            thumbprint: cert.fingerprint256,
            notBefore: new Date(cert.validFrom),
            notAfter: new Date(cert.validTo),
            pem: cert.toString()
          };
        }
      }
    };

    try {
      await Verifier.verifyDeviceResponse({
        deviceResponse: deviceResponse,
        ephemeralReaderKey: this.ephemeralReaderKey,
        sessionTranscript: this.sessionTranscript,
        disableCertificateChainValidation: true, // Bypass Chain verification for local test
        onCheck: onCheck
      }, verificationCtx);
      this.logger('Verification process completed.');
    } catch (err) {
      this.logger(`Crypto Verification failed (continuing to extract claims): ${err.message}`);
    }

    // Extract data elements
    return this.extractClaims(deviceResponse, checks);
  }

  /**
   * Helper to encrypt payload using AES-256-GCM with counter-derived IV.
   */
  encryptMessage(plaintext, key, counter) {
    // IV derivation: 8 bytes prefix (0 for Reader) + 4 bytes counter
    const iv = Buffer.concat([
      Buffer.alloc(8, 0),
      this.encodeUint32BE(counter)
    ]);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final()
    ]);
    const authTag = cipher.getAuthTag();

    // In ISO 18013-5, ciphertext is ciphertext || authTag
    return Buffer.concat([ciphertext, authTag]);
  }

  /**
   * Helper to decrypt payload using AES-256-GCM with counter-derived IV.
   */
  decryptMessage(ciphertextWithTag, key, counter) {
    if (ciphertextWithTag.length < 16) {
      throw new Error('Ciphertext too short (must include 16-byte auth tag)');
    }

    // Split ciphertext and auth tag
    const ciphertext = ciphertextWithTag.subarray(0, ciphertextWithTag.length - 16);
    const authTag = ciphertextWithTag.subarray(ciphertextWithTag.length - 16);

    // IV derivation: 8 bytes prefix (00 00 00 00 00 00 00 01 for Device) + 4 bytes counter
    const iv = Buffer.concat([
      Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]),
      this.encodeUint32BE(counter)
    ]);

    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final()
    ]);
  }

  encodeUint32BE(value) {
    const buf = Buffer.alloc(4);
    buf.writeUInt32BE(value, 0);
    return buf;
  }

  formatDate(val) {
    if (!val) return 'N/A';
    if (typeof val === 'string') return val;
    if (val instanceof Date) {
      return val.toISOString().split('T')[0];
    }
    if (typeof val.toISOString === 'function') {
      return val.toISOString();
    }
    if (val.date instanceof Date) {
      return val.date.toISOString().split('T')[0];
    }
    if (val.date) {
      const d = new Date(val.date);
      if (!isNaN(d.getTime())) {
        return d.toISOString().split('T')[0];
      }
    }
    return String(val);
  }

  /**
   * Extracts mDL claims from the verified DeviceResponse object.
   */
  extractClaims(deviceResponse, verificationChecks) {
    const documents = deviceResponse.structure.get('documents') || [];
    if (documents.length === 0) {
      return {
        error: 'No documents returned in response',
        verification: verificationChecks
      };
    }

    const document = documents[0];
    const docType = document.docType;
    this.logger(`Processing document type: ${docType}`);

    // Retrieve claims for the standard namespace
    const namespace = 'org.iso.18013.5.1';
    const claims = document.issuerSigned.getPrettyClaims(namespace) || {};
    this.logger(`Extracted claims namespace: ${namespace}`);
    this.logger(`Extracted claims keys: ${Object.keys(claims).join(', ')}`);

    // Format photo if present
    let photoBase64 = null;
    if (claims.portrait) {
      const portraitBytes = claims.portrait;
      photoBase64 = `data:image/jpeg;base64,${Buffer.from(portraitBytes).toString('base64')}`;
      this.logger(`Extracted portrait photo (${portraitBytes.length} bytes)`);
    }

    // Format driving privileges if present
    let privileges = null;
    if (claims.driving_privileges) {
      if (Array.isArray(claims.driving_privileges)) {
        privileges = claims.driving_privileges.map(priv => {
          let vehicleCode = 'N/A';
          let privIssueDate = 'N/A';
          let privExpiryDate = 'N/A';

          if (priv instanceof Map) {
            vehicleCode = priv.get('vehicle_code') || 'N/A';
            privIssueDate = this.formatDate(priv.get('issue_date'));
            privExpiryDate = this.formatDate(priv.get('expiry_date'));
          } else if (priv && typeof priv === 'object') {
            vehicleCode = priv.vehicle_code || priv.vehicleCode || 'N/A';
            privIssueDate = this.formatDate(priv.issue_date || priv.issueDate);
            privExpiryDate = this.formatDate(priv.expiry_date || priv.expiryDate);
          }

          return {
            vehicleCode,
            issueDate: privIssueDate,
            expiryDate: privExpiryDate
          };
        });
      }
    }

    return {
      docType,
      familyName: claims.family_name || 'N/A',
      givenName: claims.given_name || 'N/A',
      birthDate: this.formatDate(claims.birth_date),
      issueDate: this.formatDate(claims.issue_date),
      expiryDate: this.formatDate(claims.expiry_date),
      issuingAuthority: claims.issuing_authority || 'N/A',
      documentNumber: claims.document_number || 'N/A',
      drivingPrivileges: privileges,
      photo: photoBase64,
      rawClaims: claims,
      verification: verificationChecks
    };
  }
}

module.exports = MDLParser;
