# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

### Changed

- **Approved book requests are retried every six hours.** The task that
  checks whether a request has arrived, and asks the download sources again,
  had no schedule, so it only ran when started by hand. Change or turn off
  the schedule under Jobs.

## [1.5.0] — 2026-10-17

### Added

- **Translated UI.** The Requests overlay, its settings toggles and the
  sidebar entry follow the language picked under Profile → Language on
  BackIssue 0.9.1 and newer, English on older ones. Translations ship for
  French, German, Spanish, Italian, Portuguese (Portugal and Brazil), Dutch,
  Polish, Japanese and Simplified Chinese in `locales/`. Also covers the
  permission, job and library-type labels, the plugin description and the
  notification titles shown in BackIssue’s own screens.

## [1.4.0] — 2026-09-12

### Added

- **Books and audiobooks can be requested.** Where the Ebooks or Audiobooks
  plugin is installed and a library of that type exists, *Find & request*
  gains a Books / Audiobooks switch: search by title or author (the metadata
  service), see at once what is already on the shelf or already asked for,
  and file a request with a note. Duplicates second the existing request,
  votes work the same, and the queue shows a kind badge. The mobile apps'
  comic requests are unchanged.
- **Approving a book downloads it.** Approval asks your download sources
  for it — usenet and torrent, and any site source that carries books or
  audiobooks — grabs the best release, and the Ebooks or Audiobooks plugin
  files it into the library when it lands (needs app 0.8.4 or later). The
  queue row says which source is downloading it, or why it failed. When no
  source has it, the request stays approved-and-waiting: the new **Fill
  approved book requests** job asks again on its schedule, and a scan or
  import that matches by title and author counts too. The requester is told
  when it lands. On-demand catalogs are not consulted — what they carry is
  on the shelf already. A book's ISBN is kept with the request and handed
  to the sources, so a catalog site is asked for the exact edition.

## [1.3.1] — 2026-09-07

### Fixed

- **The sidebar badge no longer downloads the whole queue.** It asked for
  every request, with covers and notes, on every page load just to show the
  pending count. A count route answers that in a few bytes.

## [1.3.0] — 2026-09-04

### Changed

- Approving a request (by hand or auto-approve) now **picks** every missing
  issue of the volume for the requester, so the core's automation keeps after
  them regardless of the series' monitoring policy and the requester is told
  when each one arrives. Needs a core with per-issue picks; older cores are
  unaffected.

## [1.2.4] — 2026-07-18

### Changed
- Settings moved from **Settings → Sources** to the dedicated **Settings →
  Plugins** tab (falls back to the Sources area on cores without it).


## [1.2.3] — 2026-07-12

### Fixed
- **No collections** now also catches collected editions whose description
  states what it collects a little past the very start — e.g. after a "NOTE:"
  or "Advertisement" lead-in (*X-Men Legends Vol. 2: The Dark Phoenix Saga* →
  "Trade Paperback collecting Uncanny X-Men #129-137"; *Batman: The Dark Knight
  Returns* → "Collects Batman: The Dark Knight #1-4"). It scans the **start** of
  the description, so an ongoing series that merely lists its own collected
  editions further down, or narrates being "collected in" an omnibus, stays
  requestable. Validated against the full ComicVine catalogue.

## [1.2.2] — 2026-07-11

### Fixed
- **No collections** now filters the request **search** results too, not just
  the request-create step. The search pulls volume descriptions when the filter
  is on, so a collected edition with a plain title (e.g. *God of War: Fallen
  God*'s trade paperback) is hidden from results instead of appearing and only
  being rejected when requested. (Needs a BackIssue core that supports
  description-in-search; older cores still enforce it at request time.)

## [1.2.1] — 2026-07-11

### Fixed
- **No collections** now also detects collected editions from the volume's
  description opener ("Trade paperback collecting …", "Graphic novel", "Collects
  #1-6"), so original graphic novels and TPBs with a plain title — e.g. *God of
  War: Fallen God* — are caught, not only ones with a format word in the name. A
  series that merely mentions being "collected in" an omnibus stays requestable.

## [1.2.0] — 2026-07-11

### Added
- **No collections** setting: when on, collected editions — trade paperbacks,
  hardcovers, omnibuses, "Complete" collections, and similar — are hidden from
  request search and rejected on create, so only single-issue series can be
  requested. ComicVine has no format field, so it's detected heuristically from
  the volume's title and description (validated against the full CloneVine
  catalogue); it catches the large majority but isn't perfect.

## [1.1.0] — 2026-07-10

### Added
- **Western comics only** setting: when on, search and requests are limited to
  Western (US/UK) publishers via a publisher allowlist — manga and
  foreign-language titles are hidden and rejected.

### Changed
- Auto-approved requests now download their missing issues automatically when
  the server's **Download on add** setting is enabled, regardless of the
  requester's own download permission (it's a server-wide automation). With
  that setting off, downloads still follow the requester's permission as before.

## [1.0.0] — 2026-07-08

Initial release: a volume request queue. Users ask for series to be added,
vote on each other's requests, and leave notes; curators approve or decline,
with optional auto-approve. Approved requests download under the requester's
own permissions.
