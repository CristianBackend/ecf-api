import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Res,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiParam,
  ApiBody,
} from '@nestjs/swagger';
import { Response } from 'express';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto, VoidInvoiceDto } from './dto/invoice.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';
import { DownloadTokenService } from '../common/services/download-token.service';
import { ApiStandardErrors, ApiReadErrors, ApiNotFoundError } from '../common/swagger/api-errors';

const INVOICE_ID_PARAM = ApiParam({
  name: 'id',
  description: 'UUID de la factura',
  example: 'clng9x0010000vwc0l5s1234',
  format: 'uuid',
});

@ApiTags('invoices')
@Controller('invoices')
@UseGuards(ApiKeyGuard)
@ApiBearerAuth('api-key')
export class InvoicesController {
  constructor(
    private readonly invoicesService: InvoicesService,
    private readonly downloadTokens: DownloadTokenService,
  ) {}

  @Post()
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Crear factura electrónica (e-CF) — asíncrono',
    description:
      'Valida los datos, asigna eNCF, construye y guarda el XML sin firmar, ' +
      'y encola el trabajo de firma + envío a DGII en BullMQ. Responde 202 con ' +
      'status=QUEUED inmediatamente. Firma, submit y polling a DGII ocurren en ' +
      'background. El estado final se comunica vía webhook (`invoice.accepted`, `invoice.rejected`, etc.).',
  })
  @ApiResponse({
    status: 202,
    description: 'Factura encolada para firma y envío a DGII',
    schema: {
      example: {
        success: true,
        data: {
          id: 'clng9x0010000vwc0l5s1234',
          tenantId: 'tenant-uuid',
          companyId: 'company-uuid',
          ecfType: 'E31',
          encf: 'E310000000001',
          status: 'QUEUED',
          createdAt: '2026-05-03T12:00:00.000Z',
        },
      },
    },
  })
  @ApiStandardErrors()
  async create(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.invoicesService.create(tenant.id, dto);
  }

  @Get()
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary: 'Listar facturas con filtros',
    description: 'Retorna lista paginada de facturas del tenant. Soporta filtros por empresa, tipo, estado y rango de fechas.',
  })
  @ApiQuery({ name: 'companyId', required: false, description: 'Filtrar por empresa (UUID)' })
  @ApiQuery({ name: 'ecfType', required: false, enum: ['E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47'], description: 'Filtrar por tipo de e-CF' })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'QUEUED', 'PROCESSING', 'ACCEPTED', 'REJECTED', 'CONDITIONAL', 'VOIDED', 'CONTINGENCY', 'ERROR'], description: 'Filtrar por estado' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Fecha inicio (YYYY-MM-DD)', example: '2026-01-01' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Fecha fin (YYYY-MM-DD)', example: '2026-12-31' })
  @ApiQuery({ name: 'page', required: false, type: Number, description: 'Página (default: 1)', example: 1 })
  @ApiQuery({ name: 'limit', required: false, type: Number, description: 'Items por página (default: 20, max: 100)', example: 20 })
  @ApiResponse({
    status: 200,
    description: 'Lista paginada de facturas',
    schema: {
      example: {
        success: true,
        data: [{ id: 'clng9x001...', ecfType: 'E31', encf: 'E310000000001', status: 'ACCEPTED', totalAmount: 11800 }],
        meta: { total: 150, page: 1, limit: 20, totalPages: 8 },
      },
    },
  })
  @ApiReadErrors()
  async findAll(
    @CurrentTenant() tenant: RequestTenant,
    @Query('companyId') companyId?: string,
    @Query('ecfType') ecfType?: string,
    @Query('status') status?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.invoicesService.findAll(tenant.id, {
      companyId,
      ecfType,
      status,
      dateFrom,
      dateTo,
      page,
      limit,
    });
  }

  @Get(':id')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary: 'Ver detalle de factura',
    description: 'Retorna el detalle completo de una factura incluyendo items, estado DGII, XML generado y eventos de webhook.',
  })
  @INVOICE_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Detalle completo de la factura',
    schema: {
      example: {
        success: true,
        data: {
          id: 'clng9x0010000vwc0l5s1234',
          ecfType: 'E31',
          encf: 'E310000000001',
          status: 'ACCEPTED',
          totalAmount: 11800,
          itbisAmount: 1800,
          trackId: 'DGII-TRACK-12345',
          dgiiResponse: { code: 1, message: 'Aceptado' },
          createdAt: '2026-05-03T12:00:00.000Z',
          acceptedAt: '2026-05-03T12:00:05.000Z',
        },
      },
    },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Factura')
  async findOne(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
  ) {
    return this.invoicesService.findOne(tenant.id, id);
  }

  @Get(':id/xml')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary: 'Descargar XML de la factura (server-to-server)',
    description:
      'Para descargas server-to-server. Requiere Authorization: Bearer {token} ' +
      'o X-API-Key: {token}. Para descargas iniciadas desde el browser, usar ' +
      'POST /invoices/:id/download-token + GET /downloads/invoice-xml/:token.',
  })
  @INVOICE_ID_PARAM
  @ApiResponse({ status: 200, description: 'Archivo XML (Content-Type: application/xml)', schema: { type: 'string', format: 'binary' } })
  @ApiReadErrors()
  @ApiNotFoundError('Factura')
  async getXml(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Res() res: Response,
  ) {
    const xml = await this.invoicesService.getXml(tenant.id, id);
    res.set({
      'Content-Type': 'application/xml',
      'Content-Disposition': `attachment; filename="${id}.xml"`,
    });
    res.send(xml);
  }

  @Post(':id/download-token')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Emitir token single-use de 60s para descarga desde browser',
    description:
      'Emite un UUID opaco respaldado en Redis con TTL 60s. La primera ' +
      'request a GET /downloads/invoice-xml/{token} lo consume atómicamente ' +
      '(GET+DEL Lua) y entrega el XML. Un replay responde 404.',
  })
  @INVOICE_ID_PARAM
  @ApiResponse({
    status: 201,
    description: 'Token de descarga emitido (válido 60s, un solo uso)',
    schema: {
      example: {
        success: true,
        data: {
          token: '550e8400-e29b-41d4-a716-446655440000',
          expiresInSeconds: 60,
          url: '/downloads/invoice-xml/550e8400-e29b-41d4-a716-446655440000',
        },
      },
    },
  })
  @ApiReadErrors()
  @ApiNotFoundError('Factura')
  async createDownloadToken(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
  ) {
    await this.invoicesService.findOne(tenant.id, id);

    const { token, expiresInMs } = await this.downloadTokens.issue({
      type: 'invoice-xml',
      tenantId: tenant.id,
      invoiceId: id,
    });

    return {
      token,
      expiresInSeconds: Math.floor(expiresInMs / 1000),
      url: `/downloads/invoice-xml/${token}`,
    };
  }

  @Post(':id/poll')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({
    summary: 'Consultar estado DGII de una factura',
    description: 'Consulta el TrackId en DGII y actualiza el estado local de la factura. Útil si el webhook no llegó.',
  })
  @INVOICE_ID_PARAM
  @ApiResponse({
    status: 200,
    description: 'Estado actualizado desde DGII',
    schema: {
      example: {
        success: true,
        data: { id: 'clng9x001...', status: 'ACCEPTED', dgiiResponse: { code: 1, message: 'Aceptado' } },
      },
    },
  })
  @ApiStandardErrors()
  @ApiNotFoundError('Factura')
  async pollStatus(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
  ) {
    return this.invoicesService.pollStatus(tenant.id, id);
  }

  @Post(':id/void')
  @RequireScopes(ApiKeyScope.INVOICES_WRITE)
  @ApiOperation({
    summary: 'Anular una factura',
    description:
      'Anula una factura cambiando su estado a VOIDED. Solo facturas en DRAFT, ERROR o CONTINGENCY pueden anularse directamente. ' +
      'Facturas ACCEPTED requieren emitir una Nota de Crédito (E34) que las referencie.',
  })
  @INVOICE_ID_PARAM
  @ApiBody({ type: VoidInvoiceDto })
  @ApiResponse({
    status: 200,
    description: 'Factura anulada exitosamente',
    schema: {
      example: {
        success: true,
        data: { id: 'clng9x001...', status: 'VOIDED', voidedAt: '2026-05-03T13:00:00.000Z' },
      },
    },
  })
  @ApiResponse({ status: 409, description: 'La factura no puede anularse en su estado actual (ACCEPTED → emitir NC E34)', schema: { example: { success: false, error: { code: 409, type: 'Conflict', message: 'Cannot void an ACCEPTED invoice directly. Issue a Credit Note (E34) instead.' } } } })
  @ApiStandardErrors()
  @ApiNotFoundError('Factura')
  async voidInvoice(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Body() body: VoidInvoiceDto,
  ) {
    return this.invoicesService.voidInvoice(tenant.id, id, body.reason);
  }
}
