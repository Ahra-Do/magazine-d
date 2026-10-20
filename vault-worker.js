'use strict';

const ROOT = new URL('./', self.location.href);
const READER_PREFIX = `${ROOT.pathname}reader/`;
const SESSION_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const VAULT_PATTERN = /^vault\/[A-Za-z0-9_-]{12,128}\.bin$/;
const sessions = new Map();
const recovering = new Map();
const encoder = new TextEncoder();
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
let configPromise;

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

function isBroker(client) {
  if (!client || client.type !== 'window' || !['top-level', 'auxiliary'].includes(client.frameType)) return false;
  const url = new URL(client.url);
  return url.origin === ROOT.origin && (url.pathname === ROOT.pathname || url.pathname === `${ROOT.pathname}index.html`);
}

function isRelativePath(path) {
  return typeof path === 'string' && path.length > 0 && !path.startsWith('/') &&
    !/[\\?#\u0000-\u001f\u007f]/.test(path) &&
    !path.split('/').some(part => !part || part === '.' || part === '..');
}

async function configuration(refresh = false) {
  if (refresh) configPromise = undefined;
  if (!configPromise) {
    configPromise = (async () => {
      const response = await fetch(new URL('config.json', ROOT), { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error('CONFIG');
      const config = await response.json();
      if (config.version !== 1 || typeof config.build !== 'string' ||
          !/^[A-Za-z0-9_-]{12,128}$/.test(config.build) || !VAULT_PATTERN.test(config.manifest)) throw new Error('CONFIG');
      return config;
    })().catch(error => { configPromise = undefined; throw error; });
  }
  return configPromise;
}

async function importKey(encoded) {
  if (typeof encoded !== 'string' || !KEY_PATTERN.test(encoded)) throw new Error('KEY');
  const raw = Uint8Array.from(atob(encoded.replaceAll('-', '+').replaceAll('_', '/') + '='), char => char.charCodeAt(0));
  if (raw.length !== 32) throw new Error('KEY');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['decrypt']);
}

async function decrypt(cipher, key, build, path) {
  const response = await fetch(new URL(cipher, ROOT), { cache: 'force-cache', credentials: 'omit' });
  if (!response.ok) throw new Error('FETCH');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length < 28) throw new Error('CIPHER');
  return crypto.subtle.decrypt({
    name: 'AES-GCM',
    iv: bytes.subarray(0, 12),
    additionalData: encoder.encode(`ARDONG-LINK-V1:${build}:${path}`),
    tagLength: 128
  }, key, bytes.subarray(12));
}

function validateManifest(manifest) {
  if (manifest.version !== 1 || !manifest.files || typeof manifest.files !== 'object' || Array.isArray(manifest.files) ||
      !isRelativePath(manifest.entry) || !hasOwn(manifest.files, manifest.entry)) throw new Error('MANIFEST');
  for (const [path, file] of Object.entries(manifest.files)) {
    if (!isRelativePath(path) || !file || typeof file !== 'object' || !VAULT_PATTERN.test(file.cipher) ||
        typeof file.mime !== 'string' || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+(?:; ?charset=utf-8)?$/.test(file.mime) ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 512 * 1024 * 1024 ||
        typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('MANIFEST');
  }
  return manifest;
}

async function unlock(session, encodedKey, build, broker, clients = [], proofs = []) {
  if (!SESSION_PATTERN.test(session) || !isBroker(broker)) throw new Error('BROKER');
  const config = await configuration(true);
  if (build !== config.build) throw new Error('BUILD');
  const existing = sessions.get(session);
  if (existing && existing.brokerId !== broker.id) throw new Error('SESSION');
  const key = await importKey(encodedKey);
  const plaintext = await decrypt(config.manifest, key, build, '__manifest__');
  const manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)));
  if (!Array.isArray(clients) || !Array.isArray(proofs) || clients.some(id => typeof id !== 'string' || !id) || proofs.some(proof => !SESSION_PATTERN.test(proof))) throw new Error('CLIENTS');
  const record = { key, build, manifest, brokerId: broker.id, clients: new Set([...(existing?.clients || []), ...clients]), proofs: new Set(proofs) };
  sessions.set(session, record);
  return record;
}

self.addEventListener('message', event => {
  const message = event.data;
  const port = event.ports[0];
  if (!port || message?.type !== 'ARDONG_LINK_UNLOCK') return;
  event.waitUntil((async () => {
    try {
      const record = await unlock(message.session, message.key, message.build, event.source, message.clients, message.proofs);
      port.postMessage({ ok: true, entry: record.manifest.entry });
    } catch (_) { port.postMessage({ ok: false }); }
    finally { port.close(); }
  })());
});

function askBroker(client, session, build, request) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => finish(null), 5000);
    function finish(value) { clearTimeout(timer); channel.port1.close(); resolve(value); }
    channel.port1.onmessage = event => {
      const message = event.data;
      if (message?.type !== 'ARDONG_LINK_KEY_RESPONSE' || message.session !== session || message.build !== build || !KEY_PATTERN.test(message.key)) {
        finish(null);
        return;
      }
      finish({ broker: client, key: message.key, clients: message.clients, proofs: message.proofs });
    };
    try { client.postMessage({ type: 'ARDONG_LINK_KEY_REQUEST', session, build, clientId: request.clientId, proof: request.proof }, [channel.port2]); }
    catch (_) { finish(null); }
  });
}

async function recover(session, request) {
  if (sessions.has(session)) {
    const record = sessions.get(session);
    const broker = await self.clients.get(record.brokerId);
    if (isBroker(broker)) return record;
    sessions.delete(session);
  }
  const recoveryId = `${session}:${request.clientId}:${request.proof}`;
  if (recovering.has(recoveryId)) return recovering.get(recoveryId);
  const pending = (async () => {
    const config = await configuration();
    const brokers = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter(isBroker);
    if (!brokers.length) throw new Error('LOCKED');
    const match = await new Promise((resolve, reject) => {
      let remaining = brokers.length;
      for (const broker of brokers) {
        askBroker(broker, session, config.build, request).then(result => {
          if (result) resolve(result);
          else if (--remaining === 0) reject(new Error('LOCKED'));
        });
      }
    });
    return unlock(session, match.key, config.build, match.broker, match.clients, match.proofs);
  })();
  recovering.set(recoveryId, pending);
  try { return await pending; }
  finally { recovering.delete(recoveryId); }
}

async function bindNavigation(session, record, request, resultingClientId) {
  if (!resultingClientId || (!record.proofs.has(request.proof) && !record.clients.has(request.clientId))) throw new Error('CLIENT');
  const broker = await self.clients.get(record.brokerId);
  if (!isBroker(broker)) throw new Error('BROKER');
  const bridge = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  const accepted = await new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => finish(false), 5000);
    function finish(ok) { clearTimeout(timer); channel.port1.close(); resolve(ok); }
    channel.port1.onmessage = event => finish(event.data?.ok === true);
    broker.postMessage({ type: 'ARDONG_LINK_CLIENT_BOUND', session, build: record.build, clientId: resultingClientId, fromClientId: request.clientId, proof: request.proof, bridge }, [channel.port2]);
  });
  if (!accepted) throw new Error('CLIENT');
  record.clients.add(resultingClientId);
  record.proofs.delete(request.proof);
  return bridge;
}

function navigationBridge(session, bridge) {
  const prefix = `${ROOT.pathname}reader/${session}/`;
  return `<script>(()=>{'use strict';const session=${JSON.stringify(session)},bridge=${JSON.stringify(bridge)},prefix=${JSON.stringify(prefix)};let broker;try{broker=parent!==window?parent:opener&&(opener.__ARDONG_LINK_BROKER__||opener.parent);if(broker){window.__ARDONG_LINK_BROKER__=broker;if(parent===window)window.opener=null;}}catch(_){}if(!broker)return;const nativeOpen=window.open.bind(window);function eligible(value){try{const u=new URL(value,location.href);return u.origin===location.origin&&u.pathname.startsWith(prefix)?u:null;}catch(_){return null;}}function navigate(url,popup){const channel=new MessageChannel();const timer=setTimeout(()=>done(null),20000);function done(reply){clearTimeout(timer);channel.port1.close();if(reply&&reply.ok){if(popup)popup.location.href=reply.url;else location.assign(reply.url);}else{if(popup)popup.close();window.alert('전체 링크에서 다시 열어 주세요.');}}channel.port1.onmessage=e=>done(e.data);broker.postMessage({type:'ARDONG_LINK_NAV_REQUEST',session,bridge,url:url.href},location.origin,[channel.port2]);}document.addEventListener('click',event=>{if(event.defaultPrevented||event.button!==0||event.altKey)return;const a=event.target.closest&&event.target.closest('a[href]');if(!a||a.hasAttribute('download'))return;const url=eligible(a.href);if(!url)return;if(url.pathname===location.pathname&&url.search===location.search&&url.hash)return;event.preventDefault();event.stopImmediatePropagation();const separate=a.target==='_blank'||event.ctrlKey||event.metaKey||event.shiftKey;const popup=separate?nativeOpen('about:blank','_blank'):null;if(separate&&!popup)return;navigate(url,popup);},true);window.open=function(value,target,features){const url=eligible(value);if(!url)return nativeOpen(value,target,features);const safeFeatures=(features||'').split(',').filter(x=>!/^\\s*(noopener|noreferrer)(?:\\s*=|\\s*$)/i.test(x)).join(',');const popup=nativeOpen('about:blank',target||'_blank',safeFeatures);if(popup)navigate(url,popup);return popup;};})();</script>`;
}

function errorResponse(status = 403) {
  return new Response('<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>링크 확인</title><body style="font-family:system-ui;padding:32px;line-height:1.8">전달받은 전체 링크로 다시 열어 주세요.</body></html>', {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }
  });
}

async function readerResponse(event, url) {
  try {
    if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return errorResponse(405);
    const route = url.pathname.slice(READER_PREFIX.length);
    const slash = route.indexOf('/');
    if (slash < 0) return errorResponse(404);
    const session = route.slice(0, slash);
    if (!SESSION_PATTERN.test(session)) return errorResponse(404);
    const path = decodeURIComponent(route.slice(slash + 1));
    if (!isRelativePath(path)) return errorResponse(404);
    const request = { clientId: event.clientId || event.replacesClientId || '', proof: url.searchParams.get('open') || '' };
    const record = await recover(session, request);
    let bridge;
    if (event.request.mode === 'navigate') bridge = await bindNavigation(session, record, request, event.resultingClientId);
    else if (!record.clients.has(request.clientId)) return errorResponse();
    if (!hasOwn(record.manifest.files, path)) return errorResponse(404);
    const file = record.manifest.files[path];
    const plaintext = await decrypt(file.cipher, record.key, record.build, path);
    if (plaintext.byteLength !== file.size) throw new Error('SIZE');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', plaintext));
    const actualHash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    if (actualHash !== file.sha256) throw new Error('HASH');
    const headers = {
      'Content-Type': file.mime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow, noarchive, noimageindex'
    };
    if (file.mime.startsWith('text/html')) headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'";
    let body = plaintext;
    if (file.mime.startsWith('text/html') && bridge) {
      const html = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
      const script = navigationBridge(session, bridge);
      body = /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, head => head + script) : script + html;
    }
    return new Response(event.request.method === 'HEAD' ? null : body, { status: 200, headers });
  } catch (_) { return errorResponse(); }
}

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin === ROOT.origin && url.pathname.startsWith(READER_PREFIX)) event.respondWith(readerResponse(event, url));
});
