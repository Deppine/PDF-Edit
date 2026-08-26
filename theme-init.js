// Runs synchronously in <head> (before any CSS paints) so a saved theme choice
// applies immediately with no flash of the wrong theme. Keep this file tiny and dependency-free.
(function(){
  try{
    var saved = localStorage.getItem("acrobeer-theme");
    if(saved === "light" || saved === "dark"){
      document.documentElement.setAttribute("data-theme", saved);
    }
  }catch(e){
    // localStorage can throw in some locked-down/private-browsing contexts — fall back to system theme.
  }
})();
