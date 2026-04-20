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
import { ApiTags, ApiBearerAuth, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { Response } from 'express';
import { InvoicesService } from './invoices.service';
import { CreateInvoiceDto } from './dto/invoice.dto';
import { ApiKeyGuard } from '../common/guards/api-key.guard';
import { RequireScopes } from '../common/decorators/scopes.decorator';
import { CurrentTenant, RequestTenant } from '../common/decorators/tenant.decorator';
import { ApiKeyScope } from '@prisma/client';
import { DownloadTokenService } from '../common/services/download-token.service';

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
      'background. El estado final se comunica vía webhook.',
  })
  async create(
    @CurrentTenant() tenant: RequestTenant,
    @Body() dto: CreateInvoiceDto,
  ) {
    return this.invoicesService.create(tenant.id, dto);
  }

  @Get()
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({ summary: 'Listar facturas con filtros' })
  @ApiQuery({ name: 'companyId', required: false })
  @ApiQuery({ name: 'ecfType', required: false, enum: ['E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47'] })
  @ApiQuery({ name: 'status', required: false, enum: ['DRAFT', 'PROCESSING', 'ACCEPTED', 'REJECTED', 'CONDITIONAL', 'VOIDED', 'CONTINGENCY'] })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'YYYY-MM-DD' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
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
  @ApiOperation({ summary: 'Ver detalle de factura' })
  async findOne(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
  ) {
    return this.invoicesService.findOne(tenant.id, id);
  }

  @Get(':id/xml')
  @RequireScopes(ApiKeyScope.INVOICES_READ)
  @ApiOperation({
    summary: 'Descargar XML de la factura (API key o Bearer JWT)',
    description:
      'Para descargas server-to-server. Requiere Authorization: Bearer {token} ' +
      'o X-API-Key: {token}. Para descargas iniciadas desde el browser, usar ' +
      'POST /invoices/:id/download-token + GET /downloads/invoice-xml/:token.',
  })
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
      '(GET+DEL Lua) y entrega el XML. Un replay responde 404. Reemplaza al ' +
      'viejo flujo que aceptaba la credencial en un query parameter y ' +
      'terminaba logueándola en los access logs del reverse proxy.',
  })
  async createDownloadToken(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
  ) {
    // Force a tenant-scoped lookup so we refuse to mint a download token
    // for an invoice that doesn't belong to the caller.
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
    description: 'Consulta el TrackId en DGII y actualiza el estado de la factura.',
  })
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
    description: 'Anula una factura cambiando su estado a VOIDED. Solo facturas en estado DRAFT, ERROR o CONTINGENCY pueden ser anuladas directamente. Facturas ACCEPTED requieren emitir una Nota de Crédito (E34).',
  })
  async voidInvoice(
    @CurrentTenant() tenant: RequestTenant,
    @Param('id') id: string,
    @Body() body: { reason?: string },
  ) {
    return this.invoicesService.voidInvoice(tenant.id, id, body.reason);
  }
}
