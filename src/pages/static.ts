export const STYLE_CSS = `
@font-face{font-family:"Inter";font-style:normal;font-weight:100 900;font-display:swap;src:url(/fonts/inter-latin-var.woff2) format("woff2")}
@font-face{font-family:"Space Mono";font-style:normal;font-weight:400;font-display:swap;src:url(/fonts/space-mono-latin-400.woff2) format("woff2")}
@font-face{font-family:"Space Mono";font-style:normal;font-weight:700;font-display:swap;src:url(/fonts/space-mono-latin-700.woff2) format("woff2")}
/* Palette and type follow the FLOP ecosystem (flop.finance, technocore.chat); Flopwatch is independent. */
:root{
  --base:#0A1128;--surface:#151D32;--surface-2:#232A3E;--line:#232A3E;
  --fg:#F5F7FA;--muted:#A1A7AE;--accent:#00B4D8;--accent-hover:#3DC5E0;
  --ok:#32D74B;--bad:#FF453A;--blue:#0466C8;
  --accent-rgb:0,180,216;--line-rgb:35,42,62;
  --mono:"Space Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --sans:"Inter",system-ui,-apple-system,"Segoe UI",sans-serif;
  --r-md:4px;--r-lg:8px;
  color-scheme:dark;
  interpolate-size:allow-keywords;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background-color:var(--base);color:var(--fg);font:15px/1.6 var(--sans);-webkit-font-smoothing:antialiased;
  background-image:linear-gradient(rgba(var(--line-rgb),.46) 1px,transparent 1px),linear-gradient(90deg,rgba(var(--line-rgb),.46) 1px,transparent 1px);
  background-size:32px 32px;background-position:-1px -1px}
a{color:var(--accent);text-decoration:none}
a:hover{color:var(--accent-hover)}
a:focus-visible,button:focus-visible,summary:focus-visible,select:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
code,.mono{font-family:var(--mono);font-size:.9em}
[hidden]{display:none!important}
.wrap{max-width:1280px;margin:0 auto;padding:0 24px}

/* Header */
.top{position:sticky;top:0;z-index:20;background:rgba(10,17,40,.92);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.top-inner{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 28px;min-height:60px;padding-top:10px;padding-bottom:10px}
.brand{display:inline-flex;align-items:center;gap:10px;color:var(--fg)}
.brand:hover{color:var(--fg)}
.mark{width:28px;height:28px;color:var(--fg);flex:none}
.wordmark{font-family:var(--mono);font-weight:700;font-size:18px;letter-spacing:.06em}
.wordmark span{color:var(--accent)}
.top nav{display:flex;flex-wrap:wrap;align-items:center;gap:8px 24px;font-family:var(--mono);font-size:12px;letter-spacing:.06em;text-transform:uppercase}
.top nav a{position:relative;color:var(--muted);padding:4px 0}
.top nav a:hover{color:var(--fg)}
.top nav a[aria-current]{color:var(--fg)}
.top nav a[aria-current]::after{content:"";position:absolute;left:0;right:0;bottom:-2px;height:2px;background:var(--accent)}
.top nav a.is-connected{color:var(--ok)}
.top nav a.is-connected::before{content:"";display:inline-block;width:7px;height:7px;margin-right:7px;background:var(--ok);vertical-align:1px}
.nav-sep{width:1px;height:14px;background:var(--surface-2)}
.top nav a.nav-ext{color:var(--muted)}

/* Data banner */
.banner{border-bottom:1px solid var(--line);background:var(--surface);font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}
.banner-inner{display:flex;flex-wrap:wrap;gap:4px 24px;padding-top:9px;padding-bottom:9px}
.banner strong{display:inline-flex;align-items:center;gap:8px;font-weight:700}
.banner strong::before{content:"";width:8px;height:8px}
.banner.sample strong{color:var(--bad)}
.banner.sample strong::before{background:var(--bad)}
.banner.live strong{color:var(--ok)}
.banner.live strong::before{background:var(--ok)}

/* Type */
main.wrap{padding-top:48px;padding-bottom:72px}
h1{margin:0 0 16px;font-family:var(--mono);font-weight:700;font-size:clamp(30px,4.6vw,52px);line-height:1.08;letter-spacing:-.01em}
h2{margin:40px 0 12px;font-family:var(--mono);font-weight:700;font-size:18px;letter-spacing:.01em}
.eyebrow{display:flex;align-items:center;gap:10px;margin:0 0 18px;font-family:var(--mono);font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
.eyebrow::before{content:"";width:8px;height:8px;background:var(--accent);flex:none}
.lead{max-width:68ch;color:var(--muted);font-size:16px;margin:0 0 8px}
.lead strong{color:var(--fg);font-weight:600}
.intro{margin-bottom:28px}

/* Controls */
select,input,textarea,button{font:inherit;color:inherit}
select,input[type=text],input[type=number],textarea{background:var(--base);border:1px solid var(--surface-2);border-radius:var(--r-md);padding:7px 10px;color:var(--fg)}
select:hover,input:hover,textarea:hover{border-color:#34405c}
input[type=number]{width:6rem}
textarea,input[type=text]{width:100%;font-family:var(--mono);font-size:13px}
input[type=file]{font-size:13px;color:var(--muted)}
button,.submit-panel>summary{font-family:var(--mono);font-size:12px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;background:var(--accent);color:var(--base);border:1px solid var(--accent);border-radius:var(--r-md);padding:9px 16px;cursor:pointer}
button:hover,.submit-panel>summary:hover{background:var(--accent-hover);border-color:var(--accent-hover)}
button.secondary{background:transparent;color:var(--fg);border-color:var(--surface-2)}
button.secondary:hover{border-color:var(--muted);background:transparent}
button:disabled{opacity:.4;cursor:not-allowed}
.copy{background:none;border:0;color:var(--muted);padding:0 2px;font-size:13px;letter-spacing:0;text-transform:none;font-weight:400}
.copy:hover{background:none;color:var(--accent)}

.filters{display:flex;flex-wrap:wrap;gap:12px 16px;align-items:end;margin:18px 0}
.filters label{display:flex;flex-direction:column;gap:6px;font-family:var(--mono);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.filters button{padding:8px 14px}

/* Tables */
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:var(--r-lg);background:var(--surface)}
table.board{border-collapse:collapse;width:100%;font-size:14px}
.board th,.board td{padding:11px 12px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
.board th{font-family:var(--mono);font-weight:400;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);background:rgba(10,17,40,.55)}
.board th a{color:inherit}
.board th a:hover,.board th[aria-sort=ascending] a,.board th[aria-sort=descending] a{color:var(--fg)}
.board td.num,.board th.num{text-align:right;font-variant-numeric:tabular-nums}
.board td.num{font-family:var(--mono);font-size:13px}
.board tbody tr:hover{background:rgba(var(--accent-rgb),.04)}
.board tbody tr:last-child td{border-bottom:0}
.empty{color:var(--muted);text-align:center}
.addr{display:inline-flex;gap:6px;align-items:center;font-family:var(--mono);font-size:13px}
.ext{color:var(--muted)}
.warn{display:inline-block;font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;padding:1px 6px;border-radius:var(--r-md);color:#FFD60A;border:1px solid rgba(255,214,10,.35)}
.pill{font-family:var(--mono);font-size:11px;letter-spacing:.04em;padding:1px 8px;border-radius:999px;border:1px solid currentColor}
.pill.ok{color:var(--ok)}.pill.bad{color:var(--bad)}
.hint{color:var(--muted);font-size:13px}

/* Prose & cards */
.prose{max-width:74ch}
.prose p,.prose li{color:#D3D7DD}
.prose strong{color:var(--fg)}
.prose li{margin:6px 0}
.prose h2{color:var(--fg)}
.card{border:1px solid var(--line);border-radius:var(--r-lg);padding:20px;margin:16px 0;background:var(--surface)}
.card h2{margin-top:0}
.card label{display:block;margin:14px 0 6px;font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted)}
.card label code{text-transform:none;letter-spacing:0}
.card button{margin-top:14px}
pre{background:var(--base);border:1px solid var(--line);border-radius:var(--r-md);padding:12px;overflow-x:auto;font-family:var(--mono);font-size:12.5px;color:#D3D7DD}
.result:empty{display:none}
.status{font-size:14px;color:var(--muted)}
.addr-full code{word-break:break-all}
.view-switch{font-family:var(--mono);font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:14px 0 0}
.view-switch strong{color:var(--fg)}
.official-links{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--muted);margin:8px 0 0}
h3{margin:22px 0 8px;font-family:var(--mono);font-size:14px;color:var(--fg)}
.empty-note{color:var(--muted)}
h2 .hint{font-family:var(--sans);font-weight:400;font-size:13px;letter-spacing:0}
#no-ratings{margin:28px 0;padding:18px;border:1px dashed var(--surface-2);border-radius:var(--r-lg);text-align:center}
.board td.stars,.stars{color:#FFD60A}
.preview{margin:12px 0 0;padding:12px 14px;border:1px solid var(--surface-2);border-radius:var(--r-md);background:var(--base)}
.preview.ok{border-color:rgba(50,215,75,.4)}
.preview.bad{border-color:rgba(255,69,58,.5)}
.preview p{margin:0 0 8px}
.preview-error{color:var(--bad);font-size:14px}
.preview-rating{font-family:var(--mono);font-size:15px;color:var(--fg)}
.preview-stars{color:#FFD60A;letter-spacing:2px;font-size:18px}
.preview-connect{color:var(--muted);font-size:13px}
.preview-notes{color:#D3D7DD;font-style:italic;white-space:pre-wrap}
.preview dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0;font-size:13px}
.preview dt{font-family:var(--mono);font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);padding-top:2px}
.preview dd{margin:0;font-family:var(--mono);color:var(--fg);word-break:break-all}
.board td.stars a{color:#FFD60A}
.board td.notes{white-space:pre-wrap;min-width:16rem;max-width:32rem;color:#D3D7DD}
.connected-as{margin:0;color:var(--ok);font-family:var(--mono);font-weight:700;word-break:break-all}
.connected-as .mono{font-weight:400}
.card.connected{border-color:rgba(50,215,75,.35)}
.card.connected button{margin-top:12px}

/* Submit panel on the Board */
.submit-panel{margin:0 0 8px}
.submit-panel>summary{display:inline-flex;align-items:center;gap:10px;list-style:none;user-select:none}
.submit-panel>summary::-webkit-details-marker{display:none}
.submit-panel>summary::after{content:"";width:6px;height:6px;border-right:2px solid currentColor;border-bottom:2px solid currentColor;transform:rotate(-45deg);transition:transform .2s ease}
.submit-panel[open]>summary::after{transform:rotate(45deg) translate(-2px,-2px)}
.submit-panel>.card{max-width:76ch}
.submit-panel::details-content{block-size:0;overflow:hidden;transition:block-size .25s ease,content-visibility .25s allow-discrete}
.submit-panel[open]::details-content{block-size:auto}

/* Footer */
footer{border-top:1px solid var(--line);background:rgba(10,17,40,.9)}
.footer-inner{padding-top:22px;padding-bottom:28px;color:var(--muted);font-size:13px}
.footer-inner p{margin:0 0 10px}
.footer-inner strong{color:var(--fg);font-family:var(--mono)}
.footer-links{display:flex;flex-wrap:wrap;gap:8px 20px;font-family:var(--mono);font-size:11px;letter-spacing:.08em;text-transform:uppercase}
.footer-links a{color:var(--muted)}
.footer-links a:hover{color:var(--fg)}
.footer-fine{margin:14px 0 0;font-size:11px;line-height:1.5;color:#7d838c;max-width:90ch}

@media (prefers-reduced-motion:reduce){.submit-panel::details-content,.submit-panel>summary::after{transition:none}}
@media (max-width:760px){
 .wrap{padding:0 16px}
 main.wrap{padding-top:28px}
 .top{position:static}
 .board thead{display:none}
 .board tr{display:block;border-bottom:1px solid var(--line);padding:8px 0}
 .board tbody tr:last-child{border-bottom:0}
 .board td{display:flex;justify-content:space-between;gap:16px;border:0;padding:4px 14px;white-space:normal}
 .board td::before{content:attr(data-label);color:var(--muted);font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;padding-top:2px}
 .board td.empty{justify-content:center}.board td.empty::before{content:none}
}
`;

export const APP_JS = `
document.addEventListener('click', function (e) {
  var b = e.target.closest && e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard && navigator.clipboard.writeText(b.getAttribute('data-copy')).then(function () {
    var t = b.textContent; b.textContent = '✓'; setTimeout(function () { b.textContent = t; }, 900);
  });
});
// Shared session state: the nav shows "Connected" (green) while a DID session is active.
(function () {
  var state = { known: false, did: null };
  function applyNav(did) {
    var a = document.getElementById('nav-connect');
    if (!a) return;
    a.textContent = did ? 'Connected' : 'Connect';
    a.classList.toggle('is-connected', !!did);
    if (did) a.title = 'Connected as ' + did; else a.removeAttribute('title');
  }
  window.flopSetSession = function (did) {
    state = { known: true, did: did || null };
    applyNav(state.did);
    document.dispatchEvent(new CustomEvent('flop:session', { detail: { did: state.did } }));
  };
  window.flopOnSession = function (fn) {
    document.addEventListener('flop:session', function (e) { fn(e.detail.did); });
    if (state.known) fn(state.did);
  };
  fetch('/v1/auth/session', { credentials: 'same-origin' })
    .then(function (r) { return r.json(); })
    .then(function (j) { window.flopSetSession(j.did); })
    .catch(function () { window.flopSetSession(null); });
})();
`;

export const CONNECT_JS = `
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var challenge = null;
  function setConnected(did) {
    var on = !!did;
    // Once connected, hide the challenge + signature forms and show who is connected.
    $('connected').hidden = !on;
    $('step1').hidden = on;
    $('step2').hidden = on;
    $('connected-did').textContent = on ? did : '';
    $('session-status').textContent = 'Not connected.';
    if (!on) { challenge = null; $('challenge').value = ''; $('signature').value = ''; }
  }
  function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  }
  async function api(path, body) {
    var r = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : '{}' });
    var j = await r.json().catch(function () { return {}; });
    return { status: r.status, body: j };
  }
  window.flopOnSession(setConnected);
  $('get-challenge').addEventListener('click', async function () {
    var did = $('did').value.trim();
    var r = await api('/v1/auth/challenge', did ? { did: did } : null);
    if (r.status !== 200) { $('challenge').value = 'Error ' + r.status + ': ' + (r.body.message || r.body.error); return; }
    challenge = r.body.challenge;
    $('challenge').value = r.body.signingInput || canon(challenge);
  });
  $('verify').addEventListener('click', async function () {
    if (!challenge) { $('session-status').textContent = 'Request a challenge first.'; return; }
    var r = await api('/v1/auth/verify', { did: $('did').value.trim(), challenge: challenge, signature: $('signature').value.trim() });
    if (r.status === 200) { $('signature').value = ''; window.flopSetSession(r.body.did); }
    else $('session-status').textContent = 'Failed (' + r.status + '): ' + (r.body.message || r.body.error);
  });
  $('logout').addEventListener('click', async function () { await api('/v1/auth/logout'); window.flopSetSession(null); });
})();
`;

export const SUBMIT_JS = `
(function () {
  // Pure: what does this pasted envelope contain? Mirrors the server's checks so problems show before submitting.
  // The page never edits the envelope: the rating is inside the signed payload, so changing it would break the signature.
  function describeEnvelope(text) {
    var out = { ok: false, error: null, fields: [], rating: null, notes: null };
    if (!text || !text.trim()) { out.error = null; return out; }
    var env;
    try { env = JSON.parse(text); } catch (_) { out.error = 'Not valid JSON.'; return out; }
    if (!env || typeof env !== 'object' || Array.isArray(env)) { out.error = 'Expected an object: { "payload": {…}, "signature": "…" }.'; return out; }
    var p = env.payload;
    if (!p || typeof p !== 'object' || Array.isArray(p)) { out.error = 'Missing "payload": paste the whole signed envelope, not just the receipt.'; return out; }
    if (typeof env.signature !== 'string' || !env.signature) { out.error = 'Missing "signature": sign it first, e.g. agent-cli sign-receipt receipt.json --rating 4.5'; return out; }
    if (p.kind !== 'flop.miner-receipt') { out.error = 'payload.kind must be "flop.miner-receipt".'; return out; }
    var short = function (a) { a = String(a || ''); return a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-6) : a; };
    out.fields = [
      ['Network', p.network], ['Miner', short(p.miner)], ['Model', p.model],
      ['Session', String(p.status) + (p.ok === true ? ' · delivered' : p.ok === false ? ' · not delivered' : '')],
      ['Latency', typeof p.latencyMs === 'number' ? (p.latencyMs >= 10000 ? (p.latencyMs / 1000).toFixed(1) + ' s' : Math.round(p.latencyMs) + ' ms') : '—'],
      ['Paid', p.paidFlop != null ? p.paidFlop + ' FLOP' : 'n/a'],
      ['Signed by', short(p.did)]
    ];
    var rv = p.review;
    if (!rv || typeof rv !== 'object' || Array.isArray(rv)) { out.error = 'No rating in this receipt. Every receipt needs "review": { "rating": 1–5 }. Re-sign it with --rating.'; return out; }
    var r = rv.rating;
    if (typeof r !== 'number' || !isFinite(r) || r < 1 || r > 5 || Math.round(r * 2) !== r * 2) {
      out.error = 'review.rating must be 1–5 in half steps (1, 1.5, … 5); found ' + JSON.stringify(r) + '. Re-sign it with a valid --rating.';
      return out;
    }
    if (rv.notes != null && (typeof rv.notes !== 'string' || rv.notes.trim().length > 500)) { out.error = 'review.notes must be text of at most 500 characters.'; return out; }
    out.rating = r;
    out.notes = rv.notes ? rv.notes.trim() : null;
    out.ok = true;
    return out;
  }
  window.flopDescribeEnvelope = describeEnvelope;

  var $ = function (id) { return document.getElementById(id); };
  if (!$('submit')) return;
  var connected = false;
  var valid = false;

  function starsText(r) {
    var full = Math.floor(r), half = r - full >= 0.5;
    return '★★★★★'.slice(0, full) + (half ? '½' : '') + '☆☆☆☆☆'.slice(0, 5 - full - (half ? 1 : 0));
  }
  function render() {
    var box = $('envelope-preview');
    var d = describeEnvelope($('envelope').value);
    valid = d.ok;
    $('submit').disabled = !(connected && valid);
    if (!box) return;
    box.textContent = '';
    box.className = 'preview' + (d.ok ? ' ok' : d.error ? ' bad' : '');
    box.hidden = !d.ok && !d.error;
    if (d.error) {
      var e = document.createElement('p'); e.className = 'preview-error'; e.textContent = d.error; box.appendChild(e);
    }
    if (d.ok) {
      var head = document.createElement('p'); head.className = 'preview-rating';
      var s = document.createElement('span'); s.className = 'preview-stars'; s.setAttribute('aria-hidden', 'true'); s.textContent = starsText(d.rating);
      var n = document.createElement('strong'); n.textContent = ' ' + d.rating + ' / 5';
      head.appendChild(s); head.appendChild(n);
      box.appendChild(head);
      if (!connected) {
        var c = document.createElement('p'); c.className = 'preview-connect';
        c.appendChild(document.createTextNode('Looks good. '));
        var a = document.createElement('a'); a.href = '/connect'; a.textContent = 'Connect your DID'; c.appendChild(a);
        c.appendChild(document.createTextNode(' to submit it.'));
        box.appendChild(c);
      }
      if (d.notes) { var q = document.createElement('p'); q.className = 'preview-notes'; q.textContent = '“' + d.notes + '”'; box.appendChild(q); }
    }
    if (d.fields.length) {
      var dl = document.createElement('dl');
      d.fields.forEach(function (f) {
        var dt = document.createElement('dt'); dt.textContent = f[0];
        var dd = document.createElement('dd'); dd.textContent = f[1] == null ? '—' : String(f[1]);
        dl.appendChild(dt); dl.appendChild(dd);
      });
      box.appendChild(dl);
    }
  }

  window.flopOnSession(function (did) {
    connected = !!did;
    var note = $('submit-auth-note'); if (note) note.hidden = connected;
    if (!connected) $('submit-result').textContent = '';
    render();
  });
  $('envelope').addEventListener('input', render);
  $('envelope-file').addEventListener('change', async function (e) {
    var f = e.target.files && e.target.files[0]; if (f) { $('envelope').value = await f.text(); render(); }
  });
  $('submit').addEventListener('click', async function () {
    if (!valid) return;
    var env = JSON.parse($('envelope').value);
    var endpoint = $('submit').getAttribute('data-endpoint') || '/v1/receipts';
    var r = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(env) });
    var j = await r.json().catch(function () { return {}; });
    $('submit-result').textContent = r.status + ' ' + JSON.stringify(j, null, 2);
  });
  render();
})();
`;

/** FNV-1a over all asset bodies: changes whenever any asset changes, so URLs can be cached as immutable. */
function fnv1a(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
export const ASSET_VERSION = fnv1a(STYLE_CSS + APP_JS + CONNECT_JS + SUBMIT_JS);
export const asset = (path: string) => `${path}?v=${ASSET_VERSION}`;
