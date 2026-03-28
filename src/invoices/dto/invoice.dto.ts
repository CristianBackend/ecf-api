import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsArray,
  IsObject,
  IsOptional,
  IsNumber,
  IsInt,
  IsEnum,
  IsIn,
  IsEmail,
  ValidateNested,
  Matches,
  Min,
  Max,
  MinLength,
  MaxLength,
  ArrayMinSize,
  ArrayMaxSize,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';

// ============================================================
// Valid ECF types
// ============================================================
const VALID_ECF_TYPES = ['E31', 'E32', 'E33', 'E34', 'E41', 'E43', 'E44', 'E45', 'E46', 'E47'] as const;
// E33/E34 (NC/ND) have Comprador código 2 (conditional), NOT mandatory RNC
// Per XSD + ecf-types.ts REQUIRES_BUYER_RNC = [31, 41, 45]
// E44 requires Comprador but RNC is conditional (código 2)
const TYPES_REQUIRING_RNC = ['E31', 'E41', 'E45'];
const VALID_ITBIS_RATES = [0, 16, 18];

// ============================================================
// NESTED DTOs
// ============================================================

class BuyerDto {
  @ApiPropertyOptional({ description: 'RNC (9 dígitos) o Cédula (11 dígitos) del comprador' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{9}$|^\d{11}$/, { message: 'RNC debe tener 9 dígitos o Cédula 11 dígitos (solo números)' })
  rnc?: string;

  @ApiProperty({ description: 'Nombre/Razón social del comprador' })
  @IsString({ message: 'Nombre del comprador es requerido' })
  @MinLength(2, { message: 'Nombre del comprador debe tener al menos 2 caracteres' })
  @MaxLength(250, { message: 'Nombre del comprador no puede exceder 250 caracteres' })
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail({}, { message: 'Email del comprador inválido' })
  @MaxLength(320, { message: 'Email demasiado largo' })
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20, { message: 'Teléfono del comprador no puede exceder 20 caracteres' })
  phone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Dirección del comprador no puede exceder 500 caracteres' })
  address?: string;

  @ApiPropertyOptional({ description: 'Código DGII de municipio (6 dígitos, ej: "010101")' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Municipio debe ser un código DGII de 6 dígitos (ej: "010101" para Santo Domingo de Guzmán)' })
  municipality?: string;

  @ApiPropertyOptional({ description: 'Código DGII de provincia (6 dígitos, ej: "010000")' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Provincia debe ser un código DGII de 6 dígitos (ej: "010000" para Distrito Nacional)' })
  province?: string;

  @ApiPropertyOptional({ description: '1=Jurídica, 2=Física, 3=Extranjero' })
  @IsOptional()
  @IsInt()
  @IsIn([1, 2, 3], { message: 'Tipo de comprador debe ser 1 (Jurídica), 2 (Física) o 3 (Extranjero)' })
  type?: number;
}

class InvoiceItemDto {
  @ApiProperty({ description: 'Descripción del item' })
  @IsString({ message: 'Descripción del item es requerida' })
  @MinLength(1, { message: 'Descripción del item no puede estar vacía' })
  @MaxLength(500, { message: 'Descripción del item no puede exceder 500 caracteres' })
  description: string;

  @ApiProperty({ description: 'Cantidad', example: 1 })
  @IsNumber({}, { message: 'Cantidad debe ser un número' })
  @Min(0.0001, { message: 'Cantidad debe ser mayor a 0' })
  @Max(99999999, { message: 'Cantidad excede el máximo permitido' })
  quantity: number;

  @ApiProperty({ description: 'Precio unitario sin ITBIS', example: 1000 })
  @IsNumber({}, { message: 'Precio unitario debe ser un número' })
  @Min(0.01, { message: 'Precio unitario debe ser mayor a 0' })
  @Max(999999999.99, { message: 'Precio unitario excede el máximo permitido' })
  unitPrice: number;

  @ApiPropertyOptional({ description: 'Descuento en monto', example: 0 })
  @IsOptional()
  @IsNumber({}, { message: 'Descuento debe ser un número' })
  @Min(0, { message: 'Descuento no puede ser negativo' })
  discount?: number;

  @ApiPropertyOptional({ description: 'Recargo en monto (RecargoMonto XSD)', example: 0 })
  @IsOptional()
  @IsNumber({}, { message: 'Recargo debe ser un número' })
  @Min(0, { message: 'Recargo no puede ser negativo' })
  surcharge?: number;

  @ApiPropertyOptional({ description: 'Fecha de elaboración del item (DD-MM-YYYY)' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}-\d{2}-\d{4}$/, { message: 'Formato de fecha de elaboración: DD-MM-YYYY' })
  manufacturingDate?: string;

  @ApiPropertyOptional({ description: 'Tasa ITBIS: 18, 16, o 0', example: 18 })
  @IsOptional()
  @IsNumber({}, { message: 'Tasa ITBIS debe ser un número' })
  @IsIn(VALID_ITBIS_RATES, { message: 'Tasa ITBIS debe ser 0, 16, o 18' })
  itbisRate?: number;

  @ApiPropertyOptional({ description: '1=Bien, 2=Servicio', example: 1 })
  @IsOptional()
  @IsInt()
  @IsIn([1, 2], { message: 'goodService debe ser 1 (Bien) o 2 (Servicio)' })
  goodService?: number;

  @ApiPropertyOptional({ description: 'Código del item' })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Código del item demasiado largo' })
  code?: string;

  @ApiPropertyOptional({ description: 'Unidad de medida' })
  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Unidad de medida demasiado larga' })
  unit?: string;

  @ApiPropertyOptional({ description: 'Código impuesto adicional (001-039 ISC/otros)' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{3}$/, { message: 'Código de impuesto adicional debe ser 3 dígitos (001-999)' })
  additionalTaxCode?: string;

  @ApiPropertyOptional({ description: 'Tasa impuesto adicional' })
  @IsOptional()
  @IsNumber({}, { message: 'Tasa de impuesto adicional debe ser un número' })
  @Min(0, { message: 'Tasa de impuesto adicional no puede ser negativa' })
  @Max(100, { message: 'Tasa de impuesto adicional no puede exceder 100%' })
  additionalTaxRate?: number;
}

class PaymentDto {
  @ApiProperty({ description: 'Tipo de pago DGII: 1=Contado, 2=Crédito, 3=Gratuito', example: 1 })
  @IsInt({ message: 'Tipo de pago debe ser un entero' })
  @Min(1, { message: 'Tipo de pago mínimo es 1' })
  @Max(3, { message: 'Tipo de pago máximo es 3 (1=Contado, 2=Crédito, 3=Gratuito)' })
  type: number;

  @ApiPropertyOptional({ description: 'Forma de pago: 1=Efectivo, 2=Cheque/Transferencia, 3=Tarjeta, 4=Crédito, 5=Bonos, 6=Permuta, 7=NC, 8=Otras', example: 1 })
  @IsOptional()
  @IsInt({ message: 'Forma de pago debe ser un entero' })
  @Min(1, { message: 'Forma de pago mínimo es 1' })
  @Max(8, { message: 'Forma de pago máximo es 8' })
  method?: number;

  @ApiPropertyOptional({ description: 'Fecha de pago (DD-MM-YYYY)' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{2}-\d{2}-\d{4}$/, { message: 'Formato de fecha de pago: DD-MM-YYYY' })
  date?: string;

  @ApiPropertyOptional({ description: 'Días de crédito (solo si type=2)' })
  @IsOptional()
  @IsInt({ message: 'Días de crédito debe ser un entero' })
  @Min(1, { message: 'Días de crédito mínimo es 1' })
  @Max(365, { message: 'Días de crédito máximo es 365' })
  termDays?: number;

  @ApiPropertyOptional({ description: 'Tipo de cuenta: CT=Corriente, AH=Ahorro, OT=Otra' })
  @IsOptional()
  @IsString()
  @IsIn(['CT', 'AH', 'OT'], { message: 'Tipo de cuenta debe ser CT (Corriente), AH (Ahorro), o OT (Otra)' })
  accountType?: string;

  @ApiPropertyOptional({ description: 'Número de cuenta de pago (max 28 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(28, { message: 'Número de cuenta no puede exceder 28 caracteres' })
  accountNumber?: string;

  @ApiPropertyOptional({ description: 'Banco de pago (max 75 chars)' })
  @IsOptional()
  @IsString()
  @MaxLength(75, { message: 'Nombre del banco no puede exceder 75 caracteres' })
  bank?: string;
}

class ReferenceDto {
  @ApiProperty({
    description: 'NCFModificado: Serie E (E + 12 dígitos), Serie B (B + 10), o Serie A/P (19 chars)',
    example: 'E310000000001',
  })
  @IsString()
  @Matches(/^(E\d{12}|B\d{10}|[AP]\d{18})$/, {
    message: 'NCFModificado inválido. Formatos: Serie E (E+12 dígitos), Serie B (B+10 dígitos), Serie A/P (A/P+18 dígitos)',
  })
  encf: string;

  @ApiProperty({ description: 'Fecha del documento original (DD-MM-YYYY)' })
  @IsString()
  @Matches(/^\d{2}-\d{2}-\d{4}$/, { message: 'Formato de fecha: DD-MM-YYYY' })
  date: string;

  @ApiPropertyOptional({ description: 'Razón de la modificación' })
  @IsOptional()
  @IsString()
  @MaxLength(500, { message: 'Razón no puede exceder 500 caracteres' })
  reason?: string;

  @ApiProperty({
    description: 'Código: 1=Anula, 2=Corrige texto, 3=Corrige montos, 4=Reemplazo contingencia, 5=Referencia FC',
  })
  @IsInt({ message: 'Código de modificación debe ser un entero' })
  @IsIn([1, 2, 3, 4, 5], {
    message: 'Código de modificación: 1=Anula, 2=Corrige texto, 3=Corrige montos, 4=Reemplazo contingencia, 5=Referencia FC',
  })
  modificationCode: number;
}

// Per XSD TipoMonedaType: 17 monedas autorizadas por DGII
const DGII_CURRENCIES = [
  'BRL', 'CAD', 'CHF', 'CHY', 'XDR', 'DKK', 'EUR', 'GBP', 'JPY',
  'NOK', 'SCP', 'SEK', 'USD', 'VEF', 'HTG', 'MXN', 'COP',
] as const;

class CurrencyDto {
  @ApiProperty({ description: 'Código moneda DGII (TipoMonedaType)', example: 'USD', enum: DGII_CURRENCIES })
  @IsString()
  @IsIn([...DGII_CURRENCIES], {
    message: 'Moneda no autorizada por DGII. Valores válidos: BRL, CAD, CHF, CHY, XDR, DKK, EUR, GBP, JPY, NOK, SCP, SEK, USD, VEF, HTG, MXN, COP',
  })
  code: string;

  @ApiProperty({ description: 'Tasa de cambio a DOP', example: 57.5 })
  @IsNumber({}, { message: 'Tasa de cambio debe ser un número' })
  @Min(0.0001, { message: 'Tasa de cambio debe ser mayor a 0' })
  @Max(99999, { message: 'Tasa de cambio excede el máximo' })
  exchangeRate: number;
}

// ============================================================
// MAIN DTO
// ============================================================

export class CreateInvoiceDto {
  @ApiProperty({ description: 'ID de la empresa emisora (UUID)' })
  @IsString({ message: 'companyId es requerido' })
  @MinLength(36, { message: 'companyId inválido' })
  @MaxLength(36, { message: 'companyId inválido' })
  companyId: string;

  @ApiProperty({
    description: 'Tipo de e-CF',
    example: 'E31',
    enum: VALID_ECF_TYPES,
  })
  @IsString()
  @IsIn(VALID_ECF_TYPES, { message: 'Tipo e-CF inválido. Valores válidos: E31, E32, E33, E34, E41, E43, E44, E45, E46, E47' })
  ecfType: string;

  @ApiProperty({ description: 'Datos del comprador', type: BuyerDto })
  @ValidateNested()
  @Type(() => BuyerDto)
  buyer: BuyerDto;

  @ApiProperty({ description: 'Items de la factura (1-1000)', type: [InvoiceItemDto] })
  @IsArray({ message: 'Items debe ser un array' })
  @ArrayMinSize(1, { message: 'Debe incluir al menos 1 item' })
  @ArrayMaxSize(10000, { message: 'Máximo 10,000 items por factura' })
  @ValidateNested({ each: true })
  @Type(() => InvoiceItemDto)
  items: InvoiceItemDto[];

  @ApiProperty({ description: 'Información de pago', type: PaymentDto })
  @ValidateNested()
  @Type(() => PaymentDto)
  payment: PaymentDto;

  @ApiPropertyOptional({ description: 'Referencia (obligatorio para NC E34 y ND E33)', type: ReferenceDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ReferenceDto)
  reference?: ReferenceDto;

  @ApiPropertyOptional({ description: 'Moneda extranjera', type: CurrencyDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CurrencyDto)
  currency?: CurrencyDto;

  @ApiPropertyOptional({ description: 'Clave de idempotencia para evitar duplicados' })
  @IsOptional()
  @IsString()
  @MaxLength(64, { message: 'Clave de idempotencia no puede exceder 64 caracteres' })
  idempotencyKey?: string;

  @ApiPropertyOptional({ description: 'Metadata custom (no se envía a DGII)' })
  @IsOptional()
  @IsObject({ message: 'Metadata debe ser un objeto JSON' })
  metadata?: Record<string, any>;
}

// Export constants for use in service validations
export { TYPES_REQUIRING_RNC, VALID_ECF_TYPES };
