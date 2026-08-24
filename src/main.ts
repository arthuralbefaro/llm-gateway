import './tracing/tracing';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ProviderExceptionFilter } from './common/filters/provider-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalFilters(new ProviderExceptionFilter());
  // lets PrismaService close its pool on sigterm
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
