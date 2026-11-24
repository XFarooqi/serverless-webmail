// Apply the saved theme before first paint (separate file so the page can use a strict CSP with no inline scripts).
(function () {
  var t = localStorage.getItem("mm2:theme") || "system";
  var dark = t === "dark" || (t === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
})();
