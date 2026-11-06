// The Candle membership billing (Stripe).
//
// Plans: 'monthly' (Stripe subscription) and 'lifetime' (one-time payment). Each is a Stripe Price
// whose ID is set in wrangler.toml (STRIPE_PRICE_MONTHLY, STRIPE_PRICE_LIFETIME).
//
// Access rule (see auth.js allowed()):
//   - TEACHER_EMAIL always.
//   - A learner profile with NO memberships row is an invited/free learner (Jay added them).
//   - A memberships row exists only for Stripe-managed members; access follows its status.
//
// Flow: thecandle.io/join?plan=monthly → Stripe Checkout → thecandle.io/join/done → membership +
// learner profile created (also by the webhook, whichever arrives first; both are idempotent) →
// welcome email → learn.thecandle.io/signin with the usual email code.
//
// Required secrets (set with `npx wrangler secret put NAME`, never in a file):
//   STRIPE_SECRET_KEY       sk_test_… while testing, sk_live_… for launch
//   STRIPE_WEBHOOK_SECRET   whsec_… from the webhook endpoint in the Stripe dashboard
// Stripe is called over plain fetch (no SDK), so the Worker stays dependency-free.

const normalizeEmail = v => String(v || '').trim().toLowerCase();
const STRIPE = 'https://api.stripe.com/v1';
const PLANS = {monthly: {mode: 'subscription', priceVar: 'STRIPE_PRICE_MONTHLY'}, lifetime: {mode: 'payment', priceVar: 'STRIPE_PRICE_LIFETIME'}};
// Monthly starts with a free week: card taken at checkout, $0 today, first $29.99 charge on day 8 unless cancelled.
// A trial checkout completes with payment_status 'no_payment_required'; the subscription is 'trialing', which counts as active.
export const TRIAL_DAYS = 7;
const ACTIVE = new Set(['active', 'trialing', 'past_due']); // past_due keeps access during Stripe's retry window
const WEBHOOK_TOLERANCE = 5 * 60; // seconds
const noStore = {'Cache-Control': 'no-store'};
const first = async stmt => (await stmt.all()).results[0];
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

const schema = [
  'CREATE TABLE IF NOT EXISTS memberships (email TEXT PRIMARY KEY NOT NULL, plan TEXT NOT NULL, status TEXT NOT NULL, stripe_customer_id TEXT, stripe_subscription_id TEXT, current_period_end INTEGER, cancel_at_period_end INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_memberships_customer ON memberships (stripe_customer_id)',
  'CREATE INDEX IF NOT EXISTS idx_memberships_subscription ON memberships (stripe_subscription_id)',
  'CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL)',
];
const initialized = new WeakMap();
// Additive, idempotent initialization: the normal Workers deploy is sufficient (same pattern as learning.js).
export async function ensureBilling(db) {
  if (!initialized.has(db)) {
    const p = (async () => { for (const sql of schema) await db.prepare(sql).bind().run(); })();
    initialized.set(db, p);
    p.catch(() => initialized.delete(db));
  }
  return initialized.get(db);
}

export const billingConfigured = env => !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_MONTHLY && env.STRIPE_PRICE_LIFETIME);

// ---- Access -------------------------------------------------------------------------------------

export async function membershipFor(db, email) {
  await ensureBilling(db);
  return first(db.prepare('SELECT * FROM memberships WHERE email = ?').bind(email)) || null;
}

// null → no Stripe record (invited learner rules apply); true/false → Stripe membership decides.
export async function membershipAllows(db, email) {
  const m = await membershipFor(db, email);
  if (!m) return null;
  return ACTIVE.has(m.status);
}

export const membershipView = m => m ? {plan: m.plan, status: m.status, renewsAt: m.current_period_end || null, cancelAtPeriodEnd: !!m.cancel_at_period_end, managed: true} : {plan: 'invited', status: 'active', renewsAt: null, cancelAtPeriodEnd: false, managed: false};

// Jay re-inviting someone whose paid membership ended makes them a free learner again.
export async function clearEndedMembership(db, email) {
  await ensureBilling(db);
  await db.prepare('DELETE FROM memberships WHERE email = ? AND status NOT IN (?, ?, ?)').bind(email, 'active', 'trialing', 'past_due').run();
}

// ---- Stripe API ---------------------------------------------------------------------------------

function form(obj, prefix = '') {
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => parts.push(typeof item === 'object' ? form(item, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`));
    else if (typeof v === 'object') parts.push(form(v, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

async function stripe(env, fetchImpl, method, path, body, idempotencyKey) {
  const headers = {'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`, 'Stripe-Version': '2024-06-20'};
  if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetchImpl(STRIPE + path, {method, headers, body: body ? form(body) : undefined});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data?.error?.message || `Stripe ${res.status}`), {status: res.status, stripe: data?.error});
  return data;
}

// ---- Webhook signature --------------------------------------------------------------------------

export async function verifyStripeSignature(payload, header, secret, now = Date.now() / 1000) {
  if (!header || !secret) return false;
  let t = null; const sigs = [];
  for (const part of header.split(',')) {
    const [k, v] = part.trim().split('=');
    if (k === 't') t = Number(v); else if (k === 'v1' && v) sigs.push(v);
  }
  if (!t || !sigs.length || Math.abs(now - t) > WEBHOOK_TOLERANCE) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${payload}`)));
  return sigs.some(s => s.length === expected.length && timingSafeEqual(s, expected));
}
function timingSafeEqual(a, b) { let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

// ---- Fulfillment --------------------------------------------------------------------------------

function welcomeEmail(env) {
  const signin = `https://${env.APP_HOST || 'learn.thecandle.io'}/signin/`;
  const text = `Welcome to The Candle.\n\nYou're in. Sign in any time at ${signin} — enter this email address and we'll send you a 6-digit code. No password needed.\n\nStart with the Futures course: one idea at a time, with practice charts and your own Wick Log.\n\nQuestions? Reply to this email or write to support@thecandle.io.\n\nThe Candle by Jay Hasan`;
  const html = `<!doctype html><html><body style="margin:0;background:#111512;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#f0f2eb">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#191e1a;border:1px solid #2c342c;border-radius:16px">
<tr><td style="padding:28px 28px 8px;font-size:20px;font-weight:800;letter-spacing:-.02em"><span style="color:#f0f2eb">The</span> <span style="color:#b9ef7a">Candle</span></td></tr>
<tr><td style="padding:8px 28px 0;font-size:22px;font-weight:800;color:#f0f2eb">Welcome. You’re in.</td></tr>
<tr><td style="padding:12px 28px 0;font-size:16px;line-height:1.6;color:#d2d8cc">Sign in any time with this email address — we’ll send you a 6-digit code. No password needed.</td></tr>
<tr><td style="padding:20px 28px"><a href="${signin}" style="display:block;text-align:center;font-size:17px;font-weight:700;color:#111512;background:#b9ef7a;border-radius:999px;padding:14px 20px;text-decoration:none">Sign in to The Candle</a></td></tr>
<tr><td style="padding:0 28px 8px;font-size:15px;line-height:1.6;color:#d2d8cc">Start with the Futures course: one idea at a time, with practice charts and your own Wick Log.</td></tr>
<tr><td style="padding:8px 28px 28px;font-size:14px;line-height:1.6;color:#a1aaa0">Questions? Reply to this email or write to support@thecandle.io.</td></tr>
</table>
<p style="font-size:12px;color:#7c857b;margin:18px 0 0">The Candle by Jay Hasan · Education only, not financial advice.</p>
</td></tr></table></body></html>`;
  return {text, html};
}

// Stripe sends receipts and the trial reminder; it has no cancellation email, so The Candle sends its own.
function cancelEmail(env, {endsAt, trial}) {
  const when = endsAt ? new Date(endsAt).toLocaleDateString('en-US', {month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago'}) : null;
  const what = trial ? 'Your free week is cancelled' : 'Your membership is cancelled';
  const access = when ? `You keep full access until ${when}.` : 'Your access has ended.';
  const charge = trial ? 'You won’t be charged.' : 'You won’t be charged again.';
  const back = `Changed your mind? You can rejoin any time at https://${env.PUBLIC_HOST || 'thecandle.io'}.`;
  const text = `${what}.\n\n${access} ${charge}\n\n${back}\n\nQuestions? Reply to this email or write to support@thecandle.io.\n\nThe Candle by Jay Hasan`;
  const html = `<!doctype html><html><body style="margin:0;background:#111512;padding:32px 16px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#f0f2eb">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:460px;background:#191e1a;border:1px solid #2c342c;border-radius:16px">
<tr><td style="padding:28px 28px 8px;font-size:20px;font-weight:800;letter-spacing:-.02em"><span style="color:#f0f2eb">The</span> <span style="color:#b9ef7a">Candle</span></td></tr>
<tr><td style="padding:8px 28px 0;font-size:22px;font-weight:800;color:#f0f2eb">${what}.</td></tr>
<tr><td style="padding:12px 28px 0;font-size:16px;line-height:1.6;color:#d2d8cc">${access} ${charge}</td></tr>
<tr><td style="padding:12px 28px 0;font-size:15px;line-height:1.6;color:#d2d8cc">Changed your mind? You can rejoin any time.</td></tr>
<tr><td style="padding:20px 28px"><a href="https://${env.PUBLIC_HOST || 'thecandle.io'}/#pricing" style="display:block;text-align:center;font-size:17px;font-weight:700;color:#111512;background:#b9ef7a;border-radius:999px;padding:14px 20px;text-decoration:none">Back to The Candle</a></td></tr>
<tr><td style="padding:0 28px 28px;font-size:14px;line-height:1.6;color:#a1aaa0">Questions? Reply to this email or write to support@thecandle.io.</td></tr>
</table>
<p style="font-size:12px;color:#7c857b;margin:18px 0 0">The Candle by Jay Hasan · Education only, not financial advice.</p>
</td></tr></table></body></html>`;
  return {subject: `${what} — The Candle`, text, html};
}

async function sendMail(env, email, {subject, text, html}, fetchImpl) {
  if (!env.RESEND_API_KEY) return false;
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {'Authorization': `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json'},
      body: JSON.stringify({from: env.MAIL_FROM || 'The Candle <signin@thecandle.io>', reply_to: 'support@thecandle.io', to: [email], subject, text, html}),
    });
    return res.ok;
  } catch { return false; }
}
const sendWelcome = (env, email, fetchImpl) => sendMail(env, email, {subject: 'Welcome to The Candle — you’re in', ...welcomeEmail(env)}, fetchImpl);

// Records a paid membership and makes sure a learner profile exists. Safe to call more than once.
// Returns true the first time this email became a member (so the welcome email goes out once).
export async function fulfill(db, env, {email, plan, customerId, subscriptionId, status, periodEnd, cancelAtPeriodEnd, name}, fetchImpl = fetch) {
  await ensureBilling(db);
  email = normalizeEmail(email);
  const now = Date.now();
  const existing = await first(db.prepare('SELECT email FROM memberships WHERE email = ?').bind(email));
  await db.prepare(`INSERT INTO memberships (email, plan, status, stripe_customer_id, stripe_subscription_id, current_period_end, cancel_at_period_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET plan = excluded.plan, status = excluded.status, stripe_customer_id = COALESCE(excluded.stripe_customer_id, memberships.stripe_customer_id),
      stripe_subscription_id = COALESCE(excluded.stripe_subscription_id, memberships.stripe_subscription_id), current_period_end = excluded.current_period_end,
      cancel_at_period_end = excluded.cancel_at_period_end, updated_at = excluded.updated_at`)
    .bind(email, plan, status, customerId || null, subscriptionId || null, periodEnd || null, cancelAtPeriodEnd ? 1 : 0, now, now).run();
  const iso = new Date(now).toISOString();
  const displayName = String(name || '').trim().slice(0, 60) || email.split('@')[0];
  await db.prepare('INSERT INTO learner_profiles (id, email, name, assigned_track, onboarded, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING')
    .bind(crypto.randomUUID(), email, displayName, 'futures', 'no', iso, iso).run();
  const isNew = !existing;
  if (isNew) await sendWelcome(env, email, fetchImpl);
  return isNew;
}

// Stripe API versions from 2025 put current_period_end on the subscription item instead of the subscription.
function periodEndOf(sub) {
  const secs = sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end;
  return secs ? secs * 1000 : null;
}

// Sends the cancellation email once: when a cancellation is scheduled (cancel at period end, or a cancel_at date as
// newer billing modes use), or when the subscription ends without one having been scheduled first.
async function updateFromSubscription(db, sub, env = {}, fetchImpl = fetch) {
  await ensureBilling(db);
  const periodEnd = periodEndOf(sub);
  const prev = await first(db.prepare('SELECT email, status, cancel_at_period_end FROM memberships WHERE stripe_subscription_id = ?').bind(sub.id));
  const scheduled = !!(sub.cancel_at_period_end || sub.cancel_at);
  await db.prepare('UPDATE memberships SET status = ?, current_period_end = ?, cancel_at_period_end = ?, updated_at = ? WHERE stripe_subscription_id = ?')
    .bind(sub.status, periodEnd, scheduled ? 1 : 0, Date.now(), sub.id).run();
  if (!prev) return;
  const nowScheduled = scheduled && !prev.cancel_at_period_end;
  const endedUnannounced = sub.status === 'canceled' && prev.status !== 'canceled' && !prev.cancel_at_period_end;
  if (nowScheduled || endedUnannounced) {
    const endsAt = sub.status === 'canceled' ? null : (sub.cancel_at ? sub.cancel_at * 1000 : periodEnd);
    await sendMail(env, prev.email, cancelEmail(env, {endsAt, trial: sub.status === 'trialing'}), fetchImpl);
  }
}

// Turns a completed Checkout Session (expanded with subscription) into a membership.
async function fulfillSession(db, env, session, fetchImpl) {
  if (session.payment_status !== 'paid' && session.status !== 'complete') return false;
  const email = session.customer_details?.email || session.customer_email;
  const plan = PLANS[session.metadata?.plan] ? session.metadata.plan : (session.mode === 'subscription' ? 'monthly' : 'lifetime');
  if (!email) return false;
  const sub = session.subscription && typeof session.subscription === 'object' ? session.subscription : null;
  const subscriptionId = sub ? sub.id : (typeof session.subscription === 'string' ? session.subscription : null);
  const customerId = typeof session.customer === 'string' ? session.customer : session.customer?.id || null;
  return fulfill(db, env, {
    email, plan, customerId, subscriptionId,
    status: sub ? sub.status : (session.payment_status === 'paid' ? 'active' : 'incomplete'),
    periodEnd: periodEndOf(sub),
    cancelAtPeriodEnd: !!sub?.cancel_at_period_end,
    name: session.customer_details?.name,
  }, fetchImpl);
}

// ---- HTTP handlers ------------------------------------------------------------------------------

const page = (title, body, status = 200) => new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · The Candle</title>
<style>body{margin:0;background:#111512;color:#f0f2eb;font-family:'DM Sans',-apple-system,Segoe UI,Helvetica,Arial,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}
main{max-width:460px;background:#191e1a;border:1px solid #343b32;border-radius:20px;padding:32px}h1{font-family:Georgia,'Times New Roman',serif;font-size:30px;margin:0 0 12px}p{color:#b0b6aa;line-height:1.6;margin:0 0 14px}
a.btn{display:inline-block;margin-top:8px;background:#b9ef7a;color:#111512;font-weight:700;text-decoration:none;border-radius:999px;padding:12px 22px}a{color:#b9ef7a}</style></head><body><main>${body}</main></body></html>`,
  {status, headers: {'Content-Type': 'text/html; charset=utf-8', ...noStore}});

// Public host: /join, /join/done. Returns null for other paths.
export async function handleJoin(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  const publicHost = env.PUBLIC_HOST || 'thecandle.io', appHost = env.APP_HOST || 'learn.thecandle.io';
  if (url.pathname === '/join') {
    if (request.method !== 'GET') return new Response('Method not allowed', {status: 405, headers: noStore});
    const plan = PLANS[url.searchParams.get('plan')] ? url.searchParams.get('plan') : null;
    if (!plan) return Response.redirect(`https://${publicHost}/#pricing`, 302);
    if (!billingConfigured(env)) return page('Not open yet', `<h1>Membership opens soon</h1><p>Payments aren’t switched on yet. Write to <a href="mailto:support@thecandle.io">support@thecandle.io</a> and we’ll let you know when The Candle opens.</p><a class="btn" href="https://${publicHost}/">Back to the homepage</a>`, 503);
    const spec = PLANS[plan];
    try {
      const session = await stripe(env, fetchImpl, 'POST', '/checkout/sessions', {
        mode: spec.mode,
        line_items: [{price: env[spec.priceVar], quantity: 1}],
        success_url: `https://${publicHost}/join/done?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `https://${publicHost}/#pricing`,
        allow_promotion_codes: 'true',
        billing_address_collection: 'auto',
        metadata: {plan},
        ...(spec.mode === 'payment' ? {customer_creation: 'always', payment_intent_data: {description: 'The Candle — lifetime membership'}} : {subscription_data: {metadata: {plan}, trial_period_days: TRIAL_DAYS}}),
      });
      return new Response(null, {status: 303, headers: {Location: session.url, ...noStore}});
    } catch (e) {
      // Never log the secret key; the Stripe error message and type are enough to diagnose.
      console.error('billing: checkout session failed', JSON.stringify({plan, status: e?.status, type: e?.stripe?.type, code: e?.stripe?.code, param: e?.stripe?.param, message: e?.message}));
      return page('Something went wrong', `<h1>We couldn’t start checkout</h1><p>Please try again in a minute. If it keeps happening, write to <a href="mailto:support@thecandle.io">support@thecandle.io</a>.</p><a class="btn" href="https://${publicHost}/#pricing">Back to pricing</a>`, 502);
    }
  }
  if (url.pathname === '/join/done') {
    const id = url.searchParams.get('session_id') || '';
    if (!/^cs_[A-Za-z0-9_]+$/.test(id) || !billingConfigured(env)) return Response.redirect(`https://${publicHost}/`, 302);
    let session;
    try { session = await stripe(env, fetchImpl, 'GET', `/checkout/sessions/${id}?expand[]=subscription`); } catch { session = null; }
    if (!session) return page('Almost there', `<h1>We’re confirming your payment</h1><p>Give it a minute, then check your email for a welcome message from The Candle. If nothing arrives, write to <a href="mailto:support@thecandle.io">support@thecandle.io</a>.</p>`, 200);
    const paid = session.payment_status === 'paid' || session.status === 'complete';
    if (paid) { try { await fulfillSession(env.DB, env, session, fetchImpl); } catch {} }
    const email = session.customer_details?.email || '';
    if (!paid) return page('Not finished', `<h1>Payment not completed</h1><p>Your card wasn’t charged. You can try again whenever you’re ready.</p><a class="btn" href="https://${publicHost}/#pricing">Back to pricing</a>`, 200);
    return page('Welcome', `<h1>Welcome to The Candle 🕯️</h1><p>You’re in. We sent a welcome note to <strong style="color:#f0f2eb">${escapeHtml(email)}</strong>.</p><p>Sign in with that email — we’ll send a 6-digit code. No password needed.</p><a class="btn" href="https://${appHost}/signin/?email=${encodeURIComponent(email)}">Sign in to start</a>`, 200);
  }
  return null;
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

// Public host: POST /api/billing/webhook (Stripe → The Candle).
export async function handleWebhook(request, env, fetchImpl = fetch) {
  if (request.method !== 'POST') return new Response('Method not allowed', {status: 405, headers: noStore});
  if (!env.STRIPE_WEBHOOK_SECRET || !env.DB) return new Response('Webhook not configured', {status: 503, headers: noStore});
  const payload = await request.text();
  if (payload.length > 200000) return new Response('Too large', {status: 413, headers: noStore});
  if (!await verifyStripeSignature(payload, request.headers.get('stripe-signature'), env.STRIPE_WEBHOOK_SECRET)) return new Response('Bad signature', {status: 400, headers: noStore});
  let event; try { event = JSON.parse(payload); } catch { return new Response('Bad JSON', {status: 400, headers: noStore}); }
  if (!event?.id || !event?.type) return new Response('Bad event', {status: 400, headers: noStore});
  await ensureBilling(env.DB);
  const seen = await env.DB.prepare('INSERT INTO billing_events (id, type, at) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING').bind(event.id, event.type, Date.now()).run();
  if (!((seen.meta?.changes ?? seen.changes ?? 0) > 0)) return Response.json({received: true, duplicate: true}, {headers: noStore});
  const obj = event.data?.object || {};
  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      let session = obj;
      if (session.mode === 'subscription' && typeof session.subscription === 'string') {
        try { session = await stripe(env, fetchImpl, 'GET', `/checkout/sessions/${session.id}?expand[]=subscription`); } catch {}
      }
      await fulfillSession(env.DB, env, session, fetchImpl);
    } else if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
      await updateFromSubscription(env.DB, obj, env, fetchImpl);
    } else if (event.type === 'charge.refunded' && obj.customer && !obj.invoice) {
      // Refunded lifetime purchase: end access. Subscription refunds are handled by Stripe cancelling the subscription.
      await env.DB.prepare("UPDATE memberships SET status = 'canceled', updated_at = ? WHERE stripe_customer_id = ? AND plan = 'lifetime'").bind(Date.now(), obj.customer).run();
    }
  } catch (e) {
    // Let Stripe retry: forget this event id so the retry is processed.
    await env.DB.prepare('DELETE FROM billing_events WHERE id = ?').bind(event.id).run();
    return new Response('Retry', {status: 500, headers: noStore});
  }
  await env.DB.prepare('DELETE FROM billing_events WHERE at < ?').bind(Date.now() - 30 * 24 * 60 * 60 * 1000).run();
  return Response.json({received: true}, {headers: noStore});
}

// App host, signed in: GET /billing/portal → Stripe Customer Portal (update card, cancel, invoices).
export async function handlePortal(request, env, who, fetchImpl = fetch) {
  const m = await membershipFor(env.DB, who.email);
  const appHost = env.APP_HOST || 'learn.thecandle.io';
  if (!m?.stripe_customer_id || !env.STRIPE_SECRET_KEY) return Response.redirect(`https://${appHost}/#home`, 302);
  try {
    const portal = await stripe(env, fetchImpl, 'POST', '/billing_portal/sessions', {customer: m.stripe_customer_id, return_url: `https://${appHost}/#home`});
    return new Response(null, {status: 303, headers: {Location: portal.url, ...noStore}});
  } catch {
    return page('Unavailable', `<h1>Billing page unavailable</h1><p>Try again in a minute, or write to <a href="mailto:support@thecandle.io">support@thecandle.io</a>.</p><a class="btn" href="https://${appHost}/">Back to The Candle</a>`, 502);
  }
}
