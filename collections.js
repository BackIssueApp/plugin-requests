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

// Description shapes that state THIS volume is a collection:
//   FORMAT_COLLECTS — a format word directly followed by a collect/reprint verb
//                     ("Trade Paperback collecting …", "Hardcover reprinting …").
//   COLLECTS_ISSUES — "Collects …/Collecting … #<n>" naming the issues gathered.
// Scanned only over the HEAD of the description (see isCollection): a real
// collected edition LEADS with this; an ongoing series that merely lists its
// "Collected Editions" further down, or narrates "collected in …", stays clear.
const FORMAT_COLLECTS = /\b(trade\s*paperbacks?|hardcovers?|graphic\s*novels?|omnibus|compendium|digest|deluxe(?:\s+edition)?|paperbacks?|softcovers?|prestige|hc|tpb|gn)\s+(?:collect(?:s|ing|ed)?|reprint(?:s|ing|ed)?)\b/i;
const COLLECTS_ISSUES = /\bcollect(?:s|ing)\b[^.]{0,45}#\s*\d/i;
const DESC_HEAD = 120;

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

  // Description signal (search carries `deck`; create carries full `description`).
  // A collection OPENS by naming its format/action ("Trade paperback collecting
  // …", "Collects #1-6", "Graphic novel. …").
  const blurb = stripHtml(vol?.description || vol?.deck || '');
  if (/^(collects|collecting|collected edition|trade paperbacks?|tpb|hardcovers?|graphic novels?|omnibus|compendium|deluxe edition)\b/i.test(blurb)) return true;

  // Same idea, but tolerant of a leading "NOTE:"/"Advertisement"/one-line
  // summary before the collect statement — so long as it's still near the START
  // (first ~120 chars). Scanning only the head is what keeps an ongoing series
  // clear when it merely LISTS its "Collected Editions" further down, or says a
  // run was "collected in" an omnibus, or narrates "never collecting #57-75".
  const head = blurb.slice(0, DESC_HEAD);
  if (FORMAT_COLLECTS.test(head) || COLLECTS_ISSUES.test(head)) return true;

  return false;
}
