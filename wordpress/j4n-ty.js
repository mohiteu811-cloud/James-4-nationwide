function j4nInit() {
  var WORKER_BASE = "https://pledge.james4nw.com";

  var SHARE_TEXT =
    "Nationwide members: there's a real choice on this year's ballot, but the form is built to hide it. " +
    "Don't Quick Vote — scroll down and vote FOR Sherwin-Smith. Pledge + get a reminder: ";

  function render(link, count) {
    document.getElementById("j4n-link").value = link;

    var countEl = document.getElementById("j4n-count");
    if (typeof count === "number") {
      countEl.textContent =
        count === 1
          ? "You've brought in 1 voter."
          : "You've brought in " + count + " voters.";
      countEl.hidden = false;
    }

    var msg = encodeURIComponent(SHARE_TEXT + link);
    var url = encodeURIComponent(link);
    document.getElementById("j4n-wa").href = "https://wa.me/?text=" + msg;
    document.getElementById("j4n-fb").href =
      "https://www.facebook.com/sharer/sharer.php?u=" + url;
    document.getElementById("j4n-em").href =
      "mailto:?subject=" +
      encodeURIComponent("There's a real choice on the Nationwide ballot") +
      "&body=" + msg;
    document.getElementById("j4n-share").hidden = false;
  }

  var FALLBACK =
    "Your link is in the confirmation email we just sent — open it on this " +
    "device to see it here.";

  var code = null;
  try { code = localStorage.getItem("j4n_my_code"); } catch (e) {}

  if (code) {
    var link = window.location.origin + "/pledge/?ref=" + encodeURIComponent(code);
    render(link, null);

    fetch(WORKER_BASE + "/leaderboard?code=" + encodeURIComponent(code))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var hasCount = (data != null) && (data.you != null) && (typeof data.you.count === "number");
        var count = hasCount ? data.you.count : 0;
        render(link, count);
      })
      .catch(function () {});
  } else {
    document.getElementById("j4n-link").value = FALLBACK;
  }

  document.getElementById("j4n-copy").addEventListener("click", function () {
    var input = document.getElementById("j4n-link");
    input.select();
    try {
      navigator.clipboard.writeText(input.value);
    } catch (e) {
      document.execCommand("copy");
    }
    this.textContent = "Copied!";
    var btn = this;
    setTimeout(function () { btn.textContent = "Copy link"; }, 2000);
  });
}

document.addEventListener("DOMContentLoaded", j4nInit);
