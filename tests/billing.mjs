// The Candle membership billing: Stripe Checkout, webhooks, access gating, portal, idempotency.
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import worker from '../cloudflare-worker.js';
import {localDB} from '../db/local.js';
import {verifyStripeSignature} from '../billing.js';

const DB = localDB('/tmp/billing-test-' + crypto.randomUUID() + '.sqlite');
const PUB = 'https://thecandle.io', APP = 'https://learn.thecandle.io';
const WH = 'whsec_test_secret';
const env = {DB, ASSETS: {fetch: r => new Response('asset:' + new URL(r.url).pathname)}, AUTH_SECRET: 'test-secret-'.repeat(4), RESEND_API_KEY: 're_test', MAIL_FROM: 'The Candle <signin@thecandle.io>', TEACHER_EMAIL: 'jay@example.com', PUBLIC_HOST: 'thecandle.io', APP_HOST: 'learn.thecandle.io', STRIPE_SECRET_KEY: 'sk_test_123', STRIPE_WEBHOOK_SECRET: WH, STRIPE_PRICE_MONTHLY: 'price_month', STRIPE_PRICE_LIFETIME: 'price_life'};

// Fake Stripe + Resend.
const stripeCalls = [], mails = [];
const sessions = {};
globalThis.fetch = async (url, init = {}) => {
  if (url === 'https://api.resend.com/emails') { mails.push(JSON.parse(init.body)); return new Response('{}', {status: 200}); }
  assert.ok(url.startsWith('https://api.stripe.com/v1/'), 'only Stripe and Resend are called: ' + url);
  assert.equal(init.headers.Authorization, 'Bearer sk_test_123');
  const path = url.slice('https://api.stripe.com/v1'.length);
  stripeCalls.push({method: init.method, path, body: init.body});
  if (init.method === 'POST' && path === '/checkout/sessions') {
    const p = new URLSearchParams(init.body);
    return Response.json({id: 'cs_test_new', url: 'https://checkout.stripe.com/c/pay/cs_test_new', mode: p.get('mode')});
  }
  const m = /^\/checkout\/sessions\/(cs_[^?]+)/.exec(path);
  if (init.method === 'GET' && m) return sessions[m[1]] ? Response.json(sessions[m[1]]) : Response.json({error: {message: 'No such session'}}, {status: 404});
  if (init.method === 'POST' && path === '/billing_portal/sessions') { const p = new URLSearchParams(init.body); return Response.json({url: 'https://billing.stripe.com/session/' + p.get('customer')}); }
  return Response.json({error: {message: 'unexpected ' + path}}, {status: 500});
};

let ip = 0;
const call = (base, path, {body, cookie, method, headers = {}, raw} = {}) => worker.fetch(new Request(base + path, {
  method: method || (body || raw ? 'POST' : 'GET'), redirect: 'manual',
  headers: {...(body ? {'content-type': 'application/json', origin: base} : {}), ...(cookie ? {cookie} : {}), 'cf-connecting-ip': '10.1.0.' + (++ip % 250), ...headers},
  body: raw ?? (body ? JSON.stringify(body) : undefined),
}), env);
const signed = (payload, secret = WH, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
const webhook = (event, opts = {}) => { const raw = JSON.stringify(event); return call(PUB, '/api/billing/webhook', {raw, headers: {'stripe-signature': opts.sig ?? signed(raw, opts.secret, opts.t), 'content-type': 'application/json'}}); };
const lastCode = to => { const m = mails.filter(s => s.to[0] === to && /sign-in code/.test(s.subject)).at(-1); return m && m.text.match(/\b(\d{6})\b/)[1]; };
const cookieFrom = res => (res.headers.get('set-cookie') || '').split(';')[0];
async function start(email) { return call(APP, '/api/auth/start', {body: {email}}); }
async function signIn(email) {
  const s = await start(email); assert.equal(s.status, 200);
  const code = lastCode(email); assert.ok(code, 'a code was emailed to ' + email);
  const v = await call(APP, '/api/auth/verify', {body: {email, code}}); assert.equal(v.status, 200, 'sign-in for ' + email);
  return cookieFrom(v);
}
const membership = email => DB.sqlite.prepare('SELECT * FROM memberships WHERE email = ?').get(email);

// --- Signature verification -------------------------------------------------------------------
{
  const payload = '{"id":"evt_1"}';
  assert.equal(await verifyStripeSignature(payload, signed(payload), WH), true, 'valid signature');
  assert.equal(await verifyStripeSignature(payload, signed(payload, 'whsec_other'), WH), false, 'wrong secret');
  assert.equal(await verifyStripeSignature(payload + ' ', signed(payload), WH), false, 'tampered payload');
  assert.equal(await verifyStripeSignature(payload, signed(payload, WH, Math.floor(Date.now() / 1000) - 900), WH), false, 'stale timestamp');
  assert.equal(await verifyStripeSignature(payload, '', WH), false, 'missing header');
}

// --- Join: checkout redirect ---------------------------------------------------------------------
let r = await call(PUB, '/join?plan=monthly');
assert.equal(r.status, 303); assert.equal(r.headers.get('location'), 'https://checkout.stripe.com/c/pay/cs_test_new');
{
  const p = new URLSearchParams(stripeCalls.at(-1).body);
  assert.equal(p.get('mode'), 'subscription'); assert.equal(p.get('line_items[0][price]'), 'price_month');
  assert.equal(p.get('success_url'), 'https://thecandle.io/join/done?session_id={CHECKOUT_SESSION_ID}');
  assert.equal(p.get('metadata[plan]'), 'monthly');
  assert.equal(p.get('subscription_data[trial_period_days]'), '7', 'monthly starts with a free week');
}
r = await call(PUB, '/join?plan=lifetime'); assert.equal(r.status, 303);
assert.equal(new URLSearchParams(stripeCalls.at(-1).body).get('mode'), 'payment');
assert.equal(new URLSearchParams(stripeCalls.at(-1).body).get('subscription_data[trial_period_days]'), null, 'lifetime has no trial');
r = await call(PUB, '/join?plan=weekly'); assert.equal(r.status, 302, 'unknown plan goes back to pricing');
r = await worker.fetch(new Request(PUB + '/join?plan=monthly', {redirect: 'manual'}), {...env, STRIPE_SECRET_KEY: ''});
assert.equal(r.status, 503, 'not configured → honest "opens soon" page');
r = await call(PUB, '/api/billing/webhook'); assert.equal(r.status, 405, 'webhook is POST only');
assert.equal((await call(PUB, '/api/anything')).status, 404, 'other public /api paths still 404');

// --- A stranger cannot sign in before paying ------------------------------------------------------
mails.length = 0;
r = await start('buyer@example.com'); assert.equal(r.status, 200); assert.equal(mails.length, 0, 'no code before membership');

// --- Webhook: checkout.session.completed (subscription) creates membership + profile + welcome ------
const subSession = {id: 'cs_sub_1', object: 'checkout.session', mode: 'subscription', status: 'complete', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1', metadata: {plan: 'monthly'}, customer_details: {email: 'Buyer@Example.com', name: 'Buyer Person'}};
sessions['cs_sub_1'] = {...subSession, subscription: {id: 'sub_1', status: 'active', current_period_end: 1800000000, cancel_at_period_end: false}};
r = await webhook({id: 'evt_sub_1', type: 'checkout.session.completed', data: {object: subSession}});
assert.equal(r.status, 200);
let m = membership('buyer@example.com');
assert.ok(m, 'membership row'); assert.equal(m.plan, 'monthly'); assert.equal(m.status, 'active'); assert.equal(m.stripe_customer_id, 'cus_1'); assert.equal(m.stripe_subscription_id, 'sub_1'); assert.equal(m.current_period_end, 1800000000000);
const profile = DB.sqlite.prepare('SELECT * FROM learner_profiles WHERE email = ?').get('buyer@example.com');
assert.ok(profile, 'learner profile created'); assert.equal(profile.name, 'Buyer Person'); assert.equal(profile.assigned_track, 'futures');
const welcome = mails.find(x => x.to[0] === 'buyer@example.com' && /Welcome/.test(x.subject));
assert.ok(welcome, 'welcome email sent'); assert.equal(welcome.reply_to, 'support@thecandle.io'); assert.match(welcome.text, /learn\.thecandle\.io\/signin/);

// Redelivered event is a no-op (no second welcome).
r = await webhook({id: 'evt_sub_1', type: 'checkout.session.completed', data: {object: subSession}});
assert.equal((await r.json()).duplicate, true); assert.equal(mails.filter(x => /Welcome/.test(x.subject)).length, 1, 'one welcome email');

// Bad signature is rejected before anything is read.
r = await webhook({id: 'evt_bad', type: 'checkout.session.completed', data: {object: subSession}}, {secret: 'whsec_wrong'});
assert.equal(r.status, 400);

// --- The paying member can sign in and sees their membership --------------------------------------
const buyer = await signIn('buyer@example.com');
r = await call(APP, '/api/me', {cookie: buyer}); assert.equal(r.status, 200);
let me = await r.json();
assert.deepEqual(me.membership, {plan: 'monthly', status: 'active', renewsAt: 1800000000000, cancelAtPeriodEnd: false, managed: true});
assert.equal(me.profile.name, 'Buyer Person');

// Portal: signed-in member is sent to Stripe for their customer.
r = await call(APP, '/billing/portal', {cookie: buyer});
assert.equal(r.status, 303); assert.equal(r.headers.get('location'), 'https://billing.stripe.com/session/cus_1');
r = await call(APP, '/billing/portal'); assert.equal(r.status, 302); assert.match(r.headers.get('location'), /^\/signin\//, 'portal needs sign-in');

// --- Cancel at period end keeps access; subscription deleted ends it ------------------------------
// Newer Stripe API versions put current_period_end on the subscription item, not the subscription.
r = await webhook({id: 'evt_upd_1', type: 'customer.subscription.updated', data: {object: {id: 'sub_1', status: 'active', cancel_at_period_end: true, items: {data: [{id: 'si_1', current_period_end: 1810000000}]}}}});
assert.equal(r.status, 200);
me = await (await call(APP, '/api/me', {cookie: buyer})).json();
assert.equal(me.membership.cancelAtPeriodEnd, true); assert.equal(me.membership.status, 'active'); assert.equal(me.membership.renewsAt, 1810000000000, 'period end read from the subscription item');
{
  const sent = mails.filter(x => /cancelled/.test(x.subject));
  assert.equal(sent.length, 1, 'one cancellation email'); assert.equal(sent[0].to[0], 'buyer@example.com');
  assert.match(sent[0].text, /keep full access until May 10, 2027/); assert.match(sent[0].text, /won’t be charged again/);
  r = await webhook({id: 'evt_upd_2', type: 'customer.subscription.updated', data: {object: {id: 'sub_1', status: 'active', cancel_at_period_end: true, items: {data: [{id: 'si_1', current_period_end: 1810000000}]}}}});
  assert.equal(mails.filter(x => /cancelled/.test(x.subject)).length, 1, 'a repeat update does not email again');
}
r = await webhook({id: 'evt_del_1', type: 'customer.subscription.deleted', data: {object: {id: 'sub_1', status: 'canceled', current_period_end: 1800000000, cancel_at_period_end: false}}});
assert.equal(r.status, 200);
assert.equal((await call(APP, '/api/me', {cookie: buyer})).status, 401, 'open session ends when the subscription is deleted');
assert.equal(mails.filter(x => /cancelled/.test(x.subject)).length, 1, 'already told when it was scheduled; no second email at the end');
mails.length = 0;
r = await start('buyer@example.com'); assert.equal(mails.length, 0, 'no sign-in code for a canceled member');
assert.equal((await call(APP, '/#home', {cookie: buyer})).status, 302, 'pages redirect to sign-in');

// Re-inviting by Jay turns a canceled member back into a free learner.
const jay = await signIn('jay@example.com');
r = await call(APP, '/api/learners', {cookie: jay, body: {name: 'Buyer Person', email: 'buyer@example.com', assignedTrack: 'futures'}});
assert.equal(r.status, 200);
assert.equal(membership('buyer@example.com'), undefined, 'ended membership cleared on re-invite');
assert.ok(await signIn('buyer@example.com'), 'buyer signs in again as an invited learner');
me = await (await call(APP, '/api/me', {cookie: await signIn('buyer@example.com')})).json();
assert.equal(me.membership.managed, false); assert.equal(me.membership.plan, 'invited');

// --- Existing invited learners are untouched by billing -------------------------------------------
r = await call(APP, '/api/learners', {cookie: jay, body: {name: 'Sam', email: 'sam@example.com'}}); assert.equal(r.status, 200);
assert.ok(await signIn('sam@example.com'), 'invited learner with no Stripe record signs in');

// --- Lifetime purchase via /join/done (success page) before the webhook arrives --------------------
sessions['cs_life_1'] = {id: 'cs_life_1', mode: 'payment', status: 'complete', payment_status: 'paid', customer: 'cus_2', subscription: null, metadata: {plan: 'lifetime'}, customer_details: {email: 'life@example.com', name: ''}};
mails.length = 0;
r = await call(PUB, '/join/done?session_id=cs_life_1');
assert.equal(r.status, 200);
const html = await r.text();
assert.match(html, /Welcome to The Candle/); assert.match(html, /life@example\.com/); assert.match(html, /learn\.thecandle\.io\/signin\/\?email=life%40example\.com/);
m = membership('life@example.com'); assert.equal(m.plan, 'lifetime'); assert.equal(m.status, 'active'); assert.equal(m.current_period_end, null);
assert.equal(DB.sqlite.prepare('SELECT name FROM learner_profiles WHERE email = ?').get('life@example.com').name, 'life', 'name falls back to the email prefix');
assert.equal(mails.filter(x => /Welcome/.test(x.subject)).length, 1);
// The webhook for the same purchase then arrives: still one membership, no second welcome.
r = await webhook({id: 'evt_life_1', type: 'checkout.session.completed', data: {object: sessions['cs_life_1']}});
assert.equal(r.status, 200); assert.equal(mails.filter(x => /Welcome/.test(x.subject)).length, 1);
assert.ok(await signIn('life@example.com'));
// A refunded lifetime charge closes access.
r = await webhook({id: 'evt_ref_1', type: 'charge.refunded', data: {object: {id: 'ch_1', customer: 'cus_2', invoice: null, refunded: true}}});
assert.equal(membership('life@example.com').status, 'canceled');

// Unpaid / cancelled checkout shows the honest page and creates nothing.
sessions['cs_unpaid'] = {id: 'cs_unpaid', mode: 'payment', status: 'open', payment_status: 'unpaid', customer_details: {email: 'nope@example.com'}};
r = await call(PUB, '/join/done?session_id=cs_unpaid'); assert.equal(r.status, 200); assert.match(await r.text(), /Payment not completed/);
assert.equal(membership('nope@example.com'), undefined);
r = await call(PUB, '/join/done?session_id=../etc'); assert.equal(r.status, 302, 'malformed session id is ignored');

// --- Legal page routing on the public host ---------------------------------------------------------
for (const p of ['/terms', '/privacy', '/refunds', '/disclaimer']) assert.equal(await (await call(PUB, p)).text(), `asset:/home${p}/`, p + ' serves its page');

// Escaping in the success page.
sessions['cs_x'] = {id: 'cs_x', mode: 'payment', status: 'complete', payment_status: 'paid', customer: 'cus_3', metadata: {plan: 'lifetime'}, customer_details: {email: '"><script>x</script>@example.com'}};
r = await call(PUB, '/join/done?session_id=cs_x'); assert.doesNotMatch(await r.text(), /<script>x<\/script>/, 'email is escaped in HTML');

console.log('PASS: Stripe signature checks, checkout redirects, webhook fulfillment and idempotency, welcome email, paid/invited/canceled access rules, portal, lifetime refunds, re-invite, and public legal routes.');
