import rateLimit from 'express-rate-limit';
import { config } from '../../config';

export const generalLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.max,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests', message: 'Please slow down.' },
});

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Too many auth attempts' },
});

export const spinLimiter = rateLimit({
  windowMs: 5 * 1000,
  max: 3,
  message: { error: 'Too many spin requests' },
});

export const withdrawLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many withdrawal requests' },
});

export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 500,
  message: { error: 'Too many webhook requests' },
});
