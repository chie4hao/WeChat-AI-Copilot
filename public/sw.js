// Service Worker — PWA installability + Share Target support

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

// ── Web Push ──────────────────────────────────────────────────

self.addEventListener('push', (e) => {
  const data = e.data?.json() ?? {};
  e.waitUntil(self.registration.showNotification(data.title || 'AI Copilot', {
    body:      data.body || 'AI 建议已生成',
    icon:      '/icon-192.png',
    badge:     '/badge-96.png',
    tag:       'ai-suggestion',   // 同 tag 的通知会覆盖，不堆叠
    renotify:  true,
    data:      { contactId: data.contactId },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const contactId = e.notification.data?.contactId;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // 如果已有窗口打开，聚焦并通知切换联系人
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'open_contact', contactId });
          return client.focus();
        }
      }
      // 没有窗口则新开
      return clients.openWindow(contactId ? `/?contact=${contactId}` : '/');
    })
  );
});

// ── IndexedDB helpers ─────────────────────────────────────────

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('ai-copilot', 1);
    req.onupgradeneeded = (e) => {
      e.target.result.createObjectStore('share', { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

async function saveSharedText(text) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('share', 'readwrite');
    tx.objectStore('share').add({ text, ts: Date.now() });
    tx.oncomplete = resolve;
    tx.onerror = (e) => reject(e.target.error);
  });
}

// ── Fetch handler ─────────────────────────────────────────────

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 拦截 Share Target POST
  if (url.pathname === '/import' && e.request.method === 'POST') {
    e.respondWith((async () => {
      try {
        const formData = await e.request.formData();

        let text = formData.get('text') || formData.get('title') || '';

        // 微信可能以文件形式分享，尝试读取文件内容
        const files = formData.getAll('files');
        if (!text && files.length > 0) {
          text = await files[0].text();
        }

        if (text) {
          await saveSharedText(text);
          return Response.redirect('/import.html?from=share', 303);
        }
        return Response.redirect('/import.html', 303);
      } catch (err) {
        return Response.redirect('/import.html', 303);
      }
    })());
    return;
  }

  e.respondWith(fetch(e.request));
});
