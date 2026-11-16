/* ASM Mockups – gemeinsames Verhalten (vanilla JS, kein Build). */
(function () {
  "use strict";

  /* ---------- Icons (lucide, stroke 1.5) als Sprite ---------- */
  var ICONS = {
    overview: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
    inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    vault: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/><path d="m7.9 7.9 2.7 2.7"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/><path d="m13.4 10.6 2.7-2.7"/><circle cx="7.5" cy="16.5" r=".5" fill="currentColor"/><path d="m7.9 16.1 2.7-2.7"/><circle cx="16.5" cy="16.5" r=".5" fill="currentColor"/><path d="m13.4 13.4 2.7 2.7"/><circle cx="12" cy="12" r="2"/>',
    laptop: '<path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16"/>',
    scroll: '<path d="M15 12h-5"/><path d="M15 8h-5"/><path d="M19 17V5a2 2 0 0 0-2-2H4"/><path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3"/>',
    settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    updown: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/>',
    moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
    monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><line x1="8" x2="16" y1="21" y2="21"/><line x1="12" x2="12" y1="17" y2="21"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>',
    calendar: '<path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/>',
    zap: '<path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>',
    pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    menu: '<line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    link: '<path d="M9 17H7A5 5 0 0 1 7 7h2"/><path d="M15 7h2a5 5 0 1 1 0 10h-2"/><line x1="8" x2="16" y1="12" y2="12"/>',
    corner: '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    timer: '<line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/>'
  };
  var sprite = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">';
  Object.keys(ICONS).forEach(function (k) { sprite += '<symbol id="i-' + k + '" viewBox="0 0 24 24">' + ICONS[k] + "</symbol>"; });
  sprite += "</svg>";
  document.body.insertAdjacentHTML("afterbegin", sprite);
  function icon(name, cls) { return '<svg class="icon ' + (cls || "") + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; }
  window.asmIcon = icon;

  /* ---------- Hell/Dunkel ---------- */
  var KEY = "asm-theme";
  var mql = window.matchMedia("(prefers-color-scheme: dark)");
  function stored() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function effective() { var s = stored(); return s === "light" || s === "dark" ? s : (mql.matches ? "dark" : "light"); }
  function apply(mode) {
    var root = document.documentElement;
    if (mode === "light" || mode === "dark") root.setAttribute("data-theme", mode); else root.removeAttribute("data-theme");
    try { if (mode === "system") localStorage.removeItem(KEY); else localStorage.setItem(KEY, mode); } catch (e) {}
    syncThemeUI();
  }
  function syncThemeUI() {
    var eff = effective(), s = stored() || "system";
    document.querySelectorAll("[data-theme-toggle]").forEach(function (b) {
      b.innerHTML = icon(eff === "dark" ? "sun" : "moon");
      b.setAttribute("aria-label", eff === "dark" ? "Helles Design" : "Dunkles Design");
      b.title = b.getAttribute("aria-label");
    });
    document.querySelectorAll("[data-theme-set]").forEach(function (b) {
      b.setAttribute("aria-pressed", String(b.getAttribute("data-theme-set") === s));
    });
  }
  function toggleTheme() { apply(effective() === "dark" ? "light" : "dark"); }
  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-theme-toggle]"); if (t) toggleTheme();
    var s = e.target.closest("[data-theme-set]"); if (s) apply(s.getAttribute("data-theme-set"));
  });
  mql.addEventListener && mql.addEventListener("change", syncThemeUI);
  window.addEventListener("storage", function (e) { if (e.key === KEY) { var v = e.newValue; if (v) document.documentElement.setAttribute("data-theme", v); else document.documentElement.removeAttribute("data-theme"); syncThemeUI(); } });
  syncThemeUI();

  /* ---------- Toasts ---------- */
  var toastBox = document.createElement("div");
  toastBox.className = "toasts"; toastBox.setAttribute("role", "status"); toastBox.setAttribute("aria-live", "polite");
  document.body.appendChild(toastBox);
  function toast(msg, kind, action) {
    var el = document.createElement("div");
    el.className = "toast";
    var ic = kind === "ok" ? icon("check", "t-ok") : kind === "danger" ? icon("x", "t-danger") : kind === "amber" ? icon("zap", "t-amber") : icon("check");
    el.innerHTML = ic + '<span class="t-msg">' + msg + "</span>";
    if (action) {
      var b = document.createElement("button"); b.textContent = action.label;
      b.addEventListener("click", function () { action.run(); close(); });
      el.appendChild(b);
    }
    toastBox.appendChild(el);
    var timer = setTimeout(close, 5000);
    function close() { clearTimeout(timer); el.classList.add("is-out"); setTimeout(function () { el.remove(); }, 200); }
    while (toastBox.children.length > 3) toastBox.firstChild.remove();
  }
  window.asmToast = toast;

  /* ---------- Zeitformat ---------- */
  function fmt(sec, pad) {
    sec = Math.max(0, Math.round(sec));
    var m = Math.floor(sec / 60), s = sec % 60;
    return (pad && m < 10 ? "0" : "") + m + ":" + (s < 10 ? "0" : "") + s;
  }

  /* ---------- Auto-Modus-Pille ---------- */
  var pill = document.querySelector("[data-auto-pill]");
  var autoLeft = pill ? Number(pill.getAttribute("data-seconds")) : 0;
  var pop = document.getElementById("auto-pop");
  function renderAuto() {
    if (!pill) return;
    pill.hidden = autoLeft <= 0;
    var total = Math.max(Number(pill.getAttribute("data-total")) || autoLeft, autoLeft);
    pill.setAttribute("data-total", total);
    var fillEl = pill.querySelector("[data-auto-fill]"); if (fillEl) fillEl.style.width = (autoLeft / total * 100).toFixed(2) + "%";
    pill.querySelectorAll("[data-auto-time]").forEach(function (n) { n.textContent = fmt(autoLeft, true); });
    if (pop) pop.querySelectorAll("[data-auto-time]").forEach(function (n) { n.textContent = fmt(autoLeft, true); });
  }
  if (pill) {
    pill.addEventListener("click", function (e) {
      e.stopPropagation();
      pop.hidden = !pop.hidden; pill.setAttribute("aria-expanded", String(!pop.hidden));
    });
    document.addEventListener("click", function (e) { if (pop && !pop.hidden && !pop.contains(e.target)) pop.hidden = true; });
    if (pop) {
      var all = pop.querySelector("[data-vault-all]"), each = pop.querySelectorAll("[data-vault]");
      var syncAll = function () { var n = 0; each.forEach(function (c) { if (c.checked) n++; }); all.checked = n === each.length; all.indeterminate = n > 0 && n < each.length; };
      all.addEventListener("change", function () { each.forEach(function (c) { c.checked = all.checked; }); });
      each.forEach(function (c) { c.addEventListener("change", syncAll); });
      syncAll();
    }
    pop && pop.addEventListener("click", function (e) {
      var a = e.target.closest("[data-auto]"); if (!a) return;
      if (a.getAttribute("data-auto") === "stop") { autoLeft = 0; toast("Auto-Modus beendet. Neue Anfragen warten wieder auf dich.", "amber"); }
      else { autoLeft += 15 * 60; pill.setAttribute("data-total", Number(pill.getAttribute("data-total")) + 15 * 60); toast("Auto-Modus um 15 Minuten verlängert.", "amber"); }
      pop.hidden = true; renderAuto();
    });
    renderAuto();
  }
  window.asmStartAuto = function (min) { if (!pill) return; autoLeft = min * 60; pill.setAttribute("data-total", autoLeft); renderAuto(); toast("Auto-Modus für " + min + " Minuten aktiv.", "amber"); };

  /* ---------- Anfrage-Karten ---------- */
  var cards = function () { return Array.prototype.slice.call(document.querySelectorAll(".req:not(.is-leaving)")); };
  var selected = 0;
  function select(i) {
    var list = cards(); if (!list.length) return;
    selected = (i + list.length) % list.length;
    list.forEach(function (c, j) { c.classList.toggle("is-selected", j === selected); });
  }
  function renderCard(c) {
    var left = Number(c.dataset.left), total = Number(c.dataset.total);
    var fill = c.querySelector(".fill"); if (fill) fill.style.width = (left / total * 100).toFixed(2) + "%";
    var t = c.querySelector("[data-left-text]"); if (t) t.textContent = fmt(left);
    c.classList.toggle("is-urgent", left <= 30);
  }
  function updateCount() {
    var n = cards().length;
    document.querySelectorAll("[data-pending-count]").forEach(function (el) { el.textContent = n; el.setAttribute("data-n", n); });
    document.querySelectorAll("[data-pending-label]").forEach(function (el) { el.textContent = n === 1 ? "1 offen" : n + " offen"; });
    var empty = document.querySelector("[data-empty]"); if (empty) empty.hidden = n > 0;
    var hint = document.querySelector(".kbd-hint"); if (hint) hint.hidden = n === 0;
  }
  function resolve(card, outcome) {
    if (!card || card.classList.contains("is-leaving")) return;
    card.dataset.out = outcome;
    card.classList.add("is-leaving");
    var h = card.offsetHeight;
    var wrap = card;
    setTimeout(function () {
      wrap.style.height = h + "px"; wrap.style.overflow = "hidden";
      wrap.style.transition = "height .2s ease, margin .2s ease";
      requestAnimationFrame(function () { wrap.style.height = "0px"; wrap.style.marginTop = "-12px"; wrap.style.borderWidth = "0"; });
      setTimeout(function () {
        var parent = wrap.parentNode, next = wrap.nextSibling;
        wrap.remove(); updateCount(); select(Math.min(selected, cards().length - 1));
        wrap._restore = function () {
          wrap._restore = null;
          wrap.className = "req"; wrap.removeAttribute("style"); delete wrap.dataset.out;
          parent.insertBefore(wrap, next && next.parentNode === parent ? next : null);
          updateCount(); select(cards().indexOf(wrap)); renderCard(wrap);
        };
        if (wrap._undo) { wrap._undo = false; wrap._restore(); }
      }, 220);
    }, 300);
    var who = card.dataset.who, what = card.dataset.what;
    var undo = { label: "Rückgängig", run: function () { if (wrap._restore) wrap._restore(); else wrap._undo = true; } };
    if (outcome === "approve") toast(what + " für " + who + " freigegeben.", "ok", undo);
    else if (outcome === "deny") toast("Anfrage von " + who + " verweigert.", "danger", undo);
    else toast("Anfrage von " + who + " abgelaufen.", "amber");
  }
  document.addEventListener("click", function (e) {
    var b = e.target.closest("[data-act]"); if (!b) return;
    var c = b.closest(".req"); resolve(c, b.getAttribute("data-act"));
  });
  document.querySelectorAll(".req").forEach(function (c, i) {
    renderCard(c);
    c.addEventListener("mousedown", function () { select(cards().indexOf(c)); });
  });
  if (document.querySelector(".req")) { select(0); updateCount(); }

  /* ---------- Sekundentakt ---------- */
  setInterval(function () {
    if (pill && autoLeft > 0) { autoLeft--; renderAuto(); if (autoLeft === 0) toast("Auto-Modus abgelaufen.", "amber"); }
    cards().forEach(function (c) {
      var l = Number(c.dataset.left) - 1; c.dataset.left = l; renderCard(c);
      if (l <= 0) resolve(c, "expire");
    });
  }, 1000);

  /* ---------- Befehlspalette ---------- */
  var PAL = [
    { g: "Seiten", i: "overview", t: "Übersicht", href: "dashboard.html" },
    { g: "Seiten", i: "inbox", t: "Anfragen", href: "dashboard.html" },
    { g: "Seiten", i: "key", t: "Secrets" },
    { g: "Seiten", i: "folder", t: "Projekte" },
    { g: "Seiten", i: "laptop", t: "Geräte" },
    { g: "Seiten", i: "scroll", t: "Audit-Log", href: "audit.html" },
    { g: "Secrets", i: "key", t: "GITHUB_TOKEN", mono: 1, h: "agent-secrets-manager" },
    { g: "Secrets", i: "key", t: "STRIPE_SECRET_KEY", mono: 1, h: "billing-service" },
    { g: "Secrets", i: "key", t: "OPENAI_API_KEY", mono: 1, h: "billing-service" },
    { g: "Secrets", i: "key", t: "DATABASE_URL", mono: 1, h: "agent-secrets-manager" },
    { g: "Secrets", i: "key", t: "SENTRY_DSN", mono: 1, h: "billing-service" },
    { g: "Aktionen", i: "zap", t: "Auto-Modus 30 min", run: function () { window.asmStartAuto(30); } },
    { g: "Aktionen", i: "plus", t: "Secret anlegen" },
    { g: "Aktionen", i: "laptop", t: "Gerät koppeln", href: "connect.html" },
    { g: "Aktionen", i: "moon", t: "Hell/Dunkel umschalten", run: toggleTheme }
  ];
  var scrim = null, palInput, palList, palIdx = 0, palItems = [];
  function buildPalette() {
    scrim = document.createElement("div");
    scrim.className = "scrim"; scrim.hidden = true;
    scrim.innerHTML =
      '<div class="palette" role="dialog" aria-modal="true" aria-label="Befehlspalette">' +
      '<div class="palette-input">' + icon("search") + '<input type="text" placeholder="Secret, Seite oder Befehl suchen" aria-label="Suchen" role="combobox" aria-expanded="true" aria-controls="pal-list"></div>' +
      '<ul class="palette-list" id="pal-list" role="listbox"></ul>' +
      '<div class="palette-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span> auswählen</span><span><span class="kbd">↵</span> öffnen</span><span><span class="kbd">esc</span> schließen</span></div></div>';
    document.body.appendChild(scrim);
    palInput = scrim.querySelector("input"); palList = scrim.querySelector("ul");
    scrim.addEventListener("mousedown", function (e) { if (e.target === scrim) closePalette(); });
    palInput.addEventListener("input", function () { palIdx = 0; renderPalette(); });
    palInput.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); palIdx = Math.min(palIdx + 1, palItems.length - 1); mark(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); palIdx = Math.max(palIdx - 1, 0); mark(); }
      else if (e.key === "Enter") { e.preventDefault(); run(palItems[palIdx]); }
    });
  }
  function renderPalette() {
    var q = palInput.value.trim().toLowerCase(), html = "", last = "";
    palItems = PAL.filter(function (p) { return !q || (p.t + " " + (p.h || "") + " " + p.g).toLowerCase().indexOf(q) > -1; });
    palItems.forEach(function (p, i) {
      if (p.g !== last) { html += '<li class="palette-group" role="presentation">' + p.g + "</li>"; last = p.g; }
      html += '<li class="palette-item" role="option" data-i="' + i + '" id="pal-' + i + '">' + icon(p.i) +
        '<span class="' + (p.mono ? "mono" : "") + '">' + p.t + "</span>" + (p.h ? '<span class="hint">' + p.h + "</span>" : (p.href ? '<span class="hint">Seite</span>' : "")) + "</li>";
    });
    palList.innerHTML = html || '<li class="palette-empty">Nichts gefunden für „' + palInput.value.replace(/</g, "&lt;") + "“.</li>";
    palList.querySelectorAll(".palette-item").forEach(function (li) {
      li.addEventListener("mousemove", function () { palIdx = Number(li.dataset.i); mark(); });
      li.addEventListener("click", function () { run(palItems[Number(li.dataset.i)]); });
    });
    mark();
  }
  function mark() {
    palList.querySelectorAll(".palette-item").forEach(function (li) {
      var on = Number(li.dataset.i) === palIdx; li.setAttribute("aria-selected", String(on));
      if (on) { li.scrollIntoView({ block: "nearest" }); palInput.setAttribute("aria-activedescendant", li.id); }
    });
  }
  function run(p) {
    if (!p) return; closePalette();
    if (p.run) p.run(); else if (p.href) location.href = p.href; else toast((p.mono ? "Secret " : "") + p.t + " ist im Mockup nicht ausgearbeitet.");
  }
  function openPalette() { if (!scrim) buildPalette(); scrim.hidden = false; palInput.value = ""; palIdx = 0; renderPalette(); palInput.focus(); }
  function closePalette() { if (scrim) scrim.hidden = true; }
  window.asmPalette = openPalette;
  document.querySelectorAll("[data-cmdk]").forEach(function (b) { b.addEventListener("click", openPalette); });

  /* ---------- Tastatur ---------- */
  document.addEventListener("keydown", function (e) {
    var typing = /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      if (!document.body.hasAttribute("data-app")) return;
      e.preventDefault(); if (scrim && !scrim.hidden) closePalette(); else openPalette(); return;
    }
    if (e.key === "Escape") { closePalette(); if (pop) pop.hidden = true; document.querySelector(".shell") && document.querySelector(".shell").classList.remove("nav-open"); return; }
    if (typing || e.metaKey || e.ctrlKey || e.altKey || (scrim && !scrim.hidden)) return;
    var list = cards(); if (!list.length) return;
    var k = e.key.toLowerCase();
    if (k === "a") resolve(list[selected], "approve");
    else if (k === "d") resolve(list[selected], "deny");
    else if (k === "j" || e.key === "ArrowDown") { e.preventDefault(); select(selected + 1); }
    else if (k === "k" || e.key === "ArrowUp") { e.preventDefault(); select(selected - 1); }
  });

  /* ---------- Mobile Navigation ---------- */
  var menu = document.querySelector("[data-menu]");
  if (menu) {
    var shell = document.querySelector(".shell");
    menu.addEventListener("click", function (e) { e.stopPropagation(); shell.classList.toggle("nav-open"); });
    shell.addEventListener("click", function (e) { if (shell.classList.contains("nav-open") && !e.target.closest(".sidebar")) shell.classList.remove("nav-open"); });
  }

  /* ---------- Platzhalter-Links ---------- */
  document.addEventListener("click", function (e) {
    var a = e.target.closest("a[data-stub]"); if (!a) return;
    e.preventDefault(); toast(a.textContent.trim() + " ist im Mockup nicht ausgearbeitet.");
  });
})();
