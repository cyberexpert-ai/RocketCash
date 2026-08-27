import axios from 'axios';
import { db } from '../db';
import { decrypt } from '../utils/crypto';
import { logger } from '../utils/logger';

async function getIFSCConfig(): Promise<{ providerUrl: string; apiKey?: string }> {
  const { rows } = await db.query(
    `SELECT config FROM provider_configs WHERE provider_name = 'ifsc'`
  );
  const config = rows[0]?.config || {};
  return {
    providerUrl: config.provider_url || 'https://ifsc.razorpay.com',
    apiKey: config.api_key || '',
  };
}

export async function validateIFSC(ifscCode: string): Promise<{
  valid: boolean;
  bank?: string;
  branch?: string;
  address?: string;
  city?: string;
  state?: string;
}> {
  const code = ifscCode.toUpperCase().trim();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(code)) return { valid: false };

  try {
    const { providerUrl } = await getIFSCConfig();
    const response = await axios.get(`${providerUrl}/${code}`, { timeout: 5000 });
    const data = response.data;
    return {
      valid: true,
      bank: data.BANK,
      branch: data.BRANCH,
      address: data.ADDRESS,
      city: data.CITY,
      state: data.STATE,
    };
  } catch (err: any) {
    if (err.response?.status === 404) return { valid: false };
    logger.error('IFSC validation error', { ifscCode, err: err.message });
    // Don't block on IFSC provider error — allow manual entry
    return { valid: true, bank: 'Unknown', branch: 'Unknown' };
  }
}

export async function searchIFSC(bankName: string, city?: string, branch?: string): Promise<any[]> {
  // Use Razorpay IFSC search if available
  try {
    const { providerUrl } = await getIFSCConfig();
    const params: any = { bank: bankName };
    if (city) params.city = city;
    if (branch) params.branch = branch;

    const response = await axios.get(`${providerUrl}/search`, { params, timeout: 5000 });
    return response.data || [];
  } catch {
    return [];
  }
}

export async function getBankDetails(ifscCode: string): Promise<any | null> {
  const result = await validateIFSC(ifscCode);
  return result.valid ? result : null;
}

export function validateUPIId(upiId: string): boolean {
  // Basic UPI ID format validation: localpart@provider
  return /^[a-zA-Z0-9._-]+@[a-zA-Z]{3,}$/.test(upiId);
}
