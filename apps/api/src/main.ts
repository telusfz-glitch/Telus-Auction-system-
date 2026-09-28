import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureApp } from './bootstrap';
import { loadEnv } from './config/env';

async function main() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  await configureApp(app, env);
  await app.listen(env.PORT);
}
main().catch((e) => { console.error(e); process.exit(1); });
