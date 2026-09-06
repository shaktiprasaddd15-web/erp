// Same scoring formula as the original prototype:
// score = 40% consistency + 30% detail (avg words/point) + 15% volume (points/entry) + 15% evidence

// windowDays sizes the trailing window (default 30 days ending today). Pass an
// explicit { from, to } range (ISO date strings) instead to score a fixed
// period — used by the Performance page's date filter to compare everyone
// within the same window.
function computeStats(entries, windowDays = 30, range = null) {
  let windowEntries;
  if (range && range.from && range.to) {
    windowEntries = entries.filter((e) => e.entry_date >= range.from && e.entry_date <= range.to);
    const span = Math.round((new Date(range.to) - new Date(range.from)) / 86400000) + 1;
    windowDays = Math.max(1, span);
  } else {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - windowDays);
    const cutoffISO = cutoff.toISOString().slice(0, 10);
    windowEntries = entries.filter((e) => e.entry_date >= cutoffISO);
  }

  const submittedDates = new Set(windowEntries.map((e) => e.entry_date));
  const consistencyRatio = Math.min(1, submittedDates.size / windowDays);

  const totalBullets = windowEntries.reduce((s, e) => s + (e.bullets?.length || 0), 0);
  const avgBullets = windowEntries.length ? totalBullets / windowEntries.length : 0;
  const volumeRatio = Math.min(1, avgBullets / 3);

  const wordCounts = [];
  windowEntries.forEach((e) =>
    (e.bullets || []).forEach((b) => wordCounts.push(String(b).trim().split(/\s+/).filter(Boolean).length))
  );
  const avgWords = wordCounts.length ? wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length : 0;
  const detailRatio = Math.max(0, Math.min(1, (avgWords - 2) / 6));

  const withAttach = windowEntries.filter((e) => e.attachment_note || e.attachment_url).length;
  const attachRatio = windowEntries.length ? withAttach / windowEntries.length : 0;

  const score = Math.round(consistencyRatio * 40 + volumeRatio * 15 + detailRatio * 30 + attachRatio * 15);

  return {
    score,
    submittedDays: submittedDates.size,
    windowDays,
    avgBulletsPerEntry: avgBullets.toFixed(1),
    avgWords: avgWords.toFixed(1),
    attachRatePct: Math.round(attachRatio * 100),
  };
}

// Rating out of 100 for a SINGLE day, from that day's work entry (or null if
// nothing was submitted): 45 for submitting, up to 25 for volume, up to 20 for
// detail, 10 for evidence.
function dailyScore(entry) {
  if (!entry) return 0;
  const bullets = entry.bullets || [];
  const submitted = 45;
  const volume = Math.min(1, bullets.length / 3) * 25;
  const wordCounts = bullets.map((b) => String(b).trim().split(/\s+/).filter(Boolean).length);
  const avgWords = wordCounts.length ? wordCounts.reduce((a, b) => a + b, 0) / wordCounts.length : 0;
  const detail = Math.max(0, Math.min(1, (avgWords - 2) / 6)) * 20;
  const evidence = (entry.attachment_note || entry.attachment_url) ? 10 : 0;
  return Math.round(submitted + volume + detail + evidence);
}

function scoreLabel(score) {
  if (score >= 75) return { text: 'Strong', cls: 'score-strong' };
  if (score >= 50) return { text: 'Steady', cls: 'score-steady' };
  return { text: 'Needs attention', cls: 'score-low' };
}

module.exports = { computeStats, scoreLabel, dailyScore };
