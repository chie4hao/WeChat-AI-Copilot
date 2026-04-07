// Service worker — PWA installability + Share Target support

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 拦截 Share Target POST，提取文本后重定向到导入页
  if (url.pathname === '/import' && e.request.method === 'POST') {
    e.respondWith(
      e.request.formData().then((formData) => {
        const text = formData.get('text') || formData.get('title') || '';
        return Response.redirect(`/import.html?text=${encodeURIComponent(text)}`, 303);
      })
    );
    return;
  }

  e.respondWith(fetch(e.request));
});
