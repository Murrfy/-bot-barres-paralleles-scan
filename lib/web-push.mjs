import crypto from 'node:crypto';

function b64url(value){
  return Buffer.from(value).toString('base64url');
}
function decode64(value){
  try{return Buffer.from(String(value||''),'base64url')}catch{return Buffer.alloc(0)}
}
function hmac(key,data){
  return crypto.createHmac('sha256',key).update(data).digest();
}
function hkdfExtract(salt,ikm){
  return hmac(salt,ikm);
}
function hkdfExpand(prk,info,length){
  if(!(length>0&&length<=32))throw new Error('WEB_PUSH_HKDF_LENGTH_INVALID');
  return hmac(prk,Buffer.concat([Buffer.from(info),Buffer.from([1])])).subarray(0,length);
}
function validP256Public(raw){
  return Buffer.isBuffer(raw)&&raw.length===65&&raw[0]===4;
}
function jwkFromRaw({publicKey,privateKey}){
  const pub=decode64(publicKey),priv=decode64(privateKey);
  if(!validP256Public(pub)||priv.length!==32)throw new Error('VAPID_KEY_INVALID');
  return {
    kty:'EC',crv:'P-256',
    x:b64url(pub.subarray(1,33)),
    y:b64url(pub.subarray(33,65)),
    d:b64url(priv),
  };
}
function endpointOrigin(endpoint){
  let url;
  try{url=new URL(String(endpoint||''))}catch{throw new Error('PUSH_ENDPOINT_INVALID')}
  if(url.protocol!=='https:')throw new Error('PUSH_ENDPOINT_INVALID');
  const host=url.hostname.toLowerCase();
  if(!(host==='push.apple.com'||host.endsWith('.push.apple.com'))){
    throw new Error('PUSH_ENDPOINT_NOT_APPLE');
  }
  return {url,origin:url.origin};
}

export function generateVapidKeyPair(){
  const ecdh=crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKey:b64url(ecdh.getPublicKey()),
    privateKey:b64url(ecdh.getPrivateKey()),
  };
}

export function vapidHeaders({endpoint,publicKey,privateKey,subject='https://zenithfinal3-ahle.vercel.app',now=Date.now()}={}){
  const {origin}=endpointOrigin(endpoint);
  const jwk=jwkFromRaw({publicKey,privateKey});
  const key=crypto.createPrivateKey({key:jwk,format:'jwk'});
  const header=b64url(Buffer.from(JSON.stringify({typ:'JWT',alg:'ES256'})));
  const payload=b64url(Buffer.from(JSON.stringify({
    aud:origin,
    exp:Math.floor(Number(now)/1000)+12*60*60,
    sub:String(subject||'https://zenithfinal3-ahle.vercel.app'),
  })));
  const input=header+'.'+payload;
  const signature=crypto.sign('sha256',Buffer.from(input),{key,dsaEncoding:'ieee-p1363'});
  return {
    Authorization:`vapid t=${input}.${b64url(signature)}, k=${publicKey}`,
    TTL:'300',
    Urgency:'high',
  };
}

export function encryptWebPushPayload({payload,p256dh,authSecret,salt,serverPrivateKey}={}){
  const uaPublic=decode64(p256dh);
  const auth=decode64(authSecret);
  if(!validP256Public(uaPublic))throw new Error('PUSH_P256DH_INVALID');
  if(auth.length<16)throw new Error('PUSH_AUTH_SECRET_INVALID');

  const ecdh=crypto.createECDH('prime256v1');
  if(serverPrivateKey){
    const raw=Buffer.isBuffer(serverPrivateKey)?serverPrivateKey:decode64(serverPrivateKey);
    if(raw.length!==32)throw new Error('PUSH_EPHEMERAL_PRIVATE_INVALID');
    ecdh.setPrivateKey(raw);
  }else{
    ecdh.generateKeys();
  }
  const asPublic=ecdh.getPublicKey();
  const shared=ecdh.computeSecret(uaPublic);

  const prkKey=hkdfExtract(auth,shared);
  const keyInfo=Buffer.concat([
    Buffer.from('WebPush: info\0','utf8'),
    uaPublic,
    asPublic,
  ]);
  const ikm=hkdfExpand(prkKey,keyInfo,32);
  const saltBytes=salt
    ?(Buffer.isBuffer(salt)?salt:decode64(salt))
    :crypto.randomBytes(16);
  if(saltBytes.length!==16)throw new Error('PUSH_SALT_INVALID');
  const prk=hkdfExtract(saltBytes,ikm);
  const cek=hkdfExpand(prk,Buffer.from('Content-Encoding: aes128gcm\0','utf8'),16);
  const nonce=hkdfExpand(prk,Buffer.from('Content-Encoding: nonce\0','utf8'),12);

  const plain=Buffer.concat([
    Buffer.isBuffer(payload)?payload:Buffer.from(String(payload??''),'utf8'),
    Buffer.from([2]),
  ]);
  if(plain.length>3993)throw new Error('PUSH_PAYLOAD_TOO_LARGE');

  const cipher=crypto.createCipheriv('aes-128-gcm',cek,nonce);
  const encrypted=Buffer.concat([cipher.update(plain),cipher.final(),cipher.getAuthTag()]);
  const rs=Buffer.alloc(4);rs.writeUInt32BE(4096,0);
  return {
    body:Buffer.concat([saltBytes,rs,Buffer.from([asPublic.length]),asPublic,encrypted]),
    salt:saltBytes,
    serverPublicKey:asPublic,
    contentEncryptionKey:cek,
    nonce,
  };
}

export async function sendAppleWebPush({
  subscription,
  payload,
  vapid,
  subject='https://zenithfinal3-ahle.vercel.app',
  fetchImpl=fetch,
  now=Date.now(),
}={}){
  const endpoint=String(subscription?.endpoint||'');
  endpointOrigin(endpoint);
  const p256dh=String(subscription?.keys?.p256dh||'');
  const authSecret=String(subscription?.keys?.auth||'');
  const encrypted=encryptWebPushPayload({
    payload:Buffer.from(JSON.stringify(payload??{}),'utf8'),
    p256dh,
    authSecret,
  });
  const vapidAuth=vapidHeaders({
    endpoint,
    publicKey:vapid?.publicKey,
    privateKey:vapid?.privateKey,
    subject,
    now,
  });
  const response=await fetchImpl(endpoint,{
    method:'POST',
    headers:{
      ...vapidAuth,
      'Content-Encoding':'aes128gcm',
      'Content-Type':'application/octet-stream',
    },
    body:encrypted.body,
    signal:AbortSignal.timeout(8000),
    cache:'no-store',
  });
  return {
    ok:response.ok,
    status:Number(response.status)||0,
    expired:[404,410].includes(Number(response.status)),
  };
}
