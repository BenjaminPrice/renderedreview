// SPDX-License-Identifier: AGPL-3.0-only
// Runs before first paint (blocking, in <head>). Marks the page as scripted (the CSS shows the
// theme toggle and hero video only then) and applies a saved light/dark choice; otherwise the OS
// preference applies. ?theme=dark|light forces one, for screenshots.
(function () {
  var root = document.documentElement;
  var key = "rr-theme";
  root.classList.add("js");
  var saved = null;
  try {
    saved = localStorage.getItem(key);
  } catch (e) {}
  var forced = new URLSearchParams(location.search).get("theme");
  var theme = forced === "dark" || forced === "light" ? forced : saved;
  if (theme === "dark" || theme === "light") root.dataset.theme = theme;
  document.addEventListener("click", function (event) {
    if (!event.target.closest || !event.target.closest("[data-theme-toggle]")) return;
    var dark = root.dataset.theme
      ? root.dataset.theme === "dark"
      : matchMedia("(prefers-color-scheme: dark)").matches;
    root.dataset.theme = dark ? "light" : "dark";
    try {
      localStorage.setItem(key, root.dataset.theme);
    } catch (e) {}
    document.dispatchEvent(new Event("rr-theme"));
  });
})();
