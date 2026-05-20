import { describe, it, expect } from 'vitest';
import { normaliseClub, VALID_CLUB_CODES } from '../../src/shared/domain/club-code';

describe('normaliseClub', () => {
  it('returns canonical codes unchanged', () => {
    expect(normaliseClub('DR')).toBe('DR');
    expect(normaliseClub('7I')).toBe('7I');
    expect(normaliseClub('PT')).toBe('PT');
    expect(normaliseClub('SW')).toBe('SW');
  });

  it('normalises verbose iron names: "7 Iron" → "7I"', () => {
    expect(normaliseClub('7 Iron')).toBe('7I');
    expect(normaliseClub('5 Iron')).toBe('5I');
    expect(normaliseClub('9 Iron')).toBe('9I');
  });

  it('normalises "7iron" (no space)', () => {
    expect(normaliseClub('7iron')).toBe('7I');
  });

  it('normalises "Driver" → "DR"', () => {
    expect(normaliseClub('Driver')).toBe('DR');
    expect(normaliseClub('DRIVER')).toBe('DR');
    expect(normaliseClub('driver')).toBe('DR');
  });

  it('normalises "Putter" → "PT"', () => {
    expect(normaliseClub('Putter')).toBe('PT');
    expect(normaliseClub('PUTTER')).toBe('PT');
  });

  it('normalises wedges: "Pitching Wedge" → "PW"', () => {
    expect(normaliseClub('Pitching Wedge')).toBe('PW');
    expect(normaliseClub('Sand Wedge')).toBe('SW');
    expect(normaliseClub('Lob Wedge')).toBe('LW');
    expect(normaliseClub('Gap Wedge')).toBe('GW');
    expect(normaliseClub('Approach Wedge')).toBe('AW');
  });

  it('normalises woods: "3 Wood" → "3W"', () => {
    expect(normaliseClub('3 Wood')).toBe('3W');
    expect(normaliseClub('5 Wood')).toBe('5W');
    expect(normaliseClub('3wood')).toBe('3W');
  });

  it('normalises hybrids: "4 Hybrid" → "4H"', () => {
    expect(normaliseClub('4 Hybrid')).toBe('4H');
    expect(normaliseClub('3 Hybrid')).toBe('3H');
    expect(normaliseClub('5hybrid')).toBe('5H');
  });

  it('normalises case-insensitive exact codes: "7i" → "7I"', () => {
    expect(normaliseClub('7i')).toBe('7I');
    expect(normaliseClub('dr')).toBe('DR');
    expect(normaliseClub('pw')).toBe('PW');
  });

  it('normalises inverted iron format "I7" → "7I" (ProSwing convention)', () => {
    expect(normaliseClub('I7')).toBe('7I');
    expect(normaliseClub('I5')).toBe('5I');
    expect(normaliseClub('I9')).toBe('9I');
    expect(normaliseClub('I0')).toBe('UNKNOWN'); // no 0-iron exists
  });

  it('returns UNKNOWN for unrecognised clubs', () => {
    expect(normaliseClub('UNKNOWN_CLUB_XYZ')).toBe('UNKNOWN');
    expect(normaliseClub('')).toBe('UNKNOWN');
    expect(normaliseClub('14 Iron')).toBe('UNKNOWN');
  });

  it('VALID_CLUB_CODES contains expected canonical codes', () => {
    expect(VALID_CLUB_CODES).toContain('DR');
    expect(VALID_CLUB_CODES).toContain('7I');
    expect(VALID_CLUB_CODES).toContain('PT');
    expect(VALID_CLUB_CODES).toContain('UNKNOWN');
    expect(VALID_CLUB_CODES.length).toBeGreaterThan(20);
  });
});
