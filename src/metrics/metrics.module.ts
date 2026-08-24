import { Module } from '@nestjs/common';
import { RouterModule } from '../router/router.module';
import { HealthController } from './health.controller';
import { RequestLogService } from './request-log.service';

@Module({
  imports: [RouterModule],
  controllers: [HealthController],
  providers: [RequestLogService],
  exports: [RequestLogService],
})
export class MetricsModule {}
