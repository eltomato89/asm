/* ASM service worker: shows Web Push notifications and opens the approve page on click.
   Plain script without build step; no caching or offline logic. */
'use strict';

var FALLBACK_TITLE = 'ASM';
var FALLBACK_BODY = 'Neue Benachrichtigung';
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
      var client = null;
      for (var i = 0; i < list.length; i++) {
        try {
          if (new URL(list[i].url).origin === origin) {
            client = list[i];
            break;
          }
        } catch (e) {
          // ignore clients with unparsable URLs
        }
      }
      if (!client) return self.clients.openWindow(url);
      return Promise.resolve(client.focus())
        .then(function (focused) {
          var c = focused || client;
          return typeof c.navigate === 'function' ? c.navigate(url) : self.clients.openWindow(url);
        })
        .catch(function () {
          return self.clients.openWindow(url);
        });
    }),
  );
});
