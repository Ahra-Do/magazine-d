(() => {
  'use strict';

  const gate = document.getElementById('gate');
  const heading = document.getElementById('heading');
  const status = document.getElementById('status');
  const retry = document.getElementById('retry');
  const reader = document.getElementById('reader');
  const base = new URL('./', location.href);
  const workerURL = new URL('vault-worker.js', base);
  const sessionBytes = crypto.getRandomValues(new Uint8Array(24));
  const session = base64url(sessionBytes);
  const navigationProof = base64url(crypto.getRandomValues(new Uint8Array(24)));
  const pendingProofs = new Set([navigationProof]);
  const allowedClients = new Set();
  const bridgeTokens = new Set();
  let registration;
  let config;
  let key;

  function base64url(bytes) {
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  }

  function showError(message) {
    heading.textContent = '링크를 열 수 없습니다';
    status.textContent = message;
    retry.hidden = false;
    gate.hidden = false;
    reader.hidden = true;
  }

  function isCurrentWorker(worker) {
    return worker && worker.scriptURL === workerURL.href && registration &&
      (worker === registration.active || worker === navigator.serviceWorker.controller);
  }

  navigator.serviceWorker?.addEventListener('message', event => {
    const message = event.data;
    const port = event.ports[0];
    if (!port || !isCurrentWorker(event.source) || !key || !config) return;
    if (message?.type === 'ARDONG_LINK_CLIENT_BOUND' && message.session === session && message.build === config.build) {
      const allowed = pendingProofs.has(message.proof) || allowedClients.has(message.fromClientId);
      if (allowed && typeof message.clientId === 'string' && message.clientId) {
        allowedClients.add(message.clientId);
        if (typeof message.bridge === 'string' && /^[A-Za-z0-9_-]{32}$/.test(message.bridge)) bridgeTokens.add(message.bridge);
        pendingProofs.delete(message.proof);
        port.postMessage({ ok: true });
      } else port.postMessage({ ok: false });
      port.close();
      return;
    }
    if (message?.type !== 'ARDONG_LINK_KEY_REQUEST') return;
    const allowed = allowedClients.has(message.clientId) || pendingProofs.has(message.proof);
    if (!allowed || message.session !== session || message.build !== config.build) {
      port.postMessage({ type: 'ARDONG_LINK_KEY_UNAVAILABLE' });
      port.close();
      return;
    }
    port.postMessage({ type: 'ARDONG_LINK_KEY_RESPONSE', session, build: config.build, key, clients: [...allowedClients], proofs: [...pendingProofs] });
    port.close();
  });

  window.addEventListener('message', async event => {
    const message = event.data;
    const port = event.ports[0];
    if (!port || event.origin !== base.origin || message?.type !== 'ARDONG_LINK_NAV_REQUEST' ||
        message.session !== session || !bridgeTokens.has(message.bridge)) return;
    let proof;
    try {
      const target = new URL(message.url);
      if (target.origin !== base.origin || !target.pathname.startsWith(`${base.pathname}reader/${session}/`)) throw new Error('URL');
      proof = base64url(crypto.getRandomValues(new Uint8Array(24)));
      pendingProofs.add(proof);
      await unlock();
      target.searchParams.set('open', proof);
      port.postMessage({ ok: true, url: target.href });
    } catch (_) {
      pendingProofs.delete(proof);
      port.postMessage({ ok: false });
    } finally { port.close(); }
  });

  function callWorker(worker, message, timeout = 30000) {
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error('TIMEOUT'));
      }, timeout);
      channel.port1.onmessage = event => {
        clearTimeout(timer);
        channel.port1.close();
        if (event.data?.ok) resolve(event.data);
        else reject(new Error('LOCKED'));
      };
      try { worker.postMessage(message, [channel.port2]); }
      catch (error) { clearTimeout(timer); channel.port1.close(); reject(error); }
    });
  }

  async function unlock() {
    const worker = navigator.serviceWorker.controller || registration.active;
    if (!isCurrentWorker(worker)) throw new Error('WORKER');
    return callWorker(worker, { type: 'ARDONG_LINK_UNLOCK', session, build: config.build, key, clients: [...allowedClients], proofs: [...pendingProofs] });
  }

  async function controlled() {
    if (navigator.serviceWorker.controller?.scriptURL === workerURL.href) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('CONTROL')); }, 20000);
      function changed() {
        if (navigator.serviceWorker.controller?.scriptURL === workerURL.href) { cleanup(); resolve(); }
      }
      function cleanup() {
        clearTimeout(timer);
        navigator.serviceWorker.removeEventListener('controllerchange', changed);
      }
      navigator.serviceWorker.addEventListener('controllerchange', changed);
      changed();
    });
  }

  async function start() {
    if (!window.isSecureContext || !navigator.serviceWorker || !crypto.subtle) {
      showError('이 브라우저에서는 링크를 열 수 없습니다.\nSafari 또는 Chrome에서 전체 링크를 열어 주세요.');
      return;
    }
    const fragment = new URLSearchParams(location.hash.slice(1));
    key = fragment.get('k');
    if (!key || !/^[A-Za-z0-9_-]{43}$/.test(key)) {
      showError('전달받은 전체 링크로 열어 주세요.\n주소의 # 뒤에 있는 내용까지 필요합니다.');
      return;
    }
    const response = await fetch(new URL('config.json', base), { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('CONFIG');
    config = await response.json();
    if (config.version !== 1 || typeof config.build !== 'string') throw new Error('CONFIG');
    registration = await navigator.serviceWorker.register(workerURL, { scope: base.pathname, updateViaCache: 'none' });
    await navigator.serviceWorker.ready;
    await controlled();
    const result = await unlock();
    const entry = result.entry;
    if (typeof entry !== 'string' || entry.startsWith('/') || entry.includes('..') || /[?#\\]/.test(entry)) throw new Error('ENTRY');
    reader.addEventListener('load', () => { gate.hidden = true; reader.hidden = false; }, { once: true });
    const entryURL = new URL(`reader/${session}/${entry.split('/').map(encodeURIComponent).join('/')}`, base);
    entryURL.searchParams.set('open', navigationProof);
    reader.src = entryURL.href;
    setTimeout(() => {
      if (!gate.hidden) showError('콘텐츠를 불러오지 못했습니다.\n연결을 확인한 뒤 다시 열어 주세요.');
    }, 45000);
  }

  retry.addEventListener('click', () => location.reload());
  window.addEventListener('pageshow', event => {
    if (event.persisted && key && config && registration) unlock().catch(() => {});
  });
  navigator.serviceWorker?.addEventListener('controllerchange', () => {
    if (key && config && registration && reader.hasAttribute('src')) unlock().catch(() => {});
  });
  start().catch(() => showError('전체 링크와 인터넷 연결을 확인한 뒤 다시 열어 주세요.'));
})();
