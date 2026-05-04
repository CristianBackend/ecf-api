import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';
import { buildCorsOriginOption } from './config/cors.util';

async function bootstrap() {
  // `bufferLogs: true` so any log emitted during module init is held until
  // the pino Logger is adopted via `app.useLogger(...)`.
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));

  const configService = app.get(ConfigService);
  const logger = app.get(Logger);

  // Security
  app.use(helmet());
  // CORS_ORIGIN is a comma-separated list of allowed origins (e.g.
  // "https://app.example.com,http://localhost:3000"). The dynamic callback
  // reflects the caller's exact origin back instead of echoing the whole
  // list — the HTTP spec requires exactly one origin in that header.
  const corsRaw = configService.get<string>('CORS_ORIGIN');
  app.enableCors({
    origin: buildCorsOriginOption(corsRaw),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key', 'X-ECF-Signature', 'X-ECF-Timestamp'],
    exposedHeaders: ['X-RateLimit-Limit', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
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
    .addTag('buyers', 'Clientes y compradores (directorio de contribuyentes)')
    .addTag('certificates', 'Certificados digitales (.p12) para firma XMLDSig')
    .addTag('sequences', 'Secuencias de eNCF autorizadas por DGII')
    .addTag('invoices', 'Emisión y gestión de facturas electrónicas (e-CF)')
    .addTag('webhooks', 'Notificaciones en tiempo real de eventos de facturación')
    .addTag('contingency', 'Gestión de facturas en contingencia y reintentos')
    .addTag('reception', 'Documentos e-CF recibidos de otros emisores (ACECF)')
    .addTag('rnc', 'Validación y consulta de RNC/Cédula en DGII')
    .addTag('downloads', 'Descarga de archivos mediante token de un solo uso')
    .addTag('admin', 'Administración de colas BullMQ y diagnóstico de plataforma')
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
