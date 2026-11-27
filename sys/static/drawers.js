(() => {
  const root = document.documentElement;
  const prefix = 'coral:drawer:v2:';
  const attribute = name => 'data-' + name + '-drawer';
  for (const name of ['folders', 'notes', 'chapters']) {
    let closed = false;
    try { closed = localStorage.getItem(prefix + name) === 'closed'; }
    catch { /* The default layout works when browser storage is unavailable. */ }
    root.setAttribute(attribute(name), closed ? 'closed' : 'open');
  }
  window.coralDrawers = {
    isClosed(name) {
      return root.getAttribute(attribute(name)) === 'closed';
    },
    setClosed(name, closed) {
      root.setAttribute(attribute(name), closed ? 'closed' : 'open');
      try { localStorage.setItem(prefix + name, closed ? 'closed' : 'open'); }
      catch { /* A storage failure cannot prevent opening or closing a panel. */ }
    },
  };
})();
