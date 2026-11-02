# Bundled QR generator

`qrcodegen-v1.8.0.mjs` is Project Nayuki's QR Code generator, version 1.8.0,
under the MIT License. The full upstream notice is preserved in the module
and in `qrcodegen.LICENSE.txt`.

Primary repository: https://github.com/nayuki/QR-Code-generator

Official release source:
https://github.com/nayuki/QR-Code-generator/releases/download/v1.8.0/qrcodegen-v1.8.0-es6.js

SHA-256 of the downloaded upstream JavaScript:
`6a1116192ed1dd67fa1bf31e77f5817103d71c23bbac24c382e698b7668bdd01`

Local adaptation: remove trailing whitespace and append `export { qrcodegen };`
so the namespace can be imported as an ES module. No generator algorithm or
license text is changed.
The module is served with the app; it makes no network requests and needs no
CDN, runtime package installation, or external QR service.
