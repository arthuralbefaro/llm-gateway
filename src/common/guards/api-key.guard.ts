import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { hashApiKey } from '../api-key';

export interface AuthenticatedRequest extends Request {
  apiKeyId?: string;
}

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const presented = bearerToken(req.headers.authorization);

    if (!presented) {
      throw new UnauthorizedException('missing bearer api key');
    }

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { hash: hashApiKey(presented) },
      select: { id: true, active: true },
    });

    // an unknown key and a disabled one get the same answer, so the response
    // does not tell an attacker which of the two they hit
    if (!apiKey?.active) {
      throw new UnauthorizedException('invalid or inactive api key');
    }

    req.apiKeyId = apiKey.id;
    return true;
  }
}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) {
    return undefined;
  }
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) {
    return undefined;
  }
  return token;
}
