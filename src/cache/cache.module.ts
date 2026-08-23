import { Module } from '@nestjs/common';
import { CacheService } from './cache.service';
import { EmbeddingService } from './embedding.service';

@Module({
  providers: [EmbeddingService, CacheService],
  exports: [CacheService],
})
export class CacheModule {}
