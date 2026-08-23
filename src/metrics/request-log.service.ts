import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TokenUsage } from '../providers/provider.types';

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
}

@Injectable()
export class RequestLogService {
  private readonly logger = new Logger(RequestLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Records a served request. Returns immediately: the write happens in the
   * background so the client never waits on it, and a metrics failure is logged
   * rather than surfaced, because the user already got their answer.
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
          latencyMs: entry.latencyMs,
          cacheHit: entry.cacheHit,
          status: entry.status,
        },
      })
      .catch((error: unknown) => {
        this.logger.error(
          `failed to record request: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      });
  }
}
