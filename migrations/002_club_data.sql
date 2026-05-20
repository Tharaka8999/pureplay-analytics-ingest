-- Pureplay Analytics Ingest — club reference data (PostgreSQL DDL + seed)
-- Safe to run on every startup: tables use IF NOT EXISTS, INSERTs use ON CONFLICT DO NOTHING.
-- Evolved design: club aliases are DB-managed, not hardcoded.
-- Adding a new vendor alias = an INSERT, not a code deploy.

-- ──────────────────────────────────────────────────────────────
-- CLUB_CODES — canonical code registry with metadata
-- loft_deg_min / loft_deg_max: typical range for sanity-checking
--   an inbound shot (e.g. 300 m carry on a PW is a parser bug).
-- excluded_from_distance_stats: true for putter; carry/total carry
--   are meaningless on putting greens.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS club_codes (
  club_code                    VARCHAR(8)   PRIMARY KEY,
  display_name                 VARCHAR(64)  NOT NULL,
  category                     VARCHAR(16)  NOT NULL CHECK (category IN ('wood','hybrid','iron','wedge','putter','unknown')),
  loft_deg_min                 NUMERIC(4,1),
  loft_deg_max                 NUMERIC(4,1),
  excluded_from_distance_stats BOOLEAN      NOT NULL DEFAULT false
);

-- ──────────────────────────────────────────────────────────────
-- CLUB_ALIASES — raw vendor string → canonical code mapping
-- alias: stored lowercase + trimmed; lookup normalises the same way.
-- source: 'seed' for rows shipped here; 'ops' for ops-added rows.
-- confirmed_by / confirmed_at_utc: set when ops reviews a suggested alias.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS club_aliases (
  alias              VARCHAR(128) PRIMARY KEY,   -- lowercase, trimmed; longest realistic alias
  club_code          VARCHAR(8)   NOT NULL REFERENCES club_codes(club_code),
  source             VARCHAR(16)  NOT NULL CHECK (source IN ('seed','ops','auto_suggested')) DEFAULT 'seed',
  confirmed_by       VARCHAR(255),
  confirmed_at_utc   TIMESTAMPTZ,
  created_at_utc     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS club_aliases_club_code
  ON club_aliases (club_code);

-- ──────────────────────────────────────────────────────────────
-- UNKNOWN_CLUB_ALIASES — ops review queue for unrecognised raw strings
-- Every shot with club_code = 'UNKNOWN' is also recorded here.
-- Ops reviews this table and promotes rows to club_aliases.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS unknown_club_aliases (
  alias              VARCHAR(128) PRIMARY KEY,   -- lowercase, trimmed
  first_seen_at_utc  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_seen_at_utc   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  seen_count         INTEGER      NOT NULL DEFAULT 1
);

-- ──────────────────────────────────────────────────────────────
-- SEED: club_codes
-- Loft ranges are conventional mid-player typical values.
-- A shot outside the loft range is suspicious but not rejected —
-- the parser logs a warning; the range is advisory not a DB CHECK.
-- ──────────────────────────────────────────────────────────────

INSERT INTO club_codes (club_code, display_name, category, loft_deg_min, loft_deg_max, excluded_from_distance_stats)
VALUES
  -- Driver
  ('DR',      'Driver',          'wood',    7.0,   12.0,  false),
  -- Fairway woods
  ('3W',      '3 Wood',          'wood',    13.0,  17.0,  false),
  ('4W',      '4 Wood',          'wood',    15.0,  19.0,  false),
  ('5W',      '5 Wood',          'wood',    18.0,  22.0,  false),
  ('7W',      '7 Wood',          'wood',    20.0,  24.0,  false),
  -- Hybrids
  ('2H',      '2 Hybrid',        'hybrid',  17.0,  20.0,  false),
  ('3H',      '3 Hybrid',        'hybrid',  19.0,  22.0,  false),
  ('4H',      '4 Hybrid',        'hybrid',  22.0,  25.0,  false),
  ('5H',      '5 Hybrid',        'hybrid',  24.0,  28.0,  false),
  -- Irons
  ('1I',      '1 Iron',          'iron',    15.0,  18.0,  false),
  ('2I',      '2 Iron',          'iron',    17.0,  21.0,  false),
  ('3I',      '3 Iron',          'iron',    20.0,  23.0,  false),
  ('4I',      '4 Iron',          'iron',    23.0,  26.0,  false),
  ('5I',      '5 Iron',          'iron',    25.0,  29.0,  false),
  ('6I',      '6 Iron',          'iron',    29.0,  33.0,  false),
  ('7I',      '7 Iron',          'iron',    33.0,  37.0,  false),
  ('8I',      '8 Iron',          'iron',    37.0,  41.0,  false),
  ('9I',      '9 Iron',          'iron',    41.0,  45.0,  false),
  -- Wedges (GW and AW overlap by loft — they are category conventions, not loft-defined)
  ('PW',      'Pitching Wedge',  'wedge',   43.0,  48.0,  false),
  ('GW',      'Gap Wedge',       'wedge',   49.0,  53.0,  false),
  ('AW',      'Approach Wedge',  'wedge',   49.0,  53.0,  false),
  ('SW',      'Sand Wedge',      'wedge',   54.0,  58.0,  false),
  ('LW',      'Lob Wedge',       'wedge',   59.0,  64.0,  false),
  -- Putter
  ('PT',      'Putter',          'putter',  2.0,   6.0,   true),
  -- Sentinel
  ('UNKNOWN', 'Unknown',         'unknown', NULL,  NULL,  false)
ON CONFLICT (club_code) DO NOTHING;

-- ──────────────────────────────────────────────────────────────
-- SEED: club_aliases
-- All aliases are stored lowercase + trimmed (matching the normalisation
-- applied at lookup time). ON CONFLICT DO NOTHING keeps this idempotent.
-- ──────────────────────────────────────────────────────────────

INSERT INTO club_aliases (alias, club_code, source)
VALUES
  -- ── Driver ─────────────────────────────────────────────────
  ('driver',          'DR',  'seed'),   -- SwingMetric sample: "Driver"
  ('dr',              'DR',  'seed'),
  ('1w',              'DR',  'seed'),   -- some vendors call driver "1 wood"
  ('1 wood',          'DR',  'seed'),
  ('1wood',           'DR',  'seed'),

  -- ── Fairway woods ──────────────────────────────────────────
  ('3w',              '3W',  'seed'),
  ('3 wood',          '3W',  'seed'),
  ('3wood',           '3W',  'seed'),
  ('3-wood',          '3W',  'seed'),
  ('fairway 3',       '3W',  'seed'),
  ('4w',              '4W',  'seed'),
  ('4 wood',          '4W',  'seed'),
  ('4wood',           '4W',  'seed'),
  ('4-wood',          '4W',  'seed'),
  ('5w',              '5W',  'seed'),
  ('5 wood',          '5W',  'seed'),
  ('5wood',           '5W',  'seed'),
  ('5-wood',          '5W',  'seed'),
  ('fairway 5',       '5W',  'seed'),
  ('7w',              '7W',  'seed'),
  ('7 wood',          '7W',  'seed'),
  ('7wood',           '7W',  'seed'),
  ('7-wood',          '7W',  'seed'),

  -- ── Hybrids ────────────────────────────────────────────────
  ('2h',              '2H',  'seed'),
  ('2 hybrid',        '2H',  'seed'),
  ('2hybrid',         '2H',  'seed'),
  ('2-hybrid',        '2H',  'seed'),
  ('hybrid 2',        '2H',  'seed'),
  ('3h',              '3H',  'seed'),
  ('3 hybrid',        '3H',  'seed'),
  ('3hybrid',         '3H',  'seed'),
  ('3-hybrid',        '3H',  'seed'),
  ('hybrid 3',        '3H',  'seed'),
  ('4h',              '4H',  'seed'),
  ('4 hybrid',        '4H',  'seed'),
  ('4hybrid',         '4H',  'seed'),
  ('4-hybrid',        '4H',  'seed'),
  ('hybrid 4',        '4H',  'seed'),
  ('5h',              '5H',  'seed'),
  ('5 hybrid',        '5H',  'seed'),
  ('5hybrid',         '5H',  'seed'),
  ('5-hybrid',        '5H',  'seed'),
  ('hybrid 5',        '5H',  'seed'),

  -- ── Irons — short code (lowercase canonical) ───────────────
  ('1i',              '1I',  'seed'),
  ('2i',              '2I',  'seed'),
  ('3i',              '3I',  'seed'),
  ('4i',              '4I',  'seed'),
  ('5i',              '5I',  'seed'),
  ('6i',              '6I',  'seed'),
  ('7i',              '7I',  'seed'),   -- TrackPro sample: "7i"
  ('8i',              '8I',  'seed'),
  ('9i',              '9I',  'seed'),

  -- ── Irons — ProSwing inverted format (I<n>) ────────────────
  ('i1',              '1I',  'seed'),
  ('i2',              '2I',  'seed'),
  ('i3',              '3I',  'seed'),
  ('i4',              '4I',  'seed'),
  ('i5',              '5I',  'seed'),
  ('i6',              '6I',  'seed'),
  ('i7',              '7I',  'seed'),   -- ProSwing sample: "I7"
  ('i8',              '8I',  'seed'),
  ('i9',              '9I',  'seed'),

  -- ── Irons — verbose ────────────────────────────────────────
  ('1 iron',          '1I',  'seed'),
  ('2 iron',          '2I',  'seed'),
  ('3 iron',          '3I',  'seed'),
  ('4 iron',          '4I',  'seed'),
  ('5 iron',          '5I',  'seed'),
  ('6 iron',          '6I',  'seed'),
  ('7 iron',          '7I',  'seed'),
  ('8 iron',          '8I',  'seed'),
  ('9 iron',          '9I',  'seed'),
  ('1iron',           '1I',  'seed'),
  ('2iron',           '2I',  'seed'),
  ('3iron',           '3I',  'seed'),
  ('4iron',           '4I',  'seed'),
  ('5iron',           '5I',  'seed'),
  ('6iron',           '6I',  'seed'),
  ('7iron',           '7I',  'seed'),
  ('8iron',           '8I',  'seed'),
  ('9iron',           '9I',  'seed'),
  ('1-iron',          '1I',  'seed'),
  ('2-iron',          '2I',  'seed'),
  ('3-iron',          '3I',  'seed'),
  ('4-iron',          '4I',  'seed'),
  ('5-iron',          '5I',  'seed'),
  ('6-iron',          '6I',  'seed'),
  ('7-iron',          '7I',  'seed'),
  ('8-iron',          '8I',  'seed'),
  ('9-iron',          '9I',  'seed'),
  ('iron 1',          '1I',  'seed'),
  ('iron 2',          '2I',  'seed'),
  ('iron 3',          '3I',  'seed'),
  ('iron 4',          '4I',  'seed'),
  ('iron 5',          '5I',  'seed'),
  ('iron 6',          '6I',  'seed'),
  ('iron 7',          '7I',  'seed'),
  ('iron 8',          '8I',  'seed'),
  ('iron 9',          '9I',  'seed'),

  -- ── Pitching wedge ─────────────────────────────────────────
  ('pw',              'PW',  'seed'),
  ('pitching wedge',  'PW',  'seed'),
  ('pitching-wedge',  'PW',  'seed'),
  ('pitchingwedge',   'PW',  'seed'),
  ('p wedge',         'PW',  'seed'),

  -- ── Gap / Approach wedge ───────────────────────────────────
  ('gw',              'GW',  'seed'),
  ('gap wedge',       'GW',  'seed'),
  ('gap-wedge',       'GW',  'seed'),
  ('gapwedge',        'GW',  'seed'),
  ('aw',              'AW',  'seed'),
  ('approach wedge',  'AW',  'seed'),
  ('approach-wedge',  'AW',  'seed'),
  ('approachwedge',   'AW',  'seed'),
  ('a wedge',         'AW',  'seed'),

  -- ── Sand wedge ─────────────────────────────────────────────
  ('sw',              'SW',  'seed'),
  ('sand wedge',      'SW',  'seed'),
  ('sand-wedge',      'SW',  'seed'),
  ('sandwedge',       'SW',  'seed'),

  -- ── Lob wedge ──────────────────────────────────────────────
  ('lw',              'LW',  'seed'),
  ('lob wedge',       'LW',  'seed'),
  ('lob-wedge',       'LW',  'seed'),
  ('lobwedge',        'LW',  'seed'),

  -- ── Putter ─────────────────────────────────────────────────
  ('pt',              'PT',  'seed'),
  ('putter',          'PT',  'seed'),
  ('putt',            'PT',  'seed')

ON CONFLICT (alias) DO NOTHING;
