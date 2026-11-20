'use strict';
// Baloo 2 (SIL Open Font License, assets/fonts/Baloo2-OFL.txt) para el BB Hub.
// Se mete dentro del CSS como data: porque el Hub también se pinta dentro de la página del juego,
// que no puede leer archivos locales.
const fs = require('fs');
const path = require('path');
let cache = null;
function fontFaces() {
  if (cache != null) return cache;
  const face = (w, file) => {
    try {
      const b64 = fs.readFileSync(path.join(__dirname, 'assets', 'fonts', file)).toString('base64');
      return `@font-face{font-family:"BB Baloo";font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2")}`;
    } catch (_) { return ''; }
  };
  cache = face(600, 'baloo-2-latin-600-normal.woff2') + face(800, 'baloo-2-latin-800-normal.woff2');
  return cache;
}
module.exports = { withFonts: css => fontFaces() + '\n' + css };
