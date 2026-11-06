// The Candle sign-in: email codes, limits, sessions, invites, and hostname routing.
import assert from 'node:assert/strict';
import worker from '../cloudflare-worker.js';
import {localDB} from '../db/local.js';

const DB = localDB('/tmp/auth-test-' + crypto.randomUUID() + '.sqlite');
const sent = [];
let resendOk = true;
globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://api.resend.com/emails');
  assert.equal(init.headers.Authorization, 'Bearer re_test');
  const body = JSON.parse(init.body);
  sent.push(body);
  return new Response('{}', {status: resendOk ? 200 : 500});
};
const served = [];
const ASSETS = {fetch: r => { const p = new URL(r.url).pathname; served.push(p); return new Response('asset:' + p); }};
const env = {DB, ASSETS, AUTH_SECRET: 'test-secret-'.repeat(4), RESEND_API_KEY: 're_test', MAIL_FROM: 'The Candle <signin@thecandle.io>', TEACHER_EMAIL: 'jay@example.com', PUBLIC_HOST: 'thecandle.io', APP_HOST: 'learn.thecandle.io'};
const APP = 'https://learn.thecandle.io';
let ipCounter = 0;
const call = (path, {body, cookie, ip, headers = {}, method} = {}) => worker.fetch(new Request(APP + path, {
  method: method || (body ? 'POST' : 'GET'),
  headers: {...(body ? {'content-type': 'application/json', origin: APP} : {}), ...(cookie ? {cookie} : {}), 'cf-connecting-ip': ip || '10.0.0.' + (++ipCounter % 250), ...headers},
  body: body ? JSON.stringify(body) : undefined,
}), env);
const lastCode = to => { const m = sent.filter(s => s.to[0] === to).at(-1); return m && m.text.match(/\b(\d{6})\b/)[1]; };
const cookieFrom = res => (res.headers.get('set-cookie') || '').split(';')[0];
async function signIn(email) {
  const start = await call('/api/auth/start', {body: {email}});
  assert.equal(start.status, 200);
  const res = await call('/api/auth/verify', {body: {email, code: lastCode(email)}});
  assert.equal(res.status, 200, 'sign-in succeeds');
  return cookieFrom(res);
}

// Not configured: refuse rather than guess.
assert.equal((await worker.fetch(new Request(APP + '/api/auth/start', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"email":"jay@example.com"}'}), {...env, RESEND_API_KEY: ''})).status, 503);

// Uninvited emails get the same answer and no email.
let r = await call('/api/auth/start', {body: {email: 'stranger@example.com'}});
assert.equal(r.status, 200);
assert.equal((await r.json()).message, 'If that email is invited, a code is on its way.');
assert.equal(sent.length, 0, 'no email to an uninvited address');

// Teacher email is always invited; the email comes from The Candle and is not cached.
r = await call('/api/auth/start', {body: {email: ' Jay@Example.com '}});
assert.equal(r.status, 200);
assert.equal(sent.length, 1);
assert.equal(sent[0].from, 'The Candle <signin@thecandle.io>');
assert.deepEqual(sent[0].to, ['jay@example.com']);
assert.match(sent[0].subject, /^\d{6} is your The Candle sign-in code$/);
assert.equal(r.headers.get('cache-control'), 'no-store');
const stored = (await DB.prepare('SELECT code_hash FROM login_codes WHERE email = ?').bind('jay@example.com').all()).results[0];
assert.ok(stored && !stored.code_hash.includes(lastCode('jay@example.com')), 'only a hash of the code is stored');

// Wrong codes: 5 guesses, then the code is gone even if the right one arrives.
const good = lastCode('jay@example.com');
const bad = good === '000000' ? '111111' : '000000';
for (let i = 0; i < 5; i++) assert.equal((await call('/api/auth/verify', {body: {email: 'jay@example.com', code: bad}})).status, 400);
assert.equal((await call('/api/auth/verify', {body: {email: 'jay@example.com', code: good}})).status, 400, 'locked after 5 wrong guesses');

// Per-email send limit (3 per 15 minutes). One send already used above.
await call('/api/auth/start', {body: {email: 'jay@example.com'}});
await call('/api/auth/start', {body: {email: 'jay@example.com'}});
assert.equal((await call('/api/auth/start', {body: {email: 'jay@example.com'}})).status, 429, 'per-email send limit');
await DB.prepare("DELETE FROM auth_events").bind().run();

// Expired code is rejected.
await call('/api/auth/start', {body: {email: 'jay@example.com'}});
const exp = lastCode('jay@example.com');
await DB.prepare('UPDATE login_codes SET expires_at = ? WHERE email = ?').bind(Date.now() - 1, 'jay@example.com').run();
assert.equal((await call('/api/auth/verify', {body: {email: 'jay@example.com', code: exp}})).status, 400, 'expired code');

// Codes are single-use and tied to one email.
await call('/api/auth/start', {body: {email: 'jay@example.com'}});
const once = lastCode('jay@example.com');
assert.equal((await call('/api/auth/verify', {body: {email: 'other@example.com', code: once}})).status, 400, 'code only works for its email');
r = await call('/api/auth/verify', {body: {email: 'jay@example.com', code: once}});
assert.equal(r.status, 200);
const setCookie = r.headers.get('set-cookie');
assert.match(setCookie, /^__Host-tc_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000$/);
assert.equal((await call('/api/auth/verify', {body: {email: 'jay@example.com', code: once}})).status, 400, 'single use');
const jay = cookieFrom(r);

// The session works for the API and the course files.
r = await call('/api/me', {cookie: jay});
assert.equal(r.status, 200);
assert.equal((await r.json()).isTeacher, true);
assert.equal(await (await call('/app.js', {cookie: jay})).text(), 'asset:/app.js');

// Without a session: pages go to sign-in, files and API are refused, nothing is served.
const before = served.length;
r = await call('/');
assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/signin/');
r = await call('/app.js?v=1');
assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/signin/?next=%2Fapp.js%3Fv%3D1');
assert.equal((await call('/api/me')).status, 401);
for(const file of ['/shorts.html','/shorts.js','/shorts.css','/shorts-catalog.js','/media/shorts/B01_01_What_Are_You_Buying_Adam_Tyler.mp4'])assert.equal((await call(file)).status,302,'Shorts assets need a session');
for(const route of ['/api/shorts','/api/shorts/media?id=seed-01'])assert.equal((await call(route)).status,401,'Shorts API needs a session');
assert.equal((await call('/api/me', {cookie: '__Host-tc_session=forged-token'})).status, 401);
assert.equal((await call('/api/me', {headers: {'oai-authenticated-user-id': 'x', 'oai-authenticated-user-email': 'jay@example.com', 'cf-access-jwt-assertion': 'x.y.z'}})).status, 401, 'old identity headers are ignored');
assert.equal(served.length, before, 'no course file served without a session');
assert.equal(await (await call('/signin/')).text(), 'asset:/signin/', 'sign-in page is public');
assert.equal(await (await call('/fonts/manrope-latin-wght-normal.woff2')).text(), 'asset:/fonts/manrope-latin-wght-normal.woff2');
r = await call('/signin/?next=//evil.example', {cookie: jay});
assert.equal(r.headers.get('location'), APP + '/', 'next cannot leave the site');

// Narration audio: signed-in only, full file and byte ranges.
const clip = new Uint8Array(1000).map((_, i) => i % 256);
env.AUDIO = {
  head: async k => k === 'basics/deal-b.mp3' ? {size: clip.length} : null,
  get: async (k, o) => { if (k !== 'basics/deal-b.mp3') return null; const s = o?.range ? clip.slice(o.range.offset, o.range.offset + o.range.length) : clip; return {body: s, size: clip.length}; },
};
assert.equal((await call('/audio/basics/deal-b.mp3')).status, 401, 'audio needs a session');
r = await call('/audio/basics/deal-b.mp3', {cookie: jay});
assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/mpeg'); assert.equal((await r.arrayBuffer()).byteLength, 1000);
r = await call('/audio/basics/deal-b.mp3', {cookie: jay, headers: {range: 'bytes=100-199'}});
assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), 'bytes 100-199/1000'); assert.equal(new Uint8Array(await r.arrayBuffer())[0], 100);
assert.equal((await call('/audio/basics/deal-b.mp3', {cookie: jay, headers: {range: 'bytes=5000-'}})).status, 416);
assert.equal((await call('/audio/basics/..%2Fsecret.mp3', {cookie: jay})).status, 404);
assert.equal((await call('/audio/basics/missing-a.mp3', {cookie: jay})).status, 404);

// Cross-site posts are refused.
assert.equal((await worker.fetch(new Request(APP + '/api/auth/start', {method: 'POST', headers: {'content-type': 'application/json', origin: 'https://evil.example'}, body: '{"email":"jay@example.com"}'}), env)).status, 403);

// Invites: Jay adds a learner, the learner signs in; removing them ends access immediately.
r = await call('/api/learners', {cookie: jay, body: {name: 'Sam', email: 'Sam@Example.com', assignedTrack: 'futures'}});
assert.equal(r.status, 200);
const sam = await signIn('sam@example.com');
r = await call('/api/me', {cookie: sam});
assert.equal((await r.json()).isTeacher, false);
assert.equal((await call('/api/learners', {cookie: sam})).status, 403, 'learners cannot manage others');
// Preview tools are unavailable to learners through both the API and direct assets.
for (const path of ['/coach/index.js','/coach/coach.css','/playbook/index.js','/playbook/playbook.css','/%63oach/engine.js']) {
 assert.equal((await call(path,{cookie:sam})).status,403,path+' is owner-only');
 assert.equal((await call(path,{cookie:jay})).status,200,path+' stays available to owner');
}
assert.equal((await call('/api/playbooks',{cookie:sam})).status,403);
assert.equal((await call('/api/playbooks',{cookie:sam,body:{isTeacher:true}})).status,403,'client role cannot grant preview access');
assert.equal((await call('/api/playbooks',{cookie:jay})).status,200);
assert.equal((await call('/api/profile',{cookie:sam,body:{name:'Sam Learner',track:'futures'}})).status,200,'learner can still edit their own profile');

const list = (await (await call('/api/learners', {cookie: jay})).json()).learners;
const samRow = list.find(p => p.email === 'sam@example.com');
assert.equal(samRow.isTeacher, false);
assert.equal((await call('/api/learners', {cookie: sam, body: {action: 'remove', id: samRow.id}})).status, 403);
r = await call('/api/learners', {cookie: jay, body: {action: 'remove', id: samRow.id}});
assert.equal(r.status, 200);
assert.equal((await call('/api/me', {cookie: sam})).status, 401, 'removed learner is signed out');
await call('/api/auth/start', {body: {email: 'sam@example.com'}});
assert.equal(lastCode('sam@example.com'), sent.filter(s => s.to[0] === 'sam@example.com').at(-1) && lastCode('sam@example.com'));
assert.equal(sent.filter(s => s.to[0] === 'sam@example.com').length, 1, 'removed learner gets no new code');
const jayRow = list.find(p => p.email === 'jay@example.com');
assert.equal((await call('/api/learners', {cookie: jay, body: {action: 'remove', id: jayRow.id}})).status, 400, 'cannot remove yourself');

// Email failure: no code left behind.
await DB.prepare("DELETE FROM auth_events").bind().run();
resendOk = false;
assert.equal((await call('/api/auth/start', {body: {email: 'jay@example.com'}})).status, 502);
assert.equal((await DB.prepare('SELECT COUNT(*) AS n FROM login_codes WHERE email = ?').bind('jay@example.com').all()).results[0].n, 0);
resendOk = true;

// Sign out removes the session.
r = await call('/signout', {cookie: jay});
assert.equal(r.status, 302); assert.equal(r.headers.get('location'), 'https://thecandle.io/');
assert.match(r.headers.get('set-cookie'), /Max-Age=0/);
assert.equal((await call('/api/me', {cookie: jay})).status, 401, 'signed out');

// Per-network limit on code checks.
await DB.prepare("DELETE FROM auth_events").bind().run();
for (let i = 0; i < 40; i++) await call('/api/auth/verify', {ip: '9.9.9.9', body: {email: 'jay@example.com', code: '123456'}});
assert.equal((await call('/api/auth/verify', {ip: '9.9.9.9', body: {email: 'jay@example.com', code: '123456'}})).status, 429, 'per-network check limit');

// Public homepage and www.
const home = r => worker.fetch(new Request('https://thecandle.io' + r), env);
assert.equal(await (await home('/')).text(), 'asset:/home/');
assert.equal((await home('/app.js')).status, 302);
assert.equal((await home('/api/me')).status, 404);
r = await worker.fetch(new Request('https://www.thecandle.io/x'), env);
assert.equal(r.status, 301); assert.equal(r.headers.get('location'), 'https://thecandle.io/x');

console.log('PASS: sign-in codes (invite-only, hashed, 10-minute expiry, 5 guesses, single use, per-email and per-network limits), secure session cookie, course files and API need a session, removal ends access, sign-out, cross-site and redirect protection, public homepage routing, signed-in audio with byte ranges.');
