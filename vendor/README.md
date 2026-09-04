# Vendored browser dependencies

VictoryPVI bundles these browser-side libraries so PDF export and扫码配对 remain
local and do not require a network connection at runtime:

- jsPDF 4.2.1 (`jspdf.umd.min.js`), MIT License
- Noto Sans SC Regular (`noto-sans-sc-regular-vfs.js`), SIL Open Font License 1.1
- QR Code Generator for JavaScript 1.4.4 (`qrcode-generator.js`), MIT License
- jsQR 1.4.0 (`jsqr.js`), MIT License

The Noto Sans SC asset is loaded only when a report is exported. It embeds
selectable Chinese vector text in the PDF. The corresponding license texts are
stored alongside the bundled files.

The QR libraries are used only in the device-sync dialog: the generator renders
the one-time pairing link as an inline SVG, and jsQR reads a QR image from the
camera when the browser grants permission. Neither library sends data over the
network.
