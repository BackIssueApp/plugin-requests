# Changelog

Notable, user-facing changes per release. Format follows [Keep a Changelog](https://keepachangelog.com);
versions follow the tags in this repository (`vX.Y.Z` → the release bundle BackIssue's plugin catalog installs).

Contributors: please **don't** edit this file in pull requests — entries are added
by the maintainers when changes merge, so concurrent PRs don't conflict here.

## [Unreleased]

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
