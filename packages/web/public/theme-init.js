/*global document localStorage */
/* UI theme boot (issue #196): external file so the app shell can serve a
 * strict CSP without `unsafe-inline` for scripts. Loaded synchronously
 * from <head>, before the app bundle and before first paint, so a saved
 * theme never flashes the default. The server-side setting (Settings ->
 * Appearance, PUT /api/settings) is the source of truth; this reads its
 * localStorage mirror (`unvibe:ui-theme`, kept in step by
 * src/theme/theme.ts) because settings cannot be fetched before paint.
 * Light/dark (`unvibe:color-mode`) is applied the same way: a pinned
 * "light"/"dark" sets data-theme; "system" leaves it to the OS. */
(function () {
  var theme = "default";
  try {
    var saved = localStorage.getItem("unvibe:ui-theme");
    if (saved === "default" || saved === "studio" || saved === "console") theme = saved;
  } catch {
    /* storage unavailable: the default theme stands */
  }
  document.documentElement.setAttribute("data-ui-theme", theme);
  try {
    var mode = localStorage.getItem("unvibe:color-mode");
    if (mode === "light" || mode === "dark") document.documentElement.setAttribute("data-theme", mode);
  } catch {
    /* storage unavailable: the system mode stands */
  }
})();
