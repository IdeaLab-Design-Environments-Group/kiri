export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

export function formatAngleDeg(rad: number, digits = 2): string {
  return `${radToDeg(rad).toFixed(digits)}°`;
}

export function formatMm(value: number, digits = 2): string {
  return `${value.toFixed(digits)} mm`;
}
