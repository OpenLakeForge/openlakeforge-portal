/** Decorative depth of the i-th of n stages: the first is shallow (10m), the last deepest (80m). */
export const depthOf = (i: number, n: number) => `${n < 2 ? 10 : Math.round(10 + (70 * i) / (n - 1))}m`;
