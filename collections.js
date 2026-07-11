// Collected-edition (TPB / hardcover / omnibus / …) detection for the
// "no compilations" request filter. ComicVine has no format field, and Metron
// (which does) has NO linked record for the collected-edition volume ids — it
// only ever types the underlying single-issue series — so a name/description
// heuristic is the only workable signal. Tuned against the full CloneVine
// catalogue (~157k volumes); precision measured in the low-to-mid 90s.
//
// Two tiers so we don't nuke real ongoing series that merely have a
// collection-ish word in their title:
//   STRONG    — unambiguous format words; flag unconditionally (~99.6% precise).
//   AMBIGUOUS — words that also appear in series titles (Collection Vedette,
//               Laugh Comics Digest); flag ONLY when the issue count is small,
//               since a collected edition is a few books while an ongoing
//               periodical has many.
// Plus a "Collects …" description/deck blurb, the strongest signal when present
// (search carries `deck`; the create path carries the full `description`).

const STRONG = new RegExp([
  'omnibus', 'tpb', 'trade paperbacks?', 'hardcovers?', 'epic collection', 'masterworks',
  'compendium', 'complete collection', 'complete edition', 'the complete', 'collected editions?',
  'deluxe edition', 'library edition', 'treasury edition', 'gallery edition',
  "artist'?s edition", 'box set', 'slipcase',
].map((w) => `\\b${w}\\b`).join('|'), 'i');

// These need the count guard — bare "collection/collected/complete/digest/hc"
// show up in plenty of legitimate ongoing series (Rat-Man Collection, 123 issues).
const AMBIGUOUS = /\b(collection|collected|complete|digest|hc)\b/i;
const AMBIGUOUS_MAX_ISSUES = 15;

const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Does this ComicVine volume look like a collected edition rather than a
 *  single-issue series? */
export function isCollection(vol) {
  const name = String(vol?.name || '');
  if (STRONG.test(name)) return true;

  if (AMBIGUOUS.test(name)) {
    const count = Number(vol?.count_of_issues);
    if (!Number.isFinite(count) || count <= AMBIGUOUS_MAX_ISSUES) return true;
  }

  // "Collects Foo #1-6" / "Collected edition of …" — decisive when we have it.
  const blurb = stripHtml(vol?.description || vol?.deck || '');
  if (/^(collects|collected edition)\b/i.test(blurb)) return true;
  if (/\bcollects (issues?|#)\b/i.test(blurb.slice(0, 160))) return true;

  return false;
}
