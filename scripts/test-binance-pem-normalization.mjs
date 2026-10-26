import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { binanceSigningMode, signBinanceParams } from '../lib/binance-order-writer.mjs';

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pub = publicKey.export({ type: 'spki', format: 'pem' });

for (const [name, variant] of [
  ['standard', pem],
  ['une seule ligne avec espaces', pem.replace(/\n/g, ' ')],
  ['une seule ligne sans espace', pem.replace(/\n/g, '')],
  ['\\n littéraux', pem.replace(/\n/g, '\\n')],
  ['guillemets', '"' + pem + '"'],
  ['retours Windows', pem.replace(/\n/g, '\r\n')],
]) {
  test(`clé Ed25519 lue : ${name}`, () => {
    assert.equal(binanceSigningMode(variant), 'ED25519');
    const params = signBinanceParams(new URLSearchParams({ timestamp: '1' }), variant);
    const sig = Buffer.from(params.get('signature'), 'base64');
    assert.ok(crypto.verify(null, Buffer.from('timestamp=1'), publicKey, sig));
  });
}

test('clé publique collée à la place de la privée : message explicite', () => {
  assert.throws(() => binanceSigningMode(pub), /BINANCE_PUBLIC_KEY_GIVEN_INSTEAD_OF_PRIVATE/);
});

test('secret HMAC inchangé', () => {
  assert.equal(binanceSigningMode('abcdefHMACsecret'), 'HMAC');
});
