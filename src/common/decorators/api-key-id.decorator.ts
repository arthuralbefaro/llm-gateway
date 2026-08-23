import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import type { AuthenticatedRequest } from '../guards/api-key.guard';

export const ApiKeyId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!req.apiKeyId) {
      throw new Error('ApiKeyId used on a route without ApiKeyGuard');
    }
    return req.apiKeyId;
  },
);
