/* ASM service worker: shows Web Push notifications and opens the approve page on click.
   Plain script without build step; no caching or offline logic. */
'use strict';

var FALLBACK_TITLE = 'ASM';
var FALLBACK_BODY = 'New notification';
var ICON = '/icons/icon-192.png';

/** Only same-origin relative paths ("/…") are opened; anything else falls back to "/". */
function safePath(url) {
  if (typeof url !== 'string' || url.length > 2000 || url.charAt(0) !== '/') return '/';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f\\]/.test(url)) return '/';
  try {
    var origin = self.location.origin;
    var parsed = new URL(url, origin);
    if (parsed.origin !== origin || parsed.pathname.indexOf('//') === 0) return '/';
    return parsed.pathname + parsed.search + parsed.hash;
  } catch (e) {
    return '/';
  }
}

/** Reads the push payload { title, body, url, tag }; missing or broken fields get neutral defaults. */
function parsePayload(data) {
  var p = {};
  try {
    var text = data ? data.text() : '';
    var parsed = text ? JSON.parse(text) : null;
    if (parsed && typeof parsed === 'object') p = parsed;
  } catch (e) {
    p = {};
  }
  var str = function (v, max) {
    return typeof v === 'string' && v.trim() ? v.slice(0, max) : undefined;
  };
  return {
    title: str(p.title, 100) || FALLBACK_TITLE,
    body: str(p.body, 300) || FALLBACK_BODY,
    url: safePath(p.url),
    tag: str(p.tag, 200),
  };
}

self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var msg = parsePayload(event.data);
  var options = { body: msg.body, icon: ICON, data: { url: msg.url } };
  if (msg.tag) options.tag = msg.tag;
  event.waitUntil(self.registration.showNotification(msg.title, options));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = safePath(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      var origin = self.location.origin;
      var approve = null;
      var other = null;
      for (var i = 0; i < list.length; i++) {
        var path;
        try {
          var u = new URL(list[i].url);
          if (u.origin !== origin) continue;
          path = u.pathname;
        } catch (e) {
          continue; // ignore clients with unparsable URLs
        }
        if (!approve && path.indexOf('/approve/') === 0) approve = list[i];
        else if (!other) other = list[i];
      }
      // Navigate a client, then focus it; rejects when the client cannot be navigated.
      var reuse = function (client) {
        if (typeof client.navigate !== 'function') return Promise.reject(new Error('no navigate'));
        return Promise.resolve(client.navigate(url)).then(function (navigated) {
          var c = navigated || client;
          return typeof c.focus === 'function' ? c.focus() : c;
        });
      };
      // Fallback only: take over another open ASM window when no new window could be opened.
      var openOrReuseOther = function () {
        return Promise.resolve(self.clients.openWindow(url))
          .catch(function () {
            return null;
          })
          .then(function (win) {
            if (win || !other) return win;
            return reuse(other).catch(function () {
              return null;
            });
          });
      };
      if (approve) return reuse(approve).catch(openOrReuseOther);
      return openOrReuseOther();
    }),
  );
});
