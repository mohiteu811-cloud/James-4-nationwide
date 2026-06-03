(function () {
  var REF_KEY = "j4n_ref";
  var MY_KEY  = "j4n_my_code";
  var TTL_MS  = 45 * 24 * 60 * 60 * 1000;

  /* ---- 1. Capture an incoming ?ref=CODE ---- */
  try {
    var params   = new URLSearchParams(window.location.search);
    var incoming = params.get("ref");
    if (incoming) {
      incoming = incoming.trim().slice(0, 32);
      if (incoming) {
        localStorage.setItem(REF_KEY, JSON.stringify({ code: incoming, ts: Date.now() }));
      }
    }
  } catch (e) {}

  var ref = null;
  try {
    var raw = localStorage.getItem(REF_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (typeof parsed === "string") parsed = { code: parsed, ts: Date.now() };
      if (parsed && parsed.code && (Date.now() - (parsed.ts || 0)) < TTL_MS) {
        ref = parsed.code;
      } else {
        localStorage.removeItem(REF_KEY);
      }
    }
  } catch (e) {}

  /* ---- 2. This browser's OWN referral code ---- */
  var myCodeCache = null;

  function genCode() {
    var alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_";
    var buf = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(buf);
    var out = "";
    for (var i = 0; i < buf.length; i++) {
      out += alphabet[buf[i] % alphabet.length];
    }
    return out;
  }

  function myCode(create) {
    if (myCodeCache) return myCodeCache;
    var code = null;
    try { code = localStorage.getItem(MY_KEY); } catch (e) {}
    if (!code && create) {
      try { code = genCode(); } catch (e) { return null; }
      try { localStorage.setItem(MY_KEY, code); } catch (e) {}
    }
    if (code) myCodeCache = code;
    return code;
  }

  /* ---- 3. Inject both fields into the MailerLite form ---- */
  function setField(form, name, value) {
    var input = form.querySelector('[name="' + name + '"]');
    if (!input) {
      input = document.createElement("input");
      input.type = "hidden";
      input.name = name;
      form.appendChild(input);
    }
    input.value = value;
  }

  function inject(create) {
    var forms = document.querySelectorAll(".j4n-form-wrap form");
    forms.forEach(function (form) {
      var mine = myCode(create);
      if (mine) setField(form, "fields[referral_code]", mine);
      if (ref)  setField(form, "fields[referred_by]",   ref);
    });
  }

  if (document.readyState !== "loading") {
    inject(true);
  } else {
    document.addEventListener("DOMContentLoaded", function () { inject(true); });
  }

  if (window.MutationObserver) {
    var observer = new MutationObserver(function () { inject(false); });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  document.addEventListener("submit", function (e) {
    if (e.target && e.target.closest && e.target.closest(".j4n-form-wrap")) {
      inject(true);
      try { localStorage.removeItem(REF_KEY); } catch (e2) {}
    }
  }, true);

})();
