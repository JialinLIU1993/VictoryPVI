# Privacy and local data

VictoryPVI is a local-first application. Optional device synchronization uses
offline browser-to-browser connections on the same Wi-Fi or hotspot. The current
webpage does not connect to a cloud synchronization service.

- It does not include analytics, advertising, or tracking pixels.
- Ablation records and settings are stored in the current browser using
  `localStorage`.
- Optional patient information entered before report export is used only to
  build the current report and is not written to the application's local
  storage.
- When synchronization is enabled, only ablation quality-control state,
  procedure settings, endpoint records, and sync metadata are sent. The browser
  sends state directly over WebRTC DataChannels without application-level room
  keys or an online relay.
- Patient names, medical record numbers, report notes, and generated PDF files
  are intentionally excluded from synchronization.
- PDF reports are generated directly on the current device without using a
  browser print service or sending report content to a network service.
- An exported PDF report may contain the information entered by the user.

Users are responsible for deciding what information they are authorized to
enter, protecting exported reports, and following applicable institutional,
privacy, security, and records-management requirements.
