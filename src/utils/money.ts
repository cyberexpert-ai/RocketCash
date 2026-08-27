/**
 * MONEY HANDLING — Always use integer paise (1 INR = 100 paise)
 * NEVER use JavaScript floating point for currency calculations.
 */

export function paiseToRupees(paise: number): string {
  const rupees = Math.floor(paise / 100);
  const paisePart = paise % 100;
  return `₹${rupees}.${paisePart.toString().padStart(2, '0')}`;
}

export function rupeesToPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

export function formatRupees(paise: number): string {
  return paiseToRupees(paise);
}

export function validateAmount(paise: number): boolean {
  return Number.isInteger(paise) && paise > 0;
}

export function validateWithdrawalAmount(paise: number, minPaise: number, maxPaise: number): string | null {
  if (!Number.isInteger(paise) || paise <= 0) return 'Invalid amount';
  if (paise < minPaise) return `Minimum withdrawal is ${paiseToRupees(minPaise)}`;
  if (paise > maxPaise) return `Maximum withdrawal is ${paiseToRupees(maxPaise)}`;
  return null;
}
