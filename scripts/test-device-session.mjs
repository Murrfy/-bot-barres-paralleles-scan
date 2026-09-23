import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEVICE_SESSION_COOKIE,
  bearerToken,
  cookieToken,
  deviceTokenCandidates,
  buildDeviceSessionCookie,
  buildClearDeviceSessionCookie,
  sameOriginMutation,
  validDeviceId,
  deviceSessionRemainingSeconds,
  deviceSessionRecordActive,
  DEVICE_SESSION_MAX_AGE_SECONDS,
} from '../lib/device-session.mjs';

test('Bearer parser is migration-only while normal auth candidates are cookie-only', () => {
  const req={headers:{authorization:'Bearer legacy-token',cookie:`${DEVICE_SESSION_COOKIE}=cookie-token`}};
  assert.equal(bearerToken(req),'legacy-token');
  assert.equal(cookieToken(req),'cookie-token');
  assert.deepEqual(deviceTokenCandidates(req),['cookie-token']);
  assert.deepEqual(deviceTokenCandidates({headers:{authorization:'Bearer legacy-token'}}),[]);
});

test('blank Bearer falls back to secure cookie', () => {
  const req={headers:{authorization:'Bearer ',cookie:`${DEVICE_SESSION_COOKIE}=cookie-token`}};
  assert.deepEqual(deviceTokenCandidates(req),['cookie-token']);
});

test('__Host cookie is HttpOnly Secure Strict and host-only', () => {
  const cookie=buildDeviceSessionCookie('abc123');
  for(const flag of ['Path=/','HttpOnly','Secure','SameSite=Strict','Priority=High']) assert.ok(cookie.includes(flag),flag);
  assert.equal(/(?:^|;)\s*Domain=/i.test(cookie),false);
});

test('secure cookie can be shortened to the server-side remaining lifetime', () => {
  const cookie=buildDeviceSessionCookie('abc123',123);
  assert.ok(cookie.includes('Max-Age=123'));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('Secure'));
  assert.ok(cookie.includes('SameSite=Strict'));
});

test('clear cookie keeps secure host-only attributes', () => {
  const cookie=buildClearDeviceSessionCookie();
  assert.ok(cookie.includes('Max-Age=0'));
  assert.ok(cookie.includes('HttpOnly'));
  assert.ok(cookie.includes('Secure'));
  assert.equal(/(?:^|;)\s*Domain=/i.test(cookie),false);
});

test('cookie mutation requires exact same origin', () => {
  const good={method:'POST',headers:{host:'zenithfinal3-ahle.vercel.app','x-forwarded-proto':'https',origin:'https://zenithfinal3-ahle.vercel.app',cookie:`${DEVICE_SESSION_COOKIE}=cookie-token`}};
  assert.equal(sameOriginMutation(good),true);
  assert.equal(sameOriginMutation({...good,headers:{...good.headers,origin:'https://evil.example'}}),false);
  assert.equal(sameOriginMutation({...good,headers:{...good.headers,origin:'https://other.vercel.app'}}),false);
});

test('forwarded host cannot redefine the trusted request origin', () => {
  const req={
    method:'POST',
    headers:{
      host:'zenithfinal3-ahle.vercel.app',
      'x-forwarded-host':'evil.example',
      'x-forwarded-proto':'https',
      origin:'https://zenithfinal3-ahle.vercel.app',
      cookie:`${DEVICE_SESSION_COOKIE}=cookie-token`,
    },
  };
  assert.equal(sameOriginMutation(req),true);
  assert.equal(sameOriginMutation({...req,headers:{...req.headers,origin:'https://evil.example'}}),false);
});

test('Bearer token never bypasses same-origin mutation checks', () => {
  const base={
    method:'POST',
    headers:{
      authorization:'Bearer legacy-token',
      host:'zenithfinal3-ahle.vercel.app',
      'x-forwarded-proto':'https',
    },
  };
  assert.equal(sameOriginMutation(base),false);
  assert.equal(sameOriginMutation({...base,headers:{...base.headers,origin:'https://evil.example'}}),false);
  assert.equal(sameOriginMutation({...base,headers:{...base.headers,origin:'https://zenithfinal3-ahle.vercel.app'}}),true);
  assert.equal(sameOriginMutation({...base,headers:{...base.headers,referer:'https://zenithfinal3-ahle.vercel.app/index.html'}}),true);
  assert.equal(sameOriginMutation({...base,headers:{...base.headers,'sec-fetch-site':'same-origin'}}),true);
});


test('device IDs are bounded and restricted to safe characters', () => {
  assert.equal(validDeviceId('iphone-12345678'), true);
  assert.equal(validDeviceId('ipad-550e8400-e29b-41d4-a716-446655440000'), true);
  assert.equal(validDeviceId('short'), false);
  assert.equal(validDeviceId('iphone-<script>alert(1)</script>'), false);
  assert.equal(validDeviceId('x'.repeat(129)), false);
});


test('device session records expire absolutely from original creation time', () => {
  const now=1_800_000_000_000;
  const recent={createdAt:now-(10*24*60*60*1000)};
  const expired={createdAt:now-((30*24*60*60*1000)+1)};
  assert.equal(deviceSessionRecordActive(recent,now),true);
  assert.ok(deviceSessionRemainingSeconds(recent,now)>0);
  assert.equal(deviceSessionRecordActive(expired,now),false);
  assert.equal(deviceSessionRemainingSeconds(expired,now),0);
  assert.equal(deviceSessionRecordActive({},now),false);
  assert.equal(DEVICE_SESSION_MAX_AGE_SECONDS,30*24*60*60);
});
