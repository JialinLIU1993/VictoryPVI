// Used by both the standalone web page and the mini program.
const RingSectors = (() => {
  const labels = 'ABCDEFGHIJ';
  const count = labels.length;
  const degrees = 360 / count;
  // Place each former 45° sector at its original midpoint, without duplicating coverage.
  const legacySectors = Array.from({ length: 8 }, (_, i) => Math.floor((i + 0.5) * 45 / degrees) + 1);

  function migrateLabel(label) {
    return typeof label === 'string'
      ? label.replace(/([A-H])(?=\s*区)/g, letter => labels[legacySectors[labels.indexOf(letter)] - 1])
      : label;
  }

  function migrateRecord(record) {
    const counts = {};
    for (const [key, value] of Object.entries(record.counts || {})) {
      const mapped = key.replace(/((?:inner|outer)[:-])([1-8])$/, (_, prefix, sector) => prefix + legacySectors[sector - 1]);
      counts[mapped] = value;
    }
    const migrated = { ...record, counts };
    for (const field of ['events', 'sequenceEvents']) {
      if (!Array.isArray(record[field])) continue;
      migrated[field] = record[field].map(event => {
        if (!event || !['ring', 'sector', 'segment'].includes(event.type)) return event;
        const next = { ...event };
        for (const key of ['sector', 'gapSector', 'excludedSector']) {
          if (key in next) next[key] = legacySectors[event[key] - 1];
        }
        if (event.type === 'ring') next.legacyEightSectors = true;
        return next;
      });
    }
    if (record.selectedSector) migrated.selectedSector = legacySectors[record.selectedSector - 1];
    if (record.actionLabel) migrated.actionLabel = migrateLabel(record.actionLabel);
    for (const field of ['lastOperation', 'lastOp']) {
      if (record[field]?.label) migrated[field] = { ...record[field], label: migrateLabel(record[field].label) };
    }
    return migrated;
  }

  function coverageIncrement(sector, gap) {
    const offset = Math.abs(sector - gap);
    const distance = Math.min(offset, count - offset);
    if (distance === 0) return 0;
    return distance <= 2 ? 0.5 : 1;
  }

  function isPosterior(left, sector) {
    const center = (sector - 0.5) * degrees;
    return left ? center >= 45 && center < 180 : center >= 180 && center < 315;
  }

  return { labels, count, degrees, coverageIncrement, legacySectors, migrateLabel, migrateRecord, isPosterior };
})();
if (typeof module !== 'undefined') module.exports = RingSectors;
