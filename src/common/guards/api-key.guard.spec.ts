import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { generateApiKey, hashApiKey } from '../api-key';
import { ApiKeyGuard } from './api-key.guard';
import type { AuthenticatedRequest } from './api-key.guard';

interface StoredKey {
  id: string;
  active: boolean;
}

function contextWith(authorization?: string): {
  context: ExecutionContext;
  req: Partial<AuthenticatedRequest>;
} {
  const req: Partial<AuthenticatedRequest> = {
    headers: authorization ? { authorization } : {},
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { context, req };
}

function guardWith(rows: Record<string, StoredKey>): ApiKeyGuard {
  const prisma = {
    apiKey: {
      findUnique: (args: { where: { hash: string } }) =>
        Promise.resolve(rows[args.where.hash] ?? null),
    },
  } as unknown as PrismaService;
  return new ApiKeyGuard(prisma);
}

describe('ApiKeyGuard', () => {
  const key = generateApiKey();
  const hash = hashApiKey(key);

  it('accepts an active key and exposes its id', async () => {
    const guard = guardWith({ [hash]: { id: 'key-1', active: true } });
    const { context, req } = contextWith(`Bearer ${key}`);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(req.apiKeyId).toBe('key-1');
  });

  it('rejects a request without an Authorization header', async () => {
    const guard = guardWith({});
    const { context } = contextWith();

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a non bearer scheme', async () => {
    const guard = guardWith({ [hash]: { id: 'key-1', active: true } });
    const { context } = contextWith(`Basic ${key}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an unknown key', async () => {
    const guard = guardWith({});
    const { context } = contextWith(`Bearer ${generateApiKey()}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an inactive key', async () => {
    const guard = guardWith({ [hash]: { id: 'key-1', active: false } });
    const { context } = contextWith(`Bearer ${key}`);

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('never stores or compares the plaintext key', () => {
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(key);
    expect(hashApiKey(key)).toBe(hash);
  });
});
