async function main() {
  const mdoc = await import('@owf/mdoc');
  const { DeviceEngagement, EReaderKey, SessionTranscript, NfcHandover, cborEncode, DataItem } = mdoc;

  const hsHex = '91020F487315D10209616301013001046D646F631C1E580469736F2E6F72673A31383031333A646576696365656E676167656D656E746D646F63A20063312E30018201D818584BA401022001215820EADECD840B982C14B4F18633AC1CC84A8F14A3395FE3330553FAAB9682B70CBD225820E5C36D2E643EE589F5E0319DD27727B40475941A9479DBDE89B581995525B4B45A2015016170706C69636174696F6E2F766E642E626C7565746F6F74682E6C652E6F6F6230021C00110701E88C5523A72EBA6046D2A3D2747555';
  const hrHex = '910211487215910202637201025102046163010130005A201E016170706C69636174696F6E2F766E642E626C7565746F6F74682E6C652E6F6F6230081B00000000000000021C01110701E88C5523A72EBA6046D2A3D2747555';

  const hsNdef = Buffer.from(hsHex, 'hex');
  const hrNdef = Buffer.from(hrHex, 'hex');
  const deOffset = hsHex.indexOf('A20063312E30');
  const deBytes = Buffer.from(hsHex.substring(deOffset, deOffset + 88 * 2), 'hex');

  const de = DeviceEngagement.decode(deBytes);
  const jwk = { kty: 'EC', crv: 'P-256', x: 'laRKaXllUmVhbEtleV9feF9feF9feF9feF9feF9f', y: 'laRKaXllUmVhbEtleV9feV9feV9feV9feV9feV9f' };
  const ephemeralReaderPublicKey = EReaderKey.fromJwk(jwk);

  const handover = NfcHandover.create({
    selectMessage: new Uint8Array(hsNdef),
    requestMessage: new Uint8Array(hrNdef)
  });

  const sessionTranscript = SessionTranscript.create({
    deviceEngagement: de,
    eReaderKey: ephemeralReaderPublicKey,
    handover: handover
  });

  const rawBytes = cborEncode(sessionTranscript.encodedStructure);
  const taggedBytes = sessionTranscript.encode({ asDataItem: true });

  console.log('Raw bytes length:', rawBytes.length);
  console.log('Raw bytes start:', Buffer.from(rawBytes.slice(0, 10)).toString('hex').toUpperCase());

  console.log('Tagged bytes length:', taggedBytes.length);
  console.log('Tagged bytes start:', Buffer.from(taggedBytes.slice(0, 10)).toString('hex').toUpperCase());
}

main().catch(err => console.error(err));
