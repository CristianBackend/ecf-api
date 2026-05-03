import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString, IsOptional, IsEmail, IsBoolean,
  Matches, MinLength, MaxLength,
} from 'class-validator';

/**
 * DTO simplificado: solo RNC.
 * Todo se auto-llena desde DGII. Siempre E31 (Crédito Fiscal).
 * Consumidores finales (E32) no se registran aquí.
 */
export class CreateBuyerDto {
  @ApiProperty({ description: 'RNC (9 dígitos) o Cédula (11 dígitos)', example: '131793916' })
  @IsString()
  @Matches(/^\d{9}$|^\d{11}$/, { message: 'RNC debe tener 9 dígitos o Cédula 11 dígitos' })
  rnc: string;

  @ApiPropertyOptional({ description: 'Email de contacto del comprador', example: 'contacto@empresa.com' })
  @IsOptional()
  @IsEmail({}, { message: 'Email inválido' })
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ description: 'Teléfono de contacto', example: '809-555-0101' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: 'Nombre de la persona de contacto', example: 'Juan Pérez' })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  contactPerson?: string;

  @ApiPropertyOptional({ description: 'Notas internas sobre el cliente', example: 'Cliente preferencial - pago a 30 días' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}

export class UpdateBuyerDto {
  @ApiPropertyOptional({ description: 'Nombre o razón social del comprador', example: 'Empresa Actualizada SRL' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(250)
  name?: string;

  @ApiPropertyOptional({ description: 'Nombre comercial', example: 'Empresa Actualizada' })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  commercialName?: string;

  @ApiPropertyOptional({ description: 'Email de contacto', example: 'nuevo@empresa.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  email?: string;

  @ApiPropertyOptional({ description: 'Teléfono de contacto', example: '809-555-0202' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: 'Persona de contacto', example: 'María García' })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  contactPerson?: string;

  @ApiPropertyOptional({ description: 'Notas internas', example: 'Actualizado por soporte' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({ description: 'Estado activo/inactivo del cliente', example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
