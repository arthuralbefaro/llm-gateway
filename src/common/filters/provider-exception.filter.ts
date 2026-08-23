import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';
import { ProviderError } from '../../providers/provider.types';

@Catch(ProviderError)
export class ProviderExceptionFilter implements ExceptionFilter<ProviderError> {
  private readonly logger = new Logger(ProviderExceptionFilter.name);

  catch(error: ProviderError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = toGatewayStatus(error.status);

    this.logger.error(
      `${error.provider} failed with ${error.status ?? 'no status'}: ${error.message}`,
    );

    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(status).json({
      error: {
        message: error.message,
        type: 'provider_error',
        provider: error.provider,
        upstream_status: error.status ?? null,
        retryable: error.retryable,
      },
    });
  }
}

function toGatewayStatus(upstream: number | undefined): number {
  if (upstream === undefined) {
    return HttpStatus.BAD_GATEWAY;
  }
  // our credentials failing upstream is our problem, not the caller's, so it
  // must not come back as a 401 the caller would try to fix with a new key
  if (upstream === 401 || upstream === 403) {
    return HttpStatus.BAD_GATEWAY;
  }
  if (upstream >= 500) {
    return HttpStatus.BAD_GATEWAY;
  }
  return upstream;
}
