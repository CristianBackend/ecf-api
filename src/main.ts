import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
  // `bufferLogs: true` so any log emitted during module init is held until
  // the pino Logger is adopted via `app.useLogger(...)`.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);
  const logger = app.get(Logger);

  // Security
  app.use(helmet());
  const corsOrigin = configService.get<string>('CORS_ORIGIN', '*');
  app.enableCors({
    origin: corsOrigin,
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Global prefix
  const prefix = configService.get<string>('API_PREFIX', 'api/v1');
  app.setGlobalPrefix(prefix);

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global filters & interceptors
  app.useGlobalFilters(app.get(HttpExceptionFilter));
  app.useGlobalInterceptors(new TransformInterceptor());

  // Swagger
  const swaggerConfig = new DocumentBuilder()
    .setTitle('ECF API')
    .setDescription(
      'API SaaS de Facturación Electrónica (e-CF) para República Dominicana. ' +
        'Integra emisión, firma digital y comunicación con la DGII.',
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'API Key' },
      'api-key',
    )
    .addTag('auth', 'Autenticación y API Keys')
    .addTag('tenants', 'Gestión de tenants')
    .addTag('companies', 'Empresas emisoras')
    .addTag('certificates', 'Certificados digitales (.p12)')
    .addTag('sequences', 'Secuencias de eNCF')
    .addTag('invoices', 'Facturación electrónica')
    .addTag('health', 'Estado del servicio')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document, {
    customSiteTitle: 'ECF API - Documentación',
    swaggerOptions: {
      persistAuthorization: true,
      docExpansion: 'none',
    },
  });

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);

  logger.log(
    {
      port,
      nodeEnv: configService.get('NODE_ENV', 'development'),
      dgiiEnv: configService.get('DGII_ENVIRONMENT', 'DEV'),
      swaggerUrl: `http://localhost:${port}/docs`,
    },
    `ECF API listening on http://localhost:${port}`,
  );
}

bootstrap();
