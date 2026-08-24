import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenUsage } from '../providers/provider.types';
import { AttemptRecord } from '../router/router.service';

export type RequestStatus = 'success' | 'error';

export interface RequestRecord {
  apiKeyId: string;
  provider: string;
  model: string;
  usage: TokenUsage;
  costUsd: number;
  latencyMs: number;
  cacheHit: boolean;
  status: RequestStatus;
  attempts?: AttemptRecord[];
  // costUsd stays the number to sum, this says how much to trust it
  costEstimated?: boolean;
  // which store answered, because a semantic hit and an exact hit differ by an
  // order of magnitude in latency and reporting them together hides that
  cacheKind?: string;
}

// a failed attempt says which provider is misbehaving, and an error long enough
// to include a whole upstream body would bloat every row for no extra signal
const MAX_ERROR_LENGTH = 500;

@Injectable()
export class RequestLogService {
  private readonly logger = new Logger(RequestLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * records a served request and every attempt it took to serve it
   * returns immediately: the write happens in the background so the client never waits
   * on it, and a metrics failure is logged rather than surfaced, because the
   * user already got their answer
   */
  record(entry: RequestRecord): void {
    void this.prisma.request
      .create({
        data: {
          apiKeyId: entry.apiKeyId,
          provider: entry.provider,
          model: entry.model,
          promptTokens: entry.usage.promptTokens,
          completionTokens: entry.usage.completionTokens,
          // a string keeps the full scale of the decimal column, a float would
          // round before postgres ever sees it
          costUsd: entry.costUsd.toFixed(8),
          costEstimated: entry.costEstimated ?? false,
          latencyMs: entry.latencyMs,
          cacheHit: entry.cacheHit,
          cacheKind: entry.cacheKind ?? null,
          status: entry.status,
          attempts: {
            create: (entry.attempts ?? []).map((attempt) => ({
              attempt: attempt.attempt,
              provider: attempt.provider,
              model: attempt.model,
              status: attempt.status,
              latencyMs: attempt.latencyMs,
              error: attempt.error?.slice(0, MAX_ERROR_LENGTH),
            })),
          },
        },
      })
      .catch((error: unknown) => {
        this.logger.error(
          `failed to record request: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
  }
}
