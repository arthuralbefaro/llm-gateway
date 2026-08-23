import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;

  beforeEach(async () => {
    const config: Pick<ConfigService, 'getOrThrow'> = {
      getOrThrow: () => 'postgresql://gateway:gateway@localhost:5433/gateway',
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService, { provide: ConfigService, useValue: config }],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
