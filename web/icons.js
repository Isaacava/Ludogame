/* CodePlay icon set — one consistent stroke style instead of emoji. Usage: <svg class="ic"><use href="#i-eye"/></svg>  or  cpIcon('eye') */
(function () {
  var S = {
    eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
    chat: '<path d="M20.5 11.6a8.1 8.1 0 0 1-11.8 7.2L3.5 20.5l1.7-4.9a8.1 8.1 0 1 1 15.3-4z"/>',
    share: '<circle cx="18" cy="5.5" r="2.7"/><circle cx="6" cy="12" r="2.7"/><circle cx="18" cy="18.5" r="2.7"/><path d="m8.4 10.7 7.2-3.9M8.4 13.3l7.2 3.9"/>',
    link: '<path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1.2 1.2"/><path d="M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1.2-1.2"/>',
    volume: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.4 5.6a9 9 0 0 1 0 12.8"/>',
    mute: '<path d="M11 5 6.5 9H3v6h3.5L11 19V5z"/><path d="m16 9.5 5 5M21 9.5l-5 5"/>',
    home: '<path d="M3.5 11 12 3.8l8.5 7.2V19a1.5 1.5 0 0 1-1.5 1.5h-3.5v-5.5h-7v5.5H5A1.5 1.5 0 0 1 3.5 19v-8z"/>',
    more: '<circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15z"/><path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    dice: '<rect x="3.5" y="3.5" width="17" height="17" rx="4.5"/><circle cx="8.6" cy="8.6" r="1.25" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.25" fill="currentColor" stroke="none"/><circle cx="15.4" cy="15.4" r="1.25" fill="currentColor" stroke="none"/>',
    cards: '<rect x="3.5" y="5.5" width="11" height="15" rx="2.4" transform="rotate(-9 9 13)"/><rect x="9.5" y="3.5" width="11" height="15" rx="2.4" transform="rotate(8 15 11)"/><path d="m15 8.6.9 1.9 2 .2-1.5 1.4.5 2-1.9-1.1-1.9 1.1.5-2-1.5-1.4 2-.2z" fill="currentColor" stroke="none" transform="rotate(8 15 11) translate(-.3 -.2) scale(.95)"/>',
    pawn: '<path d="M12 3.2a2.9 2.9 0 0 0-1.7 5.2c-1.1.7-1.8 1.8-1.8 3.1 0 1 .4 1.8 1 2.4L8 19.6h8l-1.5-5.7c.6-.6 1-1.4 1-2.4 0-1.3-.7-2.4-1.8-3.1A2.9 2.9 0 0 0 12 3.2z"/><path d="M6.5 21h11"/>',
    users: '<path d="M16.5 20.5v-1.8a3.7 3.7 0 0 0-3.7-3.7H6.2a3.7 3.7 0 0 0-3.7 3.7v1.8"/><circle cx="9.5" cy="7.6" r="3.6"/><path d="M21.5 20.5v-1.8a3.7 3.7 0 0 0-2.8-3.6M15.7 4.2a3.6 3.6 0 0 1 0 6.8"/>',
    play: '<path d="M7.5 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.7 4.1a.8.8 0 0 0-1.2.7z" fill="currentColor" stroke="none"/>',
    flag: '<path d="M5.5 21V4"/><path d="M5.5 4.5h12.2l-2.2 3.9 2.2 3.9H5.5"/>',
    timer: '<circle cx="12" cy="13.5" r="7.8"/><path d="M12 9.5v4.2l2.6 1.6M9.5 2.5h5"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    lock: '<rect x="5" y="11" width="14" height="9.5" rx="2.6"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    send: '<path d="M21.5 2.5 10.8 13.2M21.5 2.5l-6.6 19-4.1-8.6-8.6-4.1z"/>',
    chevron: '<path d="m9 5.5 6.5 6.5L9 18.5"/>',
    check: '<path d="m4.5 12.5 5 5 10-11"/>',
    refresh: '<path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 3.5v5h-5"/>',
    eyeOff: '<path d="M3 3l18 18M10.6 5.2A9.6 9.6 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.5 6.9C3.7 8.8 2 12 2 12s3.6 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0V4z"/><path d="M8 5.5H4.5V7a3.5 3.5 0 0 0 3.8 3.5M16 5.5h3.5V7a3.5 3.5 0 0 1-3.8 3.5M12 13v4M8.5 20.5h7M9.5 17h5v3.5h-5z"/>',
    bolt: '<path d="M13 2.5 4.5 13.5H11l-1 8 8.5-11H12l1-8z"/>',
    sliders: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    whatsapp: '<path d="M20.4 11.6a8.4 8.4 0 0 1-12.4 7.4L3.6 20.4l1.5-4.3a8.4 8.4 0 1 1 15.3-4.5z"/><path d="M9.2 8.6c.2-.5.7-.5 1-.4.3.1.6 1.2.7 1.4.1.3 0 .5-.2.7l-.5.6c.8 1.5 1.9 2.4 3.4 3.1l.7-.8c.2-.2.4-.2.7-.1l1.4.7c.3.2.4.4.3.8-.2.7-1.1 1.2-1.8 1.1-2.7-.4-5.4-2.9-6.1-5.4-.1-.6.1-1.200.4-1.700z" fill="currentColor" stroke="none"/>'
  };
  function sym(name) { return '<symbol id="i-' + name + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' + S[name] + '</symbol>'; }
  var sprite = '<svg xmlns="http://www.w3.org/2000/svg" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true" focusable="false"><defs>' + Object.keys(S).map(sym).join('') + '</defs></svg>';
  function inject() { if (document.getElementById('cp-sprite')) return; var d = document.createElement('div'); d.id = 'cp-sprite'; d.innerHTML = sprite; document.body.insertBefore(d, document.body.firstChild); }
  if (document.body) inject(); else document.addEventListener('DOMContentLoaded', inject);
  window.cpIcon = function (name, cls) { return '<svg class="ic ' + (cls || '') + '" aria-hidden="true"><use href="#i-' + name + '"/></svg>'; };
})();
