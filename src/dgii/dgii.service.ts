import {
  Injectable,
  Logger,
  ServiceUnavailableException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { SigningService } from '../signing/signing.service';
import { DGII_ENDPOINTS, DGII_SERVICES, DGII_STATUS, DGII_STATUS_SERVICE_URL, buildDgiiUrl } from '../xml-builder/ecf-types';

/**
 * DGII Communication Service
 *
 * Handles ALL web services per DGII Descripción Técnica v1.6:
 *
 * 1. Autenticación: semilla → firma → token JWT (1 hour)
 * 2. Recepción e-CF: submit signed XML → TrackId
 * 3. Recepción RFCE: submit FC < 250K summary
 * 4. Consulta Resultado: poll TrackId for status
 * 5. Consulta Estado: check e-CF validity (for receivers)
 * 6. Consulta TrackId: get all TrackIds for an eNCF
 * 7. Anulación e-NCF: void unused sequences (ANECF)
 * 8. Aprobación Comercial: send/receive commercial approval
 * 9. Directorio Facturadores: list authorized electronic invoicers
 * 10. Estatus Servicios: check DGII service availability
 */
@Injectable()
export class DgiiService {
  private readonly logger = new Logger(DgiiService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly signingService: SigningService,
  ) {}

  // ============================================================
  // AUTHENTICATION
  // ============================================================

  async getToken(
    tenantId: string,
    companyId: string,
    privateKey: string,
    certificate: string,
    environment: string,
  ): Promise<string> {
    // Check cached token
    const cached = await this.prisma.dgiiToken.findFirst({
      where: {
        tenantId,
        companyId,
        environment: environment as any,
        expiresAt: { gt: new Date() },
      },
    });

    if (cached) {
      this.logger.debug(`Using cached DGII token for company ${companyId}`);
      return cached.token;
    }

    const baseUrl = this.getBaseUrl(environment);

    // Authenticate with retry + exponential backoff (3 attempts)
    const token = await this.authenticateWithRetry(baseUrl, privateKey, certificate);

    if (!token) {
      throw new ServiceUnavailableException('Could not extract token from DGII response');
    }

    // Cache token (expires in 1 hour, cache for 55 min)
    const expiresAt = new Date(Date.now() + 55 * 60 * 1000);

    // Clean up expired tokens for this company
    await this.prisma.dgiiToken.deleteMany({
      where: { companyId, expiresAt: { lt: new Date() } },
    });

    await this.prisma.dgiiToken.create({
      data: { tenantId, companyId, token, environment: environment as any, expiresAt },
    });

    this.logger.log(`DGII token obtained for company ${companyId} (${environment})`);
    return token;
  }

  // ============================================================
  // SUBMIT e-CF (standard, full XML)
  // ============================================================

  async submitEcf(
    signedXml: string,
    fileName: string,
    token: string,
    environment: string,
  ): Promise<DgiiSubmissionResult> {
    const baseUrl = this.getBaseUrl(environment);
    const url = buildDgiiUrl(baseUrl, DGII_SERVICES.SEND_ECF);

    this.logger.debug(`Submitting e-CF to DGII: ${fileName}`);

    const response = await this.httpPostMultipart(url, signedXml, token, fileName);
    const responseText = await response.text();

    if (!response.ok) {
      this.logger.error(`DGII submission failed: ${response.status} - ${responseText}`);
      return {
        success: false,
        trackId: null,
        status: DGII_STATUS.REJECTED,
        message: responseText,
        rawResponse: responseText,
      };
    }

    // Parse full response: { trackId, error, mensaje }
    const { trackId, error: dgiiError, mensaje } = this.parseSubmissionResponse(responseText);
    this.logger.log(`e-CF submitted. TrackId: ${trackId}${dgiiError ? ` Error: ${dgiiError}` : ''}`);

    return {
      success: true,
      trackId,
      status: DGII_STATUS.IN_PROCESS,
      message: mensaje || 'Documento enviado, en proceso de validación',
      error: dgiiError || undefined,
      rawResponse: responseText,
    };
  }

  // ============================================================
  // SUBMIT RFCE (Resumen Factura Consumo < 250K)
  // ============================================================

  async submitRfce(
    rfceXml: string,
    token: string,
    environment: string,
    fileName = 'rfce.xml',
  ): Promise<DgiiSubmissionResult> {
    const endpoints = DGII_ENDPOINTS[environment as keyof typeof DGII_ENDPOINTS];
    if (!endpoints) throw new BadRequestException(`Invalid DGII environment: ${environment}`);

    // FC uses fc.dgii.gov.do domain with same service/resource pattern
    const url = buildDgiiUrl(endpoints.fc, DGII_SERVICES.FC_RECEIVE);
    this.logger.debug(`Submitting RFCE to DGII FC service: ${fileName}`);

    const response = await this.httpPostMultipart(url, rfceXml, token, fileName);
    const responseText = await response.text();

    // Parse full RFCE response: { codigo, estado, mensajes, encf, secuenciaUtilizada }
    const parsed = this.parseRfceResponse(responseText);

    return {
      success: parsed.status !== DGII_STATUS.REJECTED,
      trackId: null, // RFCE doesn't return TrackId
      status: parsed.status,
      message: parsed.status === DGII_STATUS.ACCEPTED ? 'RFCE aceptado' :
               parsed.status === DGII_STATUS.CONDITIONAL ? 'RFCE aceptado condicional' :
               parsed.mensajes?.join('; ') || responseText,
      encf: parsed.encf,
      secuenciaUtilizada: parsed.secuenciaUtilizada,
      rawResponse: responseText,
    };
  }

  // ============================================================
  // ANULACIÓN DE SECUENCIAS (ANECF)
  // ============================================================

  /**
   * Submit ANECF (Anulación de e-NCF) to void unused sequences
   * or e-CF that were signed but not sent.
   */
  async submitAnecf(
    anecfXml: string,
    token: string,
    environment: string,
    fileName = 'anecf.xml',
  ): Promise<DgiiSubmissionResult> {
    const baseUrl = this.getBaseUrl(environment);
    // URL: {base}/anulacionrangos/api/operaciones/anularrango
    const url = buildDgiiUrl(baseUrl, DGII_SERVICES.VOID);

    this.logger.debug(`Submitting ANECF (void sequences) to DGII: ${fileName}`);

    const response = await this.httpPostMultipart(url, anecfXml, token, fileName);
    const responseText = await response.text();

    return {
      success: response.ok,
      trackId: null,
      status: response.ok ? DGII_STATUS.ACCEPTED : DGII_STATUS.REJECTED,
      message: response.ok ? 'Secuencias anuladas exitosamente' : responseText,
      rawResponse: responseText,
    };
  }

  // ============================================================
  // QUERY STATUS (Consulta Resultado - for emisors)
  // ============================================================

  async queryStatus(
    trackId: string,
    token: string,
    environment: string,
  ): Promise<DgiiStatusResult> {
    const baseUrl = this.getBaseUrl(environment);
    // Consulta Resultado: {base}/consultaresultado/api/consultas/estado?trackid=...
    const url = `${buildDgiiUrl(baseUrl, DGII_SERVICES.QUERY_RESULT)}?trackid=${trackId}`;

    const response = await this.httpGet(url, {
      Authorization: `Bearer ${token}`,
    });

    const responseText = await response.text();

    if (!response.ok) {
      this.logger.warn(`DGII status query failed: ${response.status}`);
      return {
        trackId,
        status: DGII_STATUS.NOT_FOUND,
        message: `Query failed: ${response.status}`,
        rawResponse: responseText,
      };
    }

    return this.parseStatusResponse(trackId, responseText);
  }

  // ============================================================
  // QUERY STATE (Consulta Estado - for receivers)
  // ============================================================

  async queryState(
    rncEmisor: string,
    encf: string,
    token: string,
    environment: string,
  ): Promise<DgiiStatusResult> {
    const baseUrl = this.getBaseUrl(environment);
    // Consulta Estado: {base}/consultaestado/api/consultas/estado?rncemisor=...&ncfelectronico=...
    const url = `${buildDgiiUrl(baseUrl, DGII_SERVICES.QUERY_STATE)}?rncemisor=${rncEmisor}&ncfelectronico=${encf}`;

    const response = await this.httpGet(url, {
      Authorization: `Bearer ${token}`,
    });

    const responseText = await response.text();

    return {
      trackId: '',
      status: response.ok ? this.extractStatusCode(responseText) : DGII_STATUS.NOT_FOUND,
      message: responseText,
      rawResponse: responseText,
    };
  }

  // ============================================================
  // QUERY TRACKIDS (Consulta TrackIds - per Descripción Técnica p.25)
  // ============================================================

  async queryTrackIds(
    rncEmisor: string,
    encf: string,
    token: string,
    environment: string,
  ): Promise<DgiiStatusResult> {
    const baseUrl = this.getBaseUrl(environment);
    const url = `${buildDgiiUrl(baseUrl, DGII_SERVICES.QUERY_TRACKIDS)}?rncemisor=${rncEmisor}&encf=${encf}`;

    const response = await this.httpGet(url, {
      Authorization: `Bearer ${token}`,
    });

    const responseText = await response.text();

    return {
      trackId: '',
      status: response.ok ? DGII_STATUS.ACCEPTED : DGII_STATUS.NOT_FOUND,
      message: responseText,
      rawResponse: responseText,
    };
  }

  // ============================================================
  // QUERY RFCE (Consulta RFCE - per Descripción Técnica p.17)
  // ============================================================

  async queryRfce(
    rncEmisor: string,
    encf: string,
    securityCode: string,
    token: string,
    environment: string,
  ): Promise<DgiiStatusResult> {
    const endpoints = DGII_ENDPOINTS[environment as keyof typeof DGII_ENDPOINTS];
    if (!endpoints) throw new BadRequestException(`Invalid DGII environment: ${environment}`);

    // RFCE query uses fc.dgii.gov.do domain
    const url = `${buildDgiiUrl(endpoints.fc, DGII_SERVICES.FC_QUERY)}?RNC_Emisor=${rncEmisor}&ENCF=${encf}&Cod_Seguridad_eCF=${securityCode}`;

    const response = await this.httpGet(url, {
      Authorization: `Bearer ${token}`,
    });

    const responseText = await response.text();

    return {
      trackId: '',
      status: response.ok ? this.extractStatusCode(responseText) : DGII_STATUS.NOT_FOUND,
      message: responseText,
      rawResponse: responseText,
    };
  }

  // ============================================================
  // COMMERCIAL APPROVAL (Aprobación Comercial)
  // ============================================================

  async sendCommercialApproval(
    approvalXml: string,
    token: string,
    environment: string,
    fileName = 'acecf.xml',
  ): Promise<DgiiSubmissionResult> {
    const baseUrl = this.getBaseUrl(environment);
    const url = buildDgiiUrl(baseUrl, DGII_SERVICES.COMMERCIAL_APPROVAL);

    this.logger.debug(`Submitting commercial approval to DGII: ${fileName}`);

    const response = await this.httpPostMultipart(url, approvalXml, token, fileName);
    const responseText = await response.text();

    return {
      success: response.ok,
      trackId: null,
      status: response.ok ? DGII_STATUS.ACCEPTED : DGII_STATUS.REJECTED,
      message: responseText,
      rawResponse: responseText,
    };
  }

  /**
   * Send ARECF (Acuse de Recibo Electrónico) to the emitter.
   *
   * Per DGII Descripción Técnica p.52-58, the ARECF is sent directly to the
   * emitter's endpoint at {emitterUrl}/fe/recepcion/api/ecf, NOT to DGII's
   * aprobación comercial endpoint (that's only for ACECF).
   *
   * The emitter's base URL is obtained from the DGII directory.
   */
  async sendArecf(
    arecfXml: string,
    token: string,
    environment: string,
    emitterRnc?: string,
    fileName = 'arecf.xml',
  ): Promise<DgiiSubmissionResult> {
    // If emitterRnc is provided, try to resolve emitter URL from DGII directory
    if (emitterRnc) {
      try {
        const directoryResult = await this.queryDirectory(token, environment, emitterRnc);
        const emitterUrl = this.extractEmitterUrl(directoryResult.data);

        if (emitterUrl) {
          const url = `${emitterUrl}/fe/recepcion/api/ecf`;
          this.logger.debug(`Sending ARECF to emitter: ${url} (${fileName})`);

          const response = await this.httpPostMultipart(url, arecfXml, token, fileName);
          const responseText = await response.text();

          return {
            success: response.ok,
            trackId: null,
            status: response.ok ? DGII_STATUS.ACCEPTED : DGII_STATUS.REJECTED,
            message: responseText,
            rawResponse: responseText,
          };
        }

        this.logger.warn(`Emitter URL not found for RNC ${emitterRnc}, cannot send ARECF`);
      } catch (error: any) {
        this.logger.warn(`Failed to resolve emitter URL for ARECF: ${error.message}`);
      }
    }

    // Fallback: log warning that ARECF could not be delivered
    this.logger.warn('ARECF not delivered to emitter — emitter URL not resolved');
    return {
      success: true,
      trackId: null,
      status: DGII_STATUS.ACCEPTED,
      message: 'ARECF generado localmente. Pendiente entrega al emisor.',
      rawResponse: '',
    };
  }

  /**
   * Send ACECF (Aprobación Comercial Electrónica) to DGII and optionally to the emitter.
   *
   * Per DGII Informe Técnico p.14, modelo paso 5-6:
   * - Step 5: Send to emitter via {emitterUrl}/fe/aprobacioncomercial/api/ecf
   * - Step 6: Send to DGII via aprobacioncomercial endpoint
   */
  async sendAcecf(
    acecfXml: string,
    token: string,
    environment: string,
    emitterRnc?: string,
    fileName = 'acecf.xml',
  ): Promise<DgiiSubmissionResult> {
    // Step 5: Try to send ACECF to the original emitter first
    if (emitterRnc) {
      try {
        const directoryResult = await this.queryDirectory(token, environment, emitterRnc);
        const emitterUrl = this.extractEmitterUrl(directoryResult.data);

        if (emitterUrl) {
          const url = `${emitterUrl}/fe/aprobacioncomercial/api/ecf`;
          this.logger.debug(`Sending ACECF to emitter: ${url}`);
          await this.httpPostMultipart(url, acecfXml, token, fileName);
        }
      } catch (error: any) {
        this.logger.warn(`Failed to send ACECF to emitter ${emitterRnc}: ${error.message}`);
      }
    }

    // Step 6: Send to DGII
    return this.sendCommercialApproval(acecfXml, token, environment, fileName);
  }

  // ============================================================
  // DIRECTORY (Consulta Directorio Facturadores)
  // ============================================================

  async queryDirectory(
    token: string,
    environment: string,
    rnc?: string,
  ): Promise<DgiiDirectoryResult> {
    const baseUrl = this.getBaseUrl(environment);
    let url: string;
    if (rnc) {
      // Consulta directorio por RNC
      url = `${buildDgiiUrl(baseUrl, DGII_SERVICES.DIRECTORY_BY_RNC)}?RNC=${rnc}`;
    } else {
      // Consulta listado completo
      url = buildDgiiUrl(baseUrl, DGII_SERVICES.DIRECTORY);
    }

    const response = await this.httpGet(url, {
      Authorization: `Bearer ${token}`,
    });

    const responseText = await response.text();

    return {
      success: response.ok,
      data: responseText,
      rawResponse: responseText,
    };
  }

  // ============================================================
  // STATUS CHECK (Consulta Estatus Servicios)
  // ============================================================

  /**
   * Check DGII service availability before submitting.
   * Per Descripción Técnica p.48: requires Authorization: Apikey header.
   * Recommended to call before batch operations.
   */
  async checkServiceStatus(environment: string): Promise<DgiiServiceStatus> {
    // Estatus servicios uses a dedicated domain and Apikey auth per DGII spec
    const url = DGII_STATUS_SERVICE_URL;
    const apiKey = this.config.get<string>('DGII_STATUS_API_KEY') || '';

    try {
      const headers: Record<string, string> = {};
      if (apiKey) {
        headers['Authorization'] = `Apikey ${apiKey}`;
      }

      const response = await this.httpGet(url, headers);
      const responseText = await response.text();

      return {
        available: response.ok,
        message: responseText,
        environment,
        checkedAt: new Date(),
      };
    } catch (error: any) {
      return {
        available: false,
        message: error.message,
        environment,
        checkedAt: new Date(),
      };
    }
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  /**
   * Authenticate with DGII using retry + exponential backoff.
   * 3 attempts: immediate, 2s, 4s.
   */
  private async authenticateWithRetry(
    baseUrl: string,
    privateKey: string,
    certificate: string,
  ): Promise<string | null> {
    const MAX_AUTH_RETRIES = 3;
    const BASE_DELAY_MS = 2000;

    for (let attempt = 1; attempt <= MAX_AUTH_RETRIES; attempt++) {
      try {
        // Step 1: Request seed
        this.logger.debug(`Requesting seed from DGII (attempt ${attempt})...`);
        const seedUrl = buildDgiiUrl(baseUrl, DGII_SERVICES.SEED);
        const seedResponse = await this.httpGet(seedUrl);

        if (!seedResponse.ok) {
          throw new ServiceUnavailableException(
            `DGII seed request failed: ${seedResponse.status} ${seedResponse.statusText}`,
          );
        }

        const seedXml = await seedResponse.text();

        // Step 2: Sign seed
        const { signedXml: signedSeed } = this.signingService.signXml(seedXml, privateKey, certificate);

        // Step 3: Validate signed seed → JWT
        this.logger.debug('Validating signed seed with DGII...');
        const validateUrl = buildDgiiUrl(baseUrl, DGII_SERVICES.VALIDATE_SEED);
        const tokenResponse = await this.httpPostMultipart(validateUrl, signedSeed, '');

        if (!tokenResponse.ok) {
          const errorBody = await tokenResponse.text();
          throw new ServiceUnavailableException(
            `DGII token validation failed: ${tokenResponse.status} - ${errorBody}`,
          );
        }

        const tokenData = await tokenResponse.text();
        return this.extractToken(tokenData);
      } catch (error: any) {
        if (attempt === MAX_AUTH_RETRIES) {
          throw error;
        }
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        this.logger.warn(`Auth attempt ${attempt} failed: ${error.message}. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    return null;
  }

  private getBaseUrl(environment: string): string {
    const endpoints = DGII_ENDPOINTS[environment as keyof typeof DGII_ENDPOINTS];
    if (!endpoints) throw new BadRequestException(`Invalid DGII environment: ${environment}`);
    return endpoints.base;
  }

  private extractToken(responseText: string): string | null {
    const tokenMatch = responseText.match(/<token>([\s\S]*?)<\/token>/i);
    if (tokenMatch) return tokenMatch[1].trim();

    // Try JSON
    try {
      const json = JSON.parse(responseText);
      return json.token || json.Token || null;
    } catch {}

    const trimmed = responseText.trim();
    if (trimmed.length > 20 && !trimmed.includes('<')) return trimmed;
    return null;
  }

  private parseSubmissionResponse(responseText: string): { trackId: string | null; error: string | null; mensaje: string | null } {
    try {
      const json = JSON.parse(responseText);
      return {
        trackId: json.trackId || json.TrackId || null,
        error: json.error || json.Error || null,
        mensaje: json.mensaje || json.Mensaje || null,
      };
    } catch {}

    // Fallback: XML extraction
    const trackMatch = responseText.match(/<trackId>([\s\S]*?)<\/trackId>/i);
    const errorMatch = responseText.match(/<error>([\s\S]*?)<\/error>/i);
    const msgMatch = responseText.match(/<mensaje>([\s\S]*?)<\/mensaje>/i);

    return {
      trackId: trackMatch ? trackMatch[1].trim() : (responseText.trim() || null),
      error: errorMatch ? errorMatch[1].trim() : null,
      mensaje: msgMatch ? msgMatch[1].trim() : null,
    };
  }

  private extractTrackId(responseText: string): string | null {
    const match = responseText.match(/<trackId>([\s\S]*?)<\/trackId>/i);
    if (match) return match[1].trim();

    try {
      const json = JSON.parse(responseText);
      return json.trackId || json.TrackId || null;
    } catch {}

    return responseText.trim() || null;
  }

  private extractStatusCode(responseText: string): number {
    try {
      const json = JSON.parse(responseText);
      return json.estado ?? json.status ?? DGII_STATUS.NOT_FOUND;
    } catch {}

    const match = responseText.match(/<estado>(\d+)<\/estado>/i);
    return match ? parseInt(match[1], 10) : DGII_STATUS.NOT_FOUND;
  }

  private parseRfceResponse(responseText: string): { status: number; encf?: string; secuenciaUtilizada?: boolean; mensajes?: string[] } {
    // Try JSON parse first: { codigo, estado, mensajes, encf, secuenciaUtilizada }
    try {
      const json = JSON.parse(responseText);
      const codigo = json.codigo ?? json.Codigo;
      const status = typeof codigo === 'number' ? codigo :
        (typeof codigo === 'string' && /^\d+$/.test(codigo)) ? parseInt(codigo, 10) :
        this.extractStatusCode(responseText);
      return {
        status,
        encf: json.encf || json.Encf,
        secuenciaUtilizada: json.secuenciaUtilizada ?? json.SecuenciaUtilizada,
        mensajes: json.mensajes || json.Mensajes,
      };
    } catch {}

    // Fallback: text matching
    const lower = responseText.toLowerCase();
    if (lower.includes('aceptado condicional')) return { status: DGII_STATUS.CONDITIONAL };
    if (lower.includes('aceptado')) return { status: DGII_STATUS.ACCEPTED };
    if (lower.includes('rechazado')) return { status: DGII_STATUS.REJECTED };
    return { status: this.extractStatusCode(responseText) };
  }

  private parseStatusResponse(trackId: string, responseText: string): DgiiStatusResult {
    try {
      const json = JSON.parse(responseText);
      return {
        trackId,
        status: json.estado ?? json.status ?? DGII_STATUS.NOT_FOUND,
        message: json.mensaje || json.message || '',
        encf: json.encf,
        secuenciaUtilizada: json.secuenciaUtilizada,
        rawResponse: responseText,
      };
    } catch {
      const statusMatch = responseText.match(/<estado>(\d+)<\/estado>/i);
      const msgMatch = responseText.match(/<mensaje>([\s\S]*?)<\/mensaje>/i);
      const seqMatch = responseText.match(/<secuenciaUtilizada>(true|false)<\/secuenciaUtilizada>/i);

      return {
        trackId,
        status: statusMatch ? parseInt(statusMatch[1], 10) : DGII_STATUS.NOT_FOUND,
        message: msgMatch ? msgMatch[1].trim() : responseText,
        secuenciaUtilizada: seqMatch ? seqMatch[1] === 'true' : undefined,
        rawResponse: responseText,
      };
    }
  }

  /**
   * Extract emitter base URL from DGII directory response.
   * The directory returns the emitter's registered URL for inter-taxpayer communication.
   */
  private extractEmitterUrl(directoryData: string): string | null {
    try {
      const json = JSON.parse(directoryData);
      // DGII directory returns array of entries or single object
      const entry = Array.isArray(json) ? json[0] : json;
      return entry?.urlRecepcion || entry?.url || entry?.URLRecepcion || null;
    } catch {
      // Try XML extraction
      const match = directoryData.match(/<urlRecepcion>([\s\S]*?)<\/urlRecepcion>/i);
      return match ? match[1].trim() : null;
    }
  }

  /**
   * HTTP POST as multipart/form-data (how DGII expects XML submissions).
   */
  /** HTTP timeout in milliseconds for all DGII requests */
  private static readonly HTTP_TIMEOUT_MS = 30_000;

  private async httpPostMultipart(
    url: string,
    xmlContent: string,
    token: string,
    fileName = 'ecf.xml',
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DgiiService.HTTP_TIMEOUT_MS);
    try {
      // DGII expects multipart/form-data with 'xml' field
      // Per Descripción Técnica p.59: filename must be {RNCEmisor}{eNCF}.xml
      const boundary = `----ECFBoundary${Date.now()}`;
      const body = [
        `--${boundary}`,
        `Content-Disposition: form-data; name="xml"; filename="${fileName}"`,
        'Content-Type: text/xml',
        '',
        xmlContent,
        `--${boundary}--`,
      ].join('\r\n');

      const headers: Record<string, string> = {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Accept: 'application/json',
      };

      // Token may be empty during seed validation (authentication step)
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      return await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (error: any) {
      this.logger.error(`HTTP POST failed: ${url} - ${error.message}`);
      throw new ServiceUnavailableException(
        `No se pudo conectar con DGII: ${error.message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async httpGet(url: string, headers?: Record<string, string>): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DgiiService.HTTP_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/xml, application/json',
          ...headers,
        },
        signal: controller.signal,
      });
    } catch (error: any) {
      this.logger.error(`HTTP GET failed: ${url} - ${error.message}`);
      throw new ServiceUnavailableException(
        `No se pudo conectar con DGII: ${error.message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async httpPost(
    url: string,
    body: string,
    contentType: string,
    headers?: Record<string, string>,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DgiiService.HTTP_TIMEOUT_MS);
    try {
      return await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': contentType,
          Accept: 'application/xml, application/json',
          ...headers,
        },
        body,
        signal: controller.signal,
      });
    } catch (error: any) {
      this.logger.error(`HTTP POST failed: ${url} - ${error.message}`);
      throw new ServiceUnavailableException(
        `No se pudo conectar con DGII: ${error.message}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ============================================================
// RESULT TYPES
// ============================================================

export interface DgiiSubmissionResult {
  success: boolean;
  trackId: string | null;
  status: number;
  message: string;
  error?: string;
  encf?: string;
  secuenciaUtilizada?: boolean;
  rawResponse: string;
}

export interface DgiiStatusResult {
  trackId: string;
  status: number;
  message: string;
  encf?: string;
  secuenciaUtilizada?: boolean;
  rawResponse: string;
}

export interface DgiiDirectoryResult {
  success: boolean;
  data: string;
  rawResponse: string;
}

export interface DgiiServiceStatus {
  available: boolean;
  message: string;
  environment: string;
  checkedAt: Date;
}
