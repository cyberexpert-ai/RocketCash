import { Request, Response, NextFunction } from 'express';
import { validateSession } from '../../services/auth';
import { hashSensitive } from '../../utils/crypto';

export interface AuthRequest extends Request {
  userId?: string;        // authenticated user ID from session — ONLY source of truth
  telegramId?: number;
}

/**
 * Middleware that validates session token and sets req.userId.
 * NEVER trusts user_id/telegram_id from frontend.
 */
export async function requireAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.replace('Bearer ', '') ||
                req.headers['x-session-token'] as string;

  if (!token) {
    res.status(401).json({ error: 'Unauthorized', message: 'No session token' });
    return;
  }

  const userId = await validateSession(token);
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized', message: 'Invalid or expired session' });
    return;
  }

  req.userId = userId;
  next();
}

/**
 * Optionally attach userId if session exists, but don't block.
 */
export async function optionalAuth(req: AuthRequest, res: Response, next: NextFunction): Promise<void> {
  const token = req.headers.authorization?.replace('Bearer ', '') ||
                req.headers['x-session-token'] as string;
  if (token) {
    const userId = await validateSession(token);
    if (userId) req.userId = userId;
  }
  next();
}

export function getIpHash(req: Request): string {
  const ip = req.headers['x-forwarded-for']?.toString().split(',')[0] ||
             req.socket.remoteAddress || '';
  return hashSensitive(ip);
}

export function getUserAgentHash(req: Request): string {
  return hashSensitive(req.headers['user-agent'] || '');
}
