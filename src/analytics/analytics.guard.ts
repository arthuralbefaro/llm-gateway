import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { timingSafeEqual } from 'node:crypto';

/**
 * guards the analytics endpoints with a token separate from the request keys.
 *
 * a gateway api key authorises spending money on completions, these endpoints
 * answer questions about every caller's traffic at once, so accepting the same
 * key would let anyone holding one read aggregate cost, latency and failure
 * data across all tenants, that is a different privilege, not a stricter
 * amount of the same one
 *
 * a scope column on ApiKey would express this better than a shared secret and
 * is the right shape once there is more than one kind of reader
 */
@Injectable()
export class AnalyticsGuard implements CanActivate {
  private readonly token: string | undefined;

  constructor(config: ConfigService) {
    this.token = config.get<string>('ANALYTICS_TOKEN');
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.token) {
      throw new UnauthorizedException('analytics token is not configured');
    }

    const req = context.switchToHttp().getRequest<Request>();
    const presented = bearerToken(req.headers.authorization);

    if (!presented || !matches(presented, this.token)) {
      throw new UnauthorizedException('invalid analytics token');
    }

    return true;
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

// the token is compared to a configured secret rather than looked up, so unlike
// the api key path there is no database round trip to hide the timing
function matches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
