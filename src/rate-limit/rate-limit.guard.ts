import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../common/guards/api-key.guard';
import { withSpan } from '../tracing/span';
import { RateLimitDecision, RateLimitService } from './rate-limit.service';

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(private readonly rateLimit: RateLimitService) {}

  canActivate(context: ExecutionContext): Promise<boolean> {
    return withSpan('ratelimit.consume', {}, async (span) => {
      const http = context.switchToHttp();
      const req = http.getRequest<AuthenticatedRequest>();
      const res = http.getResponse<Response>();

      if (!req.apiKeyId) {
        throw new Error('RateLimitGuard used on a route without ApiKeyGuard');
      }

      const decision = await this.rateLimit.consume(
        req.apiKeyId,
        req.apiKeyRateLimit,
      );

      setHeaders(res, decision);
      span.setAttribute('ratelimit.limit', decision.limit);
      span.setAttribute('ratelimit.remaining', decision.remaining);
      span.setAttribute('ratelimit.degraded', decision.degraded);

      if (!decision.allowed) {
        // a caller over the limit gets told when to come back rather than being
        // left to guess, and never reaches the cache or a provider
        throw new HttpException(
          {
            error: {
              message: 'rate limit exceeded',
              type: 'rate_limit_error',
              limit: decision.limit,
              reset_at: new Date(decision.resetAt).toISOString(),
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      return true;
    });
  }
}

function setHeaders(res: Response, decision: RateLimitDecision): void {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((decision.resetAt - Date.now()) / 1000),
  );

  res.setHeader('X-RateLimit-Limit', decision.limit);
  res.setHeader('X-RateLimit-Remaining', decision.remaining);
  res.setHeader('X-RateLimit-Reset', Math.ceil(decision.resetAt / 1000));

  if (!decision.allowed) {
    res.setHeader('Retry-After', retryAfterSeconds);
  }
}
