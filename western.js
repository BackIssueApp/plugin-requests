// Western (US/UK/Anglophone) comic publishers — an ALLOWLIST. ComicVine has no
// format/origin field, so publisher is the only signal for what's a Western
// comic. Blocklisting the manga/foreign houses is endless (hundreds), so the
// "Western comics only" request filter shows/allows a volume ONLY if its
// publisher is on this list; foreign AND unknown are rejected. Kept generous so
// legit indies aren't dropped.
//
// This list is intentionally duplicated from the Discovery plugin rather than
// imported: the two plugins ship independently, and Discovery may not be
// installed. Keep the two roughly in sync when either is updated.

export function normPublisher(p) {
  return String(p || '').trim().toLowerCase()
    .replace(/\s+(comics|publishing|studios|entertainment)$/i, '')
    .replace(/[!.]/g, '');
}

export const WESTERN_PUBLISHERS = [
  'Marvel', 'Marvel Comics', 'DC', 'DC Comics', 'Image', 'Image Comics', 'Dark Horse', 'Dark Horse Comics',
  'IDW', 'IDW Publishing', 'BOOM! Studios', 'Dynamite Entertainment', 'Titan Comics', 'Oni Press',
  'Lion Forge', 'Mad Cave Studios', 'Mad Cave', 'Vault Comics', 'Valiant', 'Valiant Entertainment',
  'AWA Studios', 'AfterShock Comics', 'Skybound', 'Archie Comics', 'Fantagraphics', 'Rebellion', '2000 AD',
  'Ablaze', 'Scout Comics', 'Zenescope Entertainment', 'Antarctic Press', 'Action Lab', 'Black Mask Studios',
  'Humanoids', 'Ahoy Comics', 'Massive Publishing', 'Clover Press', 'Abstract Studio', 'Top Cow',
  'Vertigo', 'DC Black Label', 'Papercutz', 'First Second', 'Drawn & Quarterly', 'Legendary Comics',
  'Aspen', 'Aspen MLT', 'Red 5 Comics', 'Heavy Metal', 'Bad Idea', 'TKO Studios', 'DSTLRY',
  'American Mythology Productions', "Devil's Due", 'Keenspot Entertainment', 'Alien Books', 'Ignition Press',
  'Invader Comics', 'Floating World Comics', 'UDON', 'Harry N. Abrams', 'Abrams ComicArts', 'Wildstorm',
  'Icon', 'Blackbox Comics', 'Behemoth', 'Whatnot Publishing', 'Oni-Lion Forge', 'Boom Entertainment',
];

const WESTERN_NORM = new Set(WESTERN_PUBLISHERS.map(normPublisher));

export function isWestern(publisher) { return !!publisher && WESTERN_NORM.has(normPublisher(publisher)); }
