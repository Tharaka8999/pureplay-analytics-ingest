import { describe, it, expect } from 'vitest';
import {
  mphToMps,
  kphToMps,
  mpsToMps,
  ftToM,
  ydToM,
  inchToM,
  rpmToRpm,
} from '../../src/shared/domain/units';

describe('unit converters', () => {
  describe('mphToMps', () => {
    it('converts 0 mph to 0 mps', () => {
      expect(mphToMps(0)).toBeCloseTo(0, 5);
    });

    it('converts 100 mph to 44.704 mps', () => {
      expect(mphToMps(100)).toBeCloseTo(44.704, 3);
    });

    it('converts 150 mph (max possible) correctly', () => {
      expect(mphToMps(150)).toBeCloseTo(67.056, 3);
    });
  });

  describe('kphToMps', () => {
    it('converts 0 kph to 0 mps', () => {
      expect(kphToMps(0)).toBe(0);
    });

    it('converts 180 kph to 50 mps', () => {
      expect(kphToMps(180)).toBeCloseTo(50, 3);
    });

    it('converts 100 kph correctly', () => {
      expect(kphToMps(100)).toBeCloseTo(27.778, 3);
    });
  });

  describe('mpsToMps', () => {
    it('is identity function', () => {
      expect(mpsToMps(57.9)).toBe(57.9);
    });
  });

  describe('ftToM', () => {
    it('converts 1 ft to 0.3048 m', () => {
      expect(ftToM(1)).toBeCloseTo(0.3048, 4);
    });

    it('converts 10 ft correctly', () => {
      expect(ftToM(10)).toBeCloseTo(3.048, 4);
    });

    it('handles negative (left deviation)', () => {
      expect(ftToM(-5)).toBeCloseTo(-1.524, 4);
    });
  });

  describe('ydToM', () => {
    it('converts 100 yd to 91.44 m', () => {
      expect(ydToM(100)).toBeCloseTo(91.44, 2);
    });

    it('converts 1 yd to 0.9144 m', () => {
      expect(ydToM(1)).toBeCloseTo(0.9144, 4);
    });

    it('handles negative (left of target)', () => {
      expect(ydToM(-10)).toBeCloseTo(-9.144, 3);
    });
  });

  describe('inchToM', () => {
    it('converts 12 inches to 0.3048 m', () => {
      expect(inchToM(12)).toBeCloseTo(0.3048, 4);
    });
  });

  describe('rpmToRpm', () => {
    it('is identity function', () => {
      expect(rpmToRpm(6500)).toBe(6500);
    });
  });
});
