# Privacy and local data

VictoryPVI is a static, local-first application.

- It does not include analytics, advertising, tracking pixels, or external API
  integrations.
- Ablation records and settings are stored in the current browser using
  `localStorage`.
- Optional patient information entered before report export is used only to
  build the current report and is not written to the application's local
  storage.
- An exported HTML report may contain the information entered by the user.

Users are responsible for deciding what information they are authorized to
enter, protecting exported reports, and following applicable institutional,
privacy, security, and records-management requirements.
