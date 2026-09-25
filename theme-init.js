// Runs synchronously in <head> (before any CSS paints) so the correct theme
// applies immediately with no flash of the wrong theme. Keep this file tiny
// and dependency-free.
//
// Default is always LIGHT on a first visit (no saved choice yet) — the app
// does NOT follow the OS/browser's prefers-color-scheme for its initial
// theme; dark mode only turns on once the person explicitly picks it via
// the toggle, after which that choice is remembered.
(function(){
  var theme = "light";
  try{
    var saved = localStorage.getItem("lyra-theme");
    if(saved === "light" || saved === "dark") theme = saved;
  }catch(e){
    // localStorage can throw in some locked-down/private-browsing contexts — fall back to light.
  }
  document.documentElement.setAttribute("data-theme", theme);
})();
