// The Candle sign-in: email one-time codes and sessions.
//
// Who can sign in: TEACHER_EMAIL, plus any email Jay has added as a learner profile.
// Codes: 6 digits, stored only as a keyed hash, expire after 10 minutes, 5 guesses each.
// Limits: per email and per network, on both sending codes and checking them.
// Sessions: random 256-bit token in an HttpOnly, Secure, SameSite=Lax cookie; only its hash is stored.
//
// Required secrets (set with `npx wrangler secret put NAME`, never in a file):
//   AUTH_SECRET     long random string used to hash codes
//   RESEND_API_KEY  API key from resend.com for sending the code emails
// Settings in wrangler.toml: MAIL_FROM, TEACHER_EMAIL.

import {OWNER_EMAIL} from './db/profiles.js';
import {membershipAllows} from './billing.js';

export const COOKIE = '__Host-tc_session';
const CODE_TTL = 10 * 60 * 1000;
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000;
const MAX_GUESSES = 5;
const LIMITS = {
  sendEmail: [3, 15 * 60 * 1000],      // 3 codes per email per 15 minutes
  sendEmailDay: [10, 24 * 60 * 60 * 1000],
  sendIp: [20, 60 * 60 * 1000],        // 20 code requests per network per hour
  verifyIp: [40, 60 * 60 * 1000],      // 40 code checks per network per hour
};
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha256 = async s => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const first = async stmt => (await stmt.all()).results[0];
const noStore = {'Cache-Control': 'no-store'};
const json = (data, status = 200, headers = {}) => Response.json(data, {status, headers: {...noStore, ...headers}});

export const normalizeEmail = v => String(v || '').trim().toLowerCase();
const validEmail = e => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
const teacherEmail = env => normalizeEmail(env.TEACHER_EMAIL || OWNER_EMAIL);

function equal(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sixDigits() {
  const max = Math.floor(0xFFFFFFFF / 1e6) * 1e6, buf = new Uint32Array(1);
  do crypto.getRandomValues(buf); while (buf[0] >= max);
  return String(buf[0] % 1e6).padStart(6, '0');
}

const codeHash = (env, email, code) => sha256(`${env.AUTH_SECRET}|${email}|${code}`);

async function limited(db, key, [max, windowMs], now) {
  const row = await first(db.prepare('SELECT COUNT(*) AS n FROM auth_events WHERE key = ? AND at > ?').bind(key, now - windowMs));
  return Number(row?.n || 0) >= max;
}
const note = (db, key, now) => db.prepare('INSERT INTO auth_events (key, at) VALUES (?, ?)').bind(key, now).run();

// Who may sign in: the teacher; an invited learner (profile, no Stripe record); or a paying member
// whose Stripe membership is active. A canceled or unpaid membership closes the door, even with a profile.
async function allowed(db, env, email) {
  if (email === teacherEmail(env)) return true;
  if (!await first(db.prepare('SELECT id FROM learner_profiles WHERE email = ?').bind(email))) return false;
  const member = await membershipAllows(db, email);
  return member === null ? true : member;
}

function cookieValue(request) {
  const raw = (request.headers.get('cookie') || '').split(/;\s*/).find(c => c.startsWith(COOKIE + '='));
  return raw ? raw.slice(COOKIE.length + 1) : '';
}
const setCookie = (token, maxAgeSec) => `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;

function sameOrigin(request) {
  const url = new URL(request.url), origin = request.headers.get('origin');
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  return !origin || origin === url.origin;
}

async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) return null;
  const raw = await request.text();
  if (raw.length > 2000) return null;
  try { const b = JSON.parse(raw); return b && typeof b === 'object' && !Array.isArray(b) ? b : null; } catch { return null; }
}

function emailContent(code) {
  const text = `Your sign-in code for The Candle is ${code}\n\nIt expires in 10 minutes. If you didn't ask to sign in, you can ignore this email.\n\nThe Candle by Jay Hasan`;
  const html = `<!doctype html><html><body style="margin:0;background:#111512;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#f0f2eb">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#191e1a;border:1px solid #2c342c;border-radius:16px">
<tr><td style="padding:28px 28px 8px;font-size:20px;font-weight:800;letter-spacing:-.02em;color:#f0f2eb"><span style="color:#f0f2eb">The</span> <span style="color:#b9ef7a">Candle</span></td></tr>
<tr><td style="padding:8px 28px 0;font-size:16px;line-height:1.6;color:#d2d8cc">Here’s your sign-in code:</td></tr>
<tr><td style="padding:16px 28px"><div style="font-size:36px;font-weight:800;letter-spacing:.3em;color:#111512;background:#b9ef7a;border-radius:12px;padding:14px 0;text-align:center">${code}</div></td></tr>
<tr><td style="padding:0 28px 28px;font-size:14px;line-height:1.6;color:#a1aaa0">It expires in 10 minutes. If you didn’t ask to sign in, you can ignore this email.</td></tr>
</table>
<p style="font-size:12px;color:#7c857b;margin:18px 0 0">The Candle by Jay Hasan</p>
</td></tr></table></body></html>`;
  return {text, html};
}

async function sendCode(env, email, code, fetchImpl) {
  const {text, html} = emailContent(code);
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: {'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json'},
    body: JSON.stringify({from: env.MAIL_FROM || 'The Candle <signin@thecandle.io>', to: [email], subject: `${code} is your The Candle sign-in code`, text, html}),
  });
  return res.ok;
}

// Handles /api/auth/start, /api/auth/verify, and /signout. Returns null for other paths.
export async function handleAuth(request, env, fetchImpl = fetch) {
  const url = new URL(request.url), path = url.pathname, db = env.DB, now = Date.now();
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';

  if (path === '/signout') {
    const token = cookieValue(request);
    if (token) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
    return new Response(null, {status: 302, headers: {Location: `https://${env.PUBLIC_HOST || 'thecandle.io'}/`, 'Set-Cookie': setCookie('', 0), ...noStore}});
  }
  if (path !== '/api/auth/start' && path !== '/api/auth/verify') return null;
  if (request.method !== 'POST') return json({error: 'Use the sign-in form.'}, 405);
  if (!sameOrigin(request)) return json({error: 'Please sign in from The Candle.'}, 403);
  if (!env.AUTH_SECRET || !env.RESEND_API_KEY) return json({error: 'Sign-in email is not set up yet. Ask Jay.'}, 503);
  const body = await readBody(request);
  if (!body) return json({error: 'Invalid request.'}, 400);
  const email = normalizeEmail(body.email);
  if (!validEmail(email)) return json({error: 'Enter a valid email address.'}, 400);
  await db.prepare('DELETE FROM auth_events WHERE at < ?').bind(now - 24 * 60 * 60 * 1000).run();

  if (path === '/api/auth/start') {
    if (await limited(db, 'send-ip:' + ip, LIMITS.sendIp, now)) return json({error: 'Too many requests. Try again later.'}, 429);
    await note(db, 'send-ip:' + ip, now);
    const sent = {ok: true, message: 'If that email is invited, a code is on its way.'};
    if (!await allowed(db, env, email)) return json(sent);
    if (await limited(db, 'send:' + email, LIMITS.sendEmail, now) || await limited(db, 'send:' + email, LIMITS.sendEmailDay, now)) return json({error: 'A code was sent recently. Check your inbox, or try again in a few minutes.'}, 429);
    await note(db, 'send:' + email, now);
    const code = sixDigits();
    await db.prepare('INSERT INTO login_codes (email, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at')
      .bind(email, await codeHash(env, email, code), now + CODE_TTL, now).run();
    let ok = false;
    try { ok = await sendCode(env, email, code, fetchImpl); } catch { ok = false; }
    if (!ok) { await db.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run(); return json({error: 'We could not send the email. Try again in a minute.'}, 502); }
    return json(sent);
  }

  // /api/auth/verify
  if (await limited(db, 'verify-ip:' + ip, LIMITS.verifyIp, now)) return json({error: 'Too many attempts. Try again later.'}, 429);
  await note(db, 'verify-ip:' + ip, now);
  const code = String(body.code || '').replace(/\D/g, '');
  const wrong = json({error: 'That code is not right, or it has expired. Check it, or send a new one.'}, 400);
  if (code.length !== 6) return wrong;
  const row = await first(db.prepare('SELECT code_hash, expires_at, attempts FROM login_codes WHERE email = ?').bind(email));
  if (!row) return wrong;
  if (row.expires_at < now || row.attempts >= MAX_GUESSES) { await db.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run(); return wrong; }
  if (!equal(row.code_hash, await codeHash(env, email, code))) {
    await db.prepare('UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?').bind(email).run();
    if (row.attempts + 1 >= MAX_GUESSES) await db.prepare('DELETE FROM login_codes WHERE email = ?').bind(email).run();
    return wrong;
  }
  // Success: the code is single-use.
  const used = await db.prepare('DELETE FROM login_codes WHERE email = ? AND code_hash = ?').bind(email, row.code_hash).run();
  if (!((used.meta?.changes ?? used.changes ?? 0) > 0)) return wrong;
  if (!await allowed(db, env, email)) return wrong;
  const profile = await first(db.prepare('SELECT user_id FROM learner_profiles WHERE email = ?').bind(email));
  const userId = profile?.user_id || 'user:' + crypto.randomUUID();
  const tokenBytes = new Uint8Array(32); crypto.getRandomValues(tokenBytes);
  const token = b64url(tokenBytes);
  await db.prepare('INSERT INTO sessions (token_hash, user_id, email, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(await sha256(token), userId, email, now, now + SESSION_TTL).run();
  await db.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now).run();
  return json({ok: true}, 200, {'Set-Cookie': setCookie(token, SESSION_TTL / 1000)});
}

// Returns {id, email, name} for a valid session cookie, or null.
export async function sessionUser(request, env) {
  const token = cookieValue(request);
  if (!token || token.length > 100) return null;
  const row = await first(env.DB.prepare('SELECT user_id, email, expires_at FROM sessions WHERE token_hash = ?').bind(await sha256(token)));
  if (!row || row.expires_at < Date.now()) return null;
  // Removing a learner's profile ends their access right away, even with an open session.
  if (!await allowed(env.DB, env, row.email)) return null;
  return {id: row.user_id, email: row.email, name: ''};
}
