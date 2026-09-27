import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  generateVapidKeyPair,
  vapidHeaders,
  encryptWebPushPayload,
  sendAppleWebPush,
} from '../lib/web-push.mjs';

function hmac(key,data){return crypto.createHmac('sha256',key).update(data).digest()}
function expand(prk,info,len){
  return hmac(prk,Buffer.concat([Buffer.from(info),Buffer.from([1])])).subarray(0,len);
}
function decode(v){return Buffer.from(String(v||''),'base64url')}

test('dependency-free aes128gcm Web Push payload round-trips with recipient P-256 key',()=>{
  const ua=crypto.createECDH('prime256v1');ua.generateKeys();
  const sender=crypto.createECDH('prime256v1');sender.generateKeys();
  const auth=crypto.randomBytes(16),salt=crypto.randomBytes(16);
  const payload=Buffer.from(JSON.stringify({title:'Zenith',body:'MAX-LOSS rouge'}));
  const encrypted=encryptWebPushPayload({
    payload,
    p256dh:ua.getPublicKey().toString('base64url'),
    authSecret:auth.toString('base64url'),
    salt,
    serverPrivateKey:sender.getPrivateKey(),
  });

  assert.equal(encrypted.body.subarray(0,16).equals(salt),true);
  assert.equal(encrypted.body.readUInt32BE(16),4096);
  const keyLength=encrypted.body[20];
  assert.equal(keyLength,65);
  const serverPublic=encrypted.body.subarray(21,21+keyLength);
  assert.equal(serverPublic.equals(sender.getPublicKey()),true);

  const shared=ua.computeSecret(serverPublic);
  const prkKey=hmac(auth,shared);
  const info=Buffer.concat([Buffer.from('WebPush: info\0'),ua.getPublicKey(),serverPublic]);
  const ikm=expand(prkKey,info,32);
  const prk=hmac(salt,ikm);
  const cek=expand(prk,Buffer.from('Content-Encoding: aes128gcm\0'),16);
  const nonce=expand(prk,Buffer.from('Content-Encoding: nonce\0'),12);
  const cipherText=encrypted.body.subarray(21+keyLength);
  const tag=cipherText.subarray(-16);
  const body=cipherText.subarray(0,-16);
  const decipher=crypto.createDecipheriv('aes-128-gcm',cek,nonce);
  decipher.setAuthTag(tag);
  const plain=Buffer.concat([decipher.update(body),decipher.final()]);
  assert.equal(plain.at(-1),2);
  assert.equal(plain.subarray(0,-1).equals(payload),true);
});

test('VAPID JWT is ES256-signed for the exact Apple push origin',()=>{
  const vapid=generateVapidKeyPair();
  const now=1_800_000_000_000;
  const headers=vapidHeaders({
    endpoint:'https://web.push.apple.com/Q-test',
    ...vapid,
    now,
  });
  const match=/^vapid t=([^,]+), k=(.+)$/.exec(headers.Authorization);
  assert.ok(match);
  assert.equal(match[2],vapid.publicKey);
  const [head,payload,sig]=match[1].split('.');
  const claims=JSON.parse(decode(payload).toString('utf8'));
  assert.equal(claims.aud,'https://web.push.apple.com');
  assert.equal(claims.exp,Math.floor(now/1000)+12*60*60);

  const pub=decode(vapid.publicKey);
  const publicKey=crypto.createPublicKey({
    key:{kty:'EC',crv:'P-256',x:pub.subarray(1,33).toString('base64url'),y:pub.subarray(33).toString('base64url')},
    format:'jwk',
  });
  assert.equal(crypto.verify(
    'sha256',
    Buffer.from(head+'.'+payload),
    {key:publicKey,dsaEncoding:'ieee-p1363'},
    decode(sig)
  ),true);
});

test('sender accepts Apple push only and emits visible encrypted payload headers',async()=>{
  const ua=crypto.createECDH('prime256v1');ua.generateKeys();
  const vapid=generateVapidKeyPair();
  const subscription={
    endpoint:'https://web.push.apple.com/Q-test',
    keys:{p256dh:ua.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')},
  };
  let seen=null;
  const result=await sendAppleWebPush({
    subscription,payload:{title:'Zenith',body:'test'},vapid,
    fetchImpl:async(url,init)=>{
      seen={url,init};
      return {ok:true,status:201};
    },
  });
  assert.equal(result.ok,true);
  assert.equal(seen.url,subscription.endpoint);
  assert.equal(seen.init.headers['Content-Encoding'],'aes128gcm');
  assert.match(seen.init.headers.Authorization,/^vapid t=/);
  assert.ok(Buffer.isBuffer(seen.init.body));

  await assert.rejects(()=>sendAppleWebPush({
    subscription:{...subscription,endpoint:'https://example.com/push'},
    payload:{title:'bad'},vapid,fetchImpl:async()=>({ok:true,status:201}),
  }),/PUSH_ENDPOINT_NOT_APPLE/);
});
