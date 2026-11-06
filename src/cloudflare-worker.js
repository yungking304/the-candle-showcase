// Production entry for Cloudflare Workers.
//
// PUBLIC_HOST (thecandle.io): the public homepage only. No course content.
// www.PUBLIC_HOST: redirects to PUBLIC_HOST.
// APP_HOST (learn.thecandle.io): the private school. The Candle's own sign-in (auth.js) protects
// every page, file, and API request. Only the sign-in page and its fonts are public there.
import {handleAPI} from './worker.js';
import {isTeacher} from './db/profiles.js';
import {handleAuth, sessionUser} from './auth.js';
import {handleJoin, handleWebhook, handlePortal} from './billing.js';

const noStore = {'Cache-Control': 'no-store'};
const HOME_FILES = /^\/(home\/.*|fonts\/.*|favicon\.svg)$/;
// Public pages served from /home/<name>/ at clean addresses on thecandle.io.
const PUBLIC_PAGES = {'/terms': '/home/terms/', '/privacy': '/home/privacy/', '/refunds': '/home/refunds/', '/disclaimer': '/home/disclaimer/', '/pricing': '/'};
const SIGNIN_FILES = /^\/(signin\/.*|fonts\/.*|favicon\.svg)$/;
const AUDIO_KEY = /^\/audio\/([a-z0-9-]+\/[a-z0-9-]+-[ab]\.mp3)$/;

// Narration clips live in the R2 bucket bound as AUDIO. Supports byte ranges, which Safari needs.
async function serveAudio(request, env, key) {
  if (!env.AUDIO) return new Response('Audio storage is not connected.', {status: 404, headers: noStore});
  const range = request.headers.get('range');
  const m = range && /^bytes=(\d+)-(\d*)$/.exec(range);
  let obj;
  if (m) {
    const head = await env.AUDIO.head(key);
    if (!head) return new Response('Not found', {status: 404, headers: noStore});
    const start = Number(m[1]), end = m[2] ? Math.min(Number(m[2]), head.size - 1) : head.size - 1;
    if (start >= head.size || end < start) return new Response(null, {status: 416, headers: {'Content-Range': `bytes */${head.size}`}});
    obj = await env.AUDIO.get(key, {range: {offset: start, length: end - start + 1}});
    if (!obj) return new Response('Not found', {status: 404, headers: noStore});
    return new Response(obj.body, {status: 206, headers: {'Content-Type': 'audio/mpeg', 'Content-Range': `bytes ${start}-${end}/${head.size}`, 'Content-Length': String(end - start + 1), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400'}});
  }
  obj = await env.AUDIO.get(key);
  if (!obj) return new Response('Not found', {status: 404, headers: noStore});
  return new Response(obj.body, {headers: {'Content-Type': 'audio/mpeg', 'Content-Length': String(obj.size), 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400'}});
}

function safeNext(value) {
  const v = String(value || '/');
  return v.startsWith('/') && !v.startsWith('//') && !v.startsWith('/\\') && !v.startsWith('/signin') ? v : '/';
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const publicHost = env.PUBLIC_HOST || 'thecandle.io';
    const appHost = env.APP_HOST || 'learn.thecandle.io';

    if (url.hostname === 'www.' + publicHost) return Response.redirect(`https://${publicHost}${url.pathname}${url.search}`, 301);

    if (url.hostname === publicHost) {
      if (url.pathname === '/' || url.pathname === '/index.html') return env.ASSETS.fetch(new Request(new URL('/home/', url), request));
      if (url.pathname === '/pricing') return Response.redirect(`https://${publicHost}/#pricing`, 302);
      if (PUBLIC_PAGES[url.pathname]) return env.ASSETS.fetch(new Request(new URL(PUBLIC_PAGES[url.pathname], url), request));
      if (url.pathname === '/api/billing/webhook') return handleWebhook(request, env);
      const join = await handleJoin(request, env);
      if (join) return join;
      if (HOME_FILES.test(url.pathname)) return env.ASSETS.fetch(request);
      if (url.pathname.startsWith('/api/')) return new Response('Not found', {status: 404, headers: noStore});
      return Response.redirect(`https://${appHost}${url.pathname}${url.search}`, 302);
    }

    // Private school.
    const auth = await handleAuth(request, env);
    if (auth) return auth;
    if (url.pathname === '/signin') return Response.redirect(new URL('/signin/' + url.search, url).toString(), 302);
    const who = await sessionUser(request, env);
    if (url.pathname.startsWith('/signin/')) {
      if (who) return Response.redirect(new URL(safeNext(url.searchParams.get('next')), url).toString(), 302);
      return env.ASSETS.fetch(request);
    }
    if (SIGNIN_FILES.test(url.pathname)) return env.ASSETS.fetch(request);
    if (url.pathname.startsWith('/api/')) {
      if (!who) return Response.json({error: 'Sign in to The Candle to continue.'}, {status: 401, headers: noStore});
      return handleAPI(request, env, who);
    }
    if (url.pathname === '/billing/portal') {
      if (!who) return new Response(null, {status: 302, headers: {Location: '/signin/?next=%2Fbilling%2Fportal', ...noStore}});
      return handlePortal(request, env, who);
    }
    if (url.pathname.startsWith('/audio/')) {
      if (!who) return new Response('Sign in to The Candle to continue.', {status: 401, headers: noStore});
      const k = AUDIO_KEY.exec(url.pathname);
      return k ? serveAudio(request, env, k[1]) : new Response('Not found', {status: 404, headers: noStore});
    }
    if (!who) {
      const next = safeNext(url.pathname + url.search);
      return new Response(null, {status: 302, headers: {Location: '/signin/' + (next === '/' ? '' : '?next=' + encodeURIComponent(next)), ...noStore}});
    }
    // Private previews are protected even when requested by a direct file URL.
    let assetPath;
    try { assetPath = decodeURIComponent(url.pathname); } catch { return new Response('Not found', {status:404, headers:noStore}); }
    if (/^\/(coach|playbook)(?:\/|$)/.test(assetPath) && !isTeacher(who, env)) return new Response('Coming soon', {status:403, headers:noStore});
    return env.ASSETS.fetch(request);
  }
};

