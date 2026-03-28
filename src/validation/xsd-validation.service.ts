import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

/**
 * XSD Validation Result
 */
export interface XsdValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  /** Which XSD schema was used */
  schema: string;
  /** Time taken in ms */
  durationMs: number;
}

/**
 * Mapping of e-CF type codes to XSD file names
 */
const ECF_TYPE_TO_XSD: Record<number, string> = {
  31: 'e-CF-31.xsd',
  32: 'e-CF-32.xsd',
  33: 'e-CF-33.xsd',
  34: 'e-CF-34.xsd',
  41: 'e-CF-41.xsd',
  43: 'e-CF-43.xsd',
  44: 'e-CF-44.xsd',
  45: 'e-CF-45.xsd',
  46: 'e-CF-46.xsd',
  47: 'e-CF-47.xsd',
};

/**
 * XSD Validation Service
 *
 * Validates generated e-CF XML documents against official DGII XSD schemas.
 * Uses xmllint (libxml2) for fast, standards-compliant validation.
 *
 * XSD files must be downloaded from DGII portal and placed in the `xsd/` directory:
 *   bash xsd/download-xsd.sh
 *
 * In Docker: XSD files are baked into the image via COPY.
 * Locally: run the download script or skip validation if XSD not found.
 */
@Injectable()
export class XsdValidationService implements OnModuleInit {
  private readonly logger = new Logger(XsdValidationService.name);
  private xsdDir: string;
  private xmllintPath: string | null = null;
  private availableSchemas: Set<number> = new Set();

  async onModuleInit() {
    // Resolve XSD directory (relative to project root)
    this.xsdDir = path.resolve(process.cwd(), 'xsd');

    // Check xmllint availability
    await this.detectXmllint();

    // Patch known DGII XSD bugs and check available schemas
    this.patchXsdBugs();
    this.detectAvailableSchemas();

    if (!this.xmllintPath) {
      this.logger.warn(
        'xmllint not found. XSD validation disabled. Install libxml2-utils (apt) or libxml2 (brew).',
      );
    } else if (this.availableSchemas.size === 0) {
      this.logger.warn(
        `No XSD schemas found in ${this.xsdDir}. Run: bash xsd/download-xsd.sh`,
      );
    } else {
      this.logger.log(
        `XSD validation ready: ${this.availableSchemas.size} schemas, xmllint at ${this.xmllintPath}`,
      );
    }
  }

  /**
   * Check if XSD validation is available
   */
  isAvailable(): boolean {
    return this.xmllintPath !== null && this.availableSchemas.size > 0;
  }

  /**
   * Check if a specific e-CF type has an XSD schema available
   */
  hasSchema(typeCode: number): boolean {
    return this.availableSchemas.has(typeCode);
  }

  /**
   * Validate an XML string against the appropriate DGII XSD schema.
   *
   * @param xml - The XML document string
   * @param typeCode - e-CF type code (31, 32, 33, etc.)
   * @returns Validation result with errors and warnings
   */
  async validateXml(xml: string, typeCode: number): Promise<XsdValidationResult> {
    const start = Date.now();

    // Pre-flight checks — do NOT silently pass when validation tool is unavailable
    if (!this.xmllintPath) {
      this.logger.warn('XSD validation unavailable: xmllint not installed');
      return {
        valid: false,
        errors: ['XSD validation unavailable: xmllint not installed. Install libxml2-utils (apt) or libxml2 (brew).'],
        warnings: [],
        schema: 'none',
        durationMs: Date.now() - start,
      };
    }

    const xsdFile = ECF_TYPE_TO_XSD[typeCode];
    if (!xsdFile) {
      return {
        valid: true,
        errors: [],
        warnings: [`XSD validation skipped: no schema mapping for type code ${typeCode}`],
        schema: 'none',
        durationMs: Date.now() - start,
      };
    }

    const xsdPath = path.join(this.xsdDir, xsdFile);
    if (!this.availableSchemas.has(typeCode)) {
      return {
        valid: true,
        errors: [],
        warnings: [`XSD validation skipped: schema not found at ${xsdPath}`],
        schema: xsdFile,
        durationMs: Date.now() - start,
      };
    }

    // Write XML to temp file (xmllint reads from file)
    // DGII XSD schemas have no targetNamespace, so we must strip xmlns for validation
    const xmlForValidation = this.stripNamespaces(xml);
    const tmpFile = path.join(os.tmpdir(), `ecf-validate-${Date.now()}-${typeCode}.xml`);

    try {
      fs.writeFileSync(tmpFile, xmlForValidation, 'utf-8');

      const { stderr } = await execFileAsync(
        this.xmllintPath,
        ['--schema', xsdPath, '--noout', tmpFile],
        { timeout: 10000 },
      );

      // xmllint outputs validation messages to stderr
      const output = stderr.trim();
      const warnings = this.parseWarnings(output);

      return {
        valid: true,
        errors: [],
        warnings,
        schema: xsdFile,
        durationMs: Date.now() - start,
      };
    } catch (error: any) {
      // xmllint returns exit code 3 or 4 on validation failure
      const stderr = error.stderr?.toString() || error.message || '';
      const errors = this.parseErrors(stderr);
      const warnings = this.parseWarnings(stderr);

      this.logger.warn(
        `XSD validation failed for e-CF type ${typeCode}: ${errors.length} error(s)`,
      );

      return {
        valid: false,
        errors,
        warnings,
        schema: xsdFile,
        durationMs: Date.now() - start,
      };
    } finally {
      // Cleanup temp file
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }
  }

  /**
   * Validate XML and throw if invalid (use in pipelines)
   */
  async assertValid(xml: string, typeCode: number): Promise<XsdValidationResult> {
    const result = await this.validateXml(xml, typeCode);

    if (!result.valid) {
      const errorSummary = result.errors.slice(0, 5).join('; ');
      throw new Error(
        `XSD validation failed for e-CF ${typeCode}: ${errorSummary}`,
      );
    }

    return result;
  }

  /**
   * Batch validate multiple XML documents
   */
  async validateBatch(
    items: Array<{ xml: string; typeCode: number; id?: string }>,
  ): Promise<Array<XsdValidationResult & { id?: string }>> {
    const results = [];
    for (const item of items) {
      const result = await this.validateXml(item.xml, item.typeCode);
      results.push({ ...result, id: item.id });
    }
    return results;
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private async detectXmllint(): Promise<void> {
    const candidates = ['/usr/bin/xmllint', 'xmllint'];
    for (const candidate of candidates) {
      try {
        await execFileAsync(candidate, ['--version'], { timeout: 5000 });
        this.xmllintPath = candidate;
        return;
      } catch {
        // try next
      }
    }
  }

  private detectAvailableSchemas(): void {
    for (const [typeCode, filename] of Object.entries(ECF_TYPE_TO_XSD)) {
      const xsdPath = path.join(this.xsdDir, filename);
      if (fs.existsSync(xsdPath)) {
        this.availableSchemas.add(Number(typeCode));
      }
    }
  }

  /**
   * Patch known bugs in DGII's official XSD files.
   * - Space in type name: ' IndicadorServicioTodoIncluidoType' → 'IndicadorServicioTodoIncluidoType'
   */
  private patchXsdBugs(): void {
    for (const filename of Object.values(ECF_TYPE_TO_XSD)) {
      const xsdPath = path.join(this.xsdDir, filename);
      if (!fs.existsSync(xsdPath)) continue;

      try {
        let content = fs.readFileSync(xsdPath, 'utf-8');
        const patched = content.replace(
          /"\s+IndicadorServicioTodoIncluidoType"/g,
          '"IndicadorServicioTodoIncluidoType"',
        );
        if (patched !== content) {
          fs.writeFileSync(xsdPath, patched, 'utf-8');
          this.logger.log(`Patched DGII XSD bug in ${filename}`);
        }
      } catch {
        // Read-only filesystem, skip patching
      }
    }
  }

  /**
   * Strip xmlns attributes for XSD validation.
   * DGII XSD schemas have no targetNamespace, so XML must not have xmlns
   * during validation. The xmlns is still required for DGII submission.
   */
  private stripNamespaces(xml: string): string {
    return xml.replace(/ xmlns="[^"]*"/g, '');
  }

  private parseErrors(stderr: string): string[] {
    return stderr
      .split('\n')
      .filter(line => line.includes('error') || line.includes('Error'))
      .map(line => this.cleanXmllintLine(line))
      .filter(Boolean);
  }

  private parseWarnings(stderr: string): string[] {
    return stderr
      .split('\n')
      .filter(line => line.includes('warning') || line.includes('Warning'))
      .map(line => this.cleanXmllintLine(line))
      .filter(Boolean);
  }

  private cleanXmllintLine(line: string): string {
    // Remove temp file path prefix for cleaner output
    return line
      .replace(/\/tmp\/ecf-validate-\d+-\d+\.xml:\d+:\s*/, '')
      .replace(/element\s+/g, 'element ')
      .trim();
  }
}
