import { writeFileSync } from 'node:fs';
import process from 'node:process';

import { AppModule } from '@/app.module';
import { OpenApiController } from '@/openapi/openapi.controller';

function loadedModules(): string[] {
  return Object.keys(require.cache).map((name) => name.replace(/\\/g, '/'));
}

function snapshot(): { openApi: string[]; total: number } {
  const modules = loadedModules();
  return {
    openApi: modules.filter((name) => name.includes('/openapi/build-openapi-document.')),
    total: modules.length,
  };
}

async function main(): Promise<void> {
  void AppModule;
  const before = snapshot();
  const controller = new OpenApiController();
  await controller.getSpec();
  const after = snapshot();
  writeFileSync(
    process.argv[2] as string,
    JSON.stringify({
      docs: 200,
      before,
      after,
    }),
  );
}

void main();
