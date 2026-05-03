import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiResponse, ApiParam } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CreateApiKeyDto, LoginDto } from './dto/auth.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';
import { ApiStandardErrors, ApiReadErrors, ApiNotFoundError } from '../common/swagger/api-errors';

const KEY_ID_PARAM = ApiParam({
  name: 'id',
  description: 'UUID de la API key',
  example: 'clng9x0010000vwc0apikey1',
  format: 'uuid',
});

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Login con email y contraseña',
    description: 'Autenticación del dashboard. Retorna un JWT de corta duración para uso en el panel de administración. Para integraciones de sistema a sistema, usar API Keys.',
  })
  @ApiResponse({
    status: 200,
    description: 'Login exitoso. JWT válido para acceso al dashboard.',
    schema: {
      example: {
        success: true,
        data: {
          accessToken: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
          tokenType: 'Bearer',
          expiresIn: 3600,
          tenant: { id: 'tenant-uuid...', name: 'Mi Empresa Integradora' },
        },
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Credenciales incorrectas', schema: { example: { success: false, error: { code: 401, type: 'Unauthorized', message: 'Invalid email or password' } } } })
  @ApiResponse({ status: 400, description: 'Datos de entrada inválidos', schema: { example: { success: false, error: { code: 400, type: 'Bad Request', message: 'email must be an email' } } } })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password);
  }

  @Post('keys')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth('api-key')
  @ApiOperation({
    summary: 'Crear nueva API key',
    description:
      'Crea una API key con scopes específicos. El valor completo solo se muestra en esta respuesta — ' +
      'guárdalo de forma segura. Las keys subsiguientes solo mostrarán los últimos 4 caracteres.',
  })
  @ApiResponse({
    status: 201,
    description: 'API key creada. El valor completo solo se muestra una vez.',
    schema: {
      example: {
        success: true,
        data: {
          id: 'key-uuid...',
          name: 'Producción - Sistema ERP',
          key: 'ecf_live_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456',
          isLive: true,
          scopes: ['INVOICES_WRITE', 'INVOICES_READ', 'COMPANIES_READ'],
          createdAt: '2026-05-03T12:00:00.000Z',
        },
      },
    },
  })
  @ApiStandardErrors()
  async createApiKey(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: CreateApiKeyDto,
  ) {
    return this.authService.generateApiKey(
      tenant.id,
      dto.name,
      dto.isLive,
      dto.scopes || [ApiKeyScope.FULL_ACCESS],
    );
  }

  @Get('keys')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth('api-key')
  @ApiOperation({
    summary: 'Listar API keys del tenant',
    description: 'Retorna todas las API keys del tenant. El valor completo de la key no se muestra, solo los últimos 4 caracteres.',
  })
  @ApiResponse({
    status: 200,
    description: 'Lista de API keys',
    schema: {
      example: {
        success: true,
        data: [
          { id: 'key-uuid-1...', name: 'Producción - ERP', keyHint: '...6789', isLive: true, isActive: true, scopes: ['FULL_ACCESS'] },
          { id: 'key-uuid-2...', name: 'Desarrollo', keyHint: '...abcd', isLive: false, isActive: true, scopes: ['INVOICES_READ'] },
        ],
      },
    },
  })
  @ApiReadErrors()
  async listApiKeys(@CurrentTenant() tenant: RequestTenant) {
    return this.authService.listApiKeys(tenant.id);
  }

  @Delete('keys/:id')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth('api-key')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Revocar una API key',
    description: 'Revoca una API key permanentemente. Los requests en vuelo con esa key serán rechazados inmediatamente.',
  })
  @KEY_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'API key revocada exitosamente',
    schema: { example: { success: true, data: { id: 'key-uuid...', isActive: false, revokedAt: '2026-05-03T12:00:00.000Z' } } },
  })
  @ApiReadErrors()
  @ApiNotFoundError('API key')
  async revokeApiKey(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') apiKeyId: string,
  ) {
    return this.authService.revokeApiKey(tenant.id, apiKeyId);
  }

  @Post('keys/:id/rotate')
  @UseGuards(ApiKeyGuard)
  @ApiBearerAuth('api-key')
  @ApiOperation({
    summary: 'Rotar una API key',
    description: 'Revoca la API key actual y genera una nueva con los mismos scopes. La nueva key solo se muestra una vez.',
  })
  @KEY_ID_PARAM
  @ApiResponse({
    status: 201,
    description: 'API key rotada. El nuevo valor solo se muestra una vez.',
    schema: {
      example: {
        success: true,
        data: {
          id: 'new-key-uuid...',
          name: 'Producción - ERP (rotada)',
          key: 'ecf_live_NuEvAkEyAbCdEfGhIjKlMnOpQrStUv',
          isLive: true,
          scopes: ['FULL_ACCESS'],
        },
      },
    },
  })
  @ApiStandardErrors()
  @ApiNotFoundError('API key')
  async rotateApiKey(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') apiKeyId: string,
  ) {
    return this.authService.rotateApiKey(tenant.id, apiKeyId);
  }
}
