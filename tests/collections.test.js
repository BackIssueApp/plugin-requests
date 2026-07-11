// Collected-edition detection (isCollection) — the "no compilations" request
// filter. Cases taken from real CloneVine catalogue examples.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCollection } from '../collections.js';

const v = (name, count_of_issues = 1, description = null) => ({ name, count_of_issues, description });

test('strong format keywords flag unconditionally (even at high issue counts)', () => {
  for (const n of [
    'Predator Omnibus', 'Batman Omnibus', 'Marvel Masterworks: The Fantastic Four',
    'Iron Man Epic Collection: The Enemy Within', 'The Walking Dead Compendium',
    'Fables: The Deluxe Edition', 'Buffy The Vampire Slayer Season 8: Library Edition',
    'Purgatori Collected Edition', 'Marvel Treasury Edition', 'Joe Kubert\'s Tor Artist\'s Edition',
    'Cat\'s Eye: Complete Edition', 'X-Men: Dark Phoenix Saga TPB',
  ]) assert.equal(isCollection(v(n, 40)), true, n);
  // multi-volume collection lines: high count, still a collection
  assert.equal(isCollection(v('Judge Dredd The Complete Case Files', 47)), true);
  assert.equal(isCollection(v('The Complete Peanuts', 26)), true);
});

test('ambiguous words flag only at a low issue count', () => {
  // low count → collection
  assert.equal(isCollection(v('Bone Collection', 2)), true);
  assert.equal(isCollection(v('Marvel Universe Ultimate Spider-Man Digest', 7)), true);
  assert.equal(isCollection(v('Complete Ballad of Halo Jones', 1)), true);
  // high count → an ongoing series that just has the word in its title
  assert.equal(isCollection(v('Collection Vedette', 48)), false);
  assert.equal(isCollection(v('Rat-Man Collection', 123)), false);
  assert.equal(isCollection(v('Laugh Comics Digest', 200)), false);
});

test('the "Collects …" blurb flags a collection whose name has no keyword', () => {
  assert.equal(isCollection(v('Daredevil: The Man Without Fear', 1, '<p>Collects issues #1-5.</p>')), true);
  assert.equal(isCollection(v('The Flash: Rogues', 1, 'Collected edition of the acclaimed storyline.')), true);
});

test('description that OPENS as a collected format flags (OGNs / TPBs with clean names)', () => {
  // God of War: Fallen God — the TPB is flagged, the source mini-series is not.
  assert.equal(isCollection(v('God of War: Fallen God', 1, 'Trade paperback collecting God of War: Fallen God.')), true);
  assert.equal(isCollection(v('God of War: Fallen God', 4, 'Four issue mini-series. Collected in God of War: Fallen God')), false);
  assert.equal(isCollection(v('Steve Jobs: Insanely Great', 1, 'Graphic novel.')), true);
  assert.equal(isCollection(v('Powers: Cosmic', 1, 'Trade paperback collecting Powers #13-18.')), true);
  // A series that merely mentions being collected elsewhere is NOT a collection.
  assert.equal(isCollection(v('Astro City', 23, 'Volume 2 of Astro City. Issues #1-3 were collected in the omnibus.')), false);
});

test('real ongoing series are not flagged', () => {
  for (const [n, c] of [['Saga', 72], ['The Walking Dead', 193], ['Batman', 900],
    ['Kemeko Deluxe!', 9], ['Absolute Batman', 3], ['Completely Cracked', 4]])
    assert.equal(isCollection(v(n, c)), false, n);
});
