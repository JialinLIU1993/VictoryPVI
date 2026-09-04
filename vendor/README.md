# Vendored PDF dependencies

VictoryPVI bundles these browser-side libraries so PDF export remains local and
does not require a network connection at runtime:

- jsPDF 4.2.1 (`jspdf.umd.min.js`), MIT License
- Noto Sans SC Regular (`noto-sans-sc-regular-vfs.js`), SIL Open Font License 1.1

The Noto Sans SC asset is loaded only when a report is exported. It embeds
selectable Chinese vector text in the PDF. The corresponding license texts are
stored alongside the bundled files.
