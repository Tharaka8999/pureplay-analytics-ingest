export const VALID_CLUB_CODES = [
  "DR",
  "3W",
  "4W",
  "5W",
  "7W",
  "2H",
  "3H",
  "4H",
  "5H",
  "1I",
  "2I",
  "3I",
  "4I",
  "5I",
  "6I",
  "7I",
  "8I",
  "9I",
  "PW",
  "GW",
  "AW",
  "SW",
  "LW",
  "PT",
  "UNKNOWN",
] as const;

export type ClubCode = (typeof VALID_CLUB_CODES)[number];

const ALIAS_MAP: Record<string, ClubCode> = {
  // Driver
  driver: "DR",
  // Woods
  "3 wood": "3W",
  "4 wood": "4W",
  "5 wood": "5W",
  "7 wood": "7W",
  "3wood": "3W",
  "4wood": "4W",
  "5wood": "5W",
  "7wood": "7W",
  // Hybrids
  "2 hybrid": "2H",
  "3 hybrid": "3H",
  "4 hybrid": "4H",
  "5 hybrid": "5H",
  "2hybrid": "2H",
  "3hybrid": "3H",
  "4hybrid": "4H",
  "5hybrid": "5H",
  // Irons
  "1 iron": "1I",
  "2 iron": "2I",
  "3 iron": "3I",
  "4 iron": "4I",
  "5 iron": "5I",
  "6 iron": "6I",
  "7 iron": "7I",
  "8 iron": "8I",
  "9 iron": "9I",
  "1iron": "1I",
  "2iron": "2I",
  "3iron": "3I",
  "4iron": "4I",
  "5iron": "5I",
  "6iron": "6I",
  "7iron": "7I",
  "8iron": "8I",
  "9iron": "9I",
  // Wedges
  "pitching wedge": "PW",
  "gap wedge": "GW",
  "approach wedge": "AW",
  "sand wedge": "SW",
  "lob wedge": "LW",
  // Putter
  putter: "PT",
};

export function normaliseClub(raw: string): ClubCode {
  if (!raw) return "UNKNOWN";

  const upper = raw.trim().toUpperCase();

  // Check if it's already a canonical code
  if ((VALID_CLUB_CODES as readonly string[]).includes(upper)) {
    return upper as ClubCode;
  }

  // Inverted iron format: "I7" → "7I" (ProSwing sends iron-number reversed)
  const invertedIron = upper.match(/^I(\d)$/);
  if (invertedIron) {
    const candidate = `${invertedIron[1]}I` as ClubCode;
    if ((VALID_CLUB_CODES as readonly string[]).includes(candidate)) {
      return candidate;
    }
  }

  // Lookup alias map (case-insensitive)
  const lower = raw.trim().toLowerCase();
  const aliasMatch = ALIAS_MAP[lower];
  if (aliasMatch) return aliasMatch;

  return "UNKNOWN";
}
