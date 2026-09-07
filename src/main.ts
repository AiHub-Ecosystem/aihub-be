import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from './app.module';

const DEFAULT_PORT = 3000;
const MAX_BODY_BYTES = 1024 * 1024;

export async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: MAX_BODY_BYTES }),
  );

  app.setGlobalPrefix('v1');
  await app.listen(Number(process.env.PORT ?? DEFAULT_PORT), '0.0.0.0');
}

void bootstrap();
