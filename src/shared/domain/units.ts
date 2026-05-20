// All conversion functions return SI units (metres, metres-per-second, RPM).
// right-positive lateral convention is enforced at the parser level.

export const MPH_TO_MPS = 0.44704;
export const KPH_TO_MPS = 1 / 3.6;
export const FT_TO_M = 0.3048;
export const YD_TO_M = 0.9144;
export const INCH_TO_M = 0.0254;

export function mphToMps(mph: number): number {
  return mph * MPH_TO_MPS;
}

export function kphToMps(kph: number): number {
  return kph * KPH_TO_MPS;
}

export function mpsToMps(mps: number): number {
  return mps;
}

export function ftToM(ft: number): number {
  return ft * FT_TO_M;
}

export function ydToM(yd: number): number {
  return yd * YD_TO_M;
}

export function inchToM(inches: number): number {
  return inches * INCH_TO_M;
}

export function rpmToRpm(rpm: number): number {
  return rpm;
}
