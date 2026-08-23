import { Module } from '@nestjs/common';
import { RequestLogService } from './request-log.service';

@Module({
  providers: [RequestLogService],
  exports: [RequestLogService],
})
export class MetricsModule {}
