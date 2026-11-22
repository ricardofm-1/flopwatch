export const STYLE_CSS = `
:root{--bg:#fbfbf9;--fg:#17181a;--muted:#5d6168;--line:#e2e2dc;--card:#ffffff;--accent:#2a5bd7;--ok:#1d7a46;--bad:#b3261e;--warn-bg:#fff4d6;--warn-fg:#7a5200;--sample:#b3261e;--live:#1d7a46;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#121315;--fg:#e8e8e6;--muted:#a0a4ab;--line:#2b2d31;--card:#1a1b1e;--accent:#8aa9ff;--ok:#5fcf8c;--bad:#ff8a80;--warn-bg:#3a2f10;--warn-fg:#ffd772;--sample:#ff8a80;--live:#5fcf8c}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent)}
code,.mono{font-family:var(--mono);font-size:.92em}
.top{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:center;justify-content:space-between;padding:.9rem 16px;border-bottom:1px solid var(--line)}
.brand{font-weight:650;color:var(--fg);text-decoration:none}
.top nav{display:flex;gap:1rem;flex-wrap:wrap}
.top nav a{color:var(--muted);text-decoration:none}
.top nav a[aria-current]{color:var(--fg);font-weight:600}
.banner{display:flex;flex-wrap:wrap;gap:.25rem 1.25rem;padding:.55rem 16px;font-size:.9rem;border-bottom:1px solid var(--line)}
.banner.sample{background:var(--warn-bg);color:var(--warn-fg)}
.banner.sample strong{color:var(--sample);letter-spacing:.02em}
.banner.live strong{color:var(--live)}
main{max-width:1200px;margin:0 auto;padding:1rem 16px 3rem}
h1{font-size:1.6rem;margin:.5rem 0}
h2{font-size:1.15rem;margin:1.75rem 0 .5rem}
.intro p{color:var(--muted);max-width:70ch}
.filters{display:flex;flex-wrap:wrap;gap:.6rem 1rem;align-items:end;margin:1rem 0}
.filters label{display:flex;flex-direction:column;font-size:.8rem;color:var(--muted);gap:.2rem}
select,input,textarea,button{font:inherit;color:inherit}
select,input[type=text],input[type=number],textarea{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:.35rem .5rem}
input[type=number]{width:6rem}
textarea,input[type=text]{width:100%;font-family:var(--mono);font-size:.85rem}
button{background:var(--fg);color:var(--bg);border:0;border-radius:6px;padding:.45rem .9rem;cursor:pointer}
button.secondary{background:transparent;color:var(--fg);border:1px solid var(--line)}
button:disabled{opacity:.45;cursor:not-allowed}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table.board{border-collapse:collapse;width:100%;font-size:.9rem}
.board th,.board td{padding:.5rem .7rem;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
.board th{font-weight:600;font-size:.8rem;color:var(--muted);background:var(--bg)}
.board th a{color:inherit;text-decoration:none}
.board td.num,.board th.num{text-align:right;font-variant-numeric:tabular-nums}
.board tbody tr:last-child td{border-bottom:0}
.empty{color:var(--muted);text-align:center}
.addr{display:inline-flex;gap:.35rem;align-items:center;font-family:var(--mono)}
.copy{background:none;color:var(--muted);border:0;padding:0 .2rem;cursor:pointer}
.ext{text-decoration:none}
.warn{display:inline-block;font-size:.72rem;padding:0 .35rem;border-radius:4px;background:var(--warn-bg);color:var(--warn-fg)}
.pill{font-size:.8rem;padding:.05rem .45rem;border-radius:999px;border:1px solid currentColor}
.pill.ok{color:var(--ok)}.pill.bad{color:var(--bad)}
.hint{color:var(--muted);font-size:.85rem}
.prose{max-width:72ch}
.prose li{margin:.3rem 0}
.card{border:1px solid var(--line);border-radius:8px;padding:1rem;margin:1rem 0;background:var(--card)}
.card label{display:block;margin:.75rem 0 .25rem;font-size:.85rem;color:var(--muted)}
.card button{margin-top:.75rem}
pre{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:.6rem;overflow-x:auto;font-size:.82rem}
.result:empty{display:none}
[hidden]{display:none!important}
.connected-as{margin:0;color:var(--ok);font-weight:600;word-break:break-all}
.connected-as .mono{font-weight:500}
.card.connected button{margin-top:.6rem}
.status{font-size:.9rem;color:var(--muted)}
.addr-full code{word-break:break-all}
footer{border-top:1px solid var(--line);padding:1rem 16px;color:var(--muted);font-size:.85rem;text-align:center}
@media (max-width:760px){
 .board thead{display:none}
 .board tr{display:block;border-bottom:1px solid var(--line);padding:.4rem 0}
 .board td{display:flex;justify-content:space-between;gap:1rem;border:0;padding:.2rem .7rem;white-space:normal}
 .board td::before{content:attr(data-label);color:var(--muted);font-size:.8rem}
 .board td.num{text-align:right}
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
    $('step3-num').hidden = on;
    $('connected-did').textContent = on ? did : '';
    $('session-status').textContent = 'Not connected.';
    if (!on) { challenge = null; $('challenge').value = ''; $('signature').value = ''; $('submit-result').textContent = ''; }
    ['envelope', 'envelope-file', 'submit'].forEach(function (id) { $(id).disabled = !on; });
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
  fetch('/v1/auth/session', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (j) { setConnected(j.did); }).catch(function () {});
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
    if (r.status === 200) { setConnected(r.body.did); $('signature').value = ''; }
    else $('session-status').textContent = 'Failed (' + r.status + '): ' + (r.body.message || r.body.error);
  });
  $('envelope-file').addEventListener('change', async function (e) {
    var f = e.target.files && e.target.files[0]; if (f) $('envelope').value = await f.text();
  });
  $('submit').addEventListener('click', async function () {
    var env; try { env = JSON.parse($('envelope').value); } catch (_) { $('submit-result').textContent = 'Envelope is not valid JSON.'; return; }
    var r = await api('/v1/receipts', env);
    $('submit-result').textContent = r.status + ' ' + JSON.stringify(r.body, null, 2);
  });
  $('logout').addEventListener('click', async function () { await api('/v1/auth/logout'); setConnected(null); });
})();
`;
