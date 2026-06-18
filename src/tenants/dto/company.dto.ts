import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  Matches,
  MinLength,
  MaxLength,
} from 'class-validator';
import { DgiiEnvironment } from '@prisma/client';

export class CreateCompanyDto {
  @ApiProperty({
    description: 'RNC de la empresa (9 u 11 dígitos)',
    example: '130000001',
  })
  @IsString()
  @Matches(/^\d{9}$|^\d{11}$/, { message: 'RNC debe tener 9 o 11 dígitos numéricos' })
  rnc: string;

  @ApiProperty({
    description: 'Razón social de la empresa',
    example: 'Empresa Ejemplo SRL',
  })
  @IsString()
  @MinLength(2)
  @MaxLength(250)
  businessName: string;

  @ApiPropertyOptional({ description: 'Nombre comercial' })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  tradeName?: string;

  @ApiPropertyOptional({ description: 'Dirección fiscal' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ description: 'Teléfono', example: '809-555-0100' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: 'Email de la empresa' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Municipio' })
  @IsOptional()
  @IsString()
  municipality?: string;

  @ApiPropertyOptional({ description: 'Provincia' })
  @IsOptional()
  @IsString()
  province?: string;

  @ApiPropertyOptional({ description: 'Código de actividad económica' })
  @IsOptional()
  @IsString()
  activityCode?: string;

  @ApiPropertyOptional({ description: 'Código de sucursal (max 20 caracteres)' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  branchCode?: string;

  @ApiPropertyOptional({ description: 'Descripción de actividad económica (max 100 caracteres)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  economicActivity?: string;

  @ApiProperty({
    description:
      'Ambiente DGII — OBLIGATORIO y consciente. DEV=sandbox (testecf, no cuenta uso), ' +
      'CERT=certificación, PROD=producción (comprobantes fiscales reales). ' +
      'No tiene default: crear una empresa sin elegir ambiente es un error.',
    enum: DgiiEnvironment,
    example: DgiiEnvironment.PROD,
  })
  @IsEnum(DgiiEnvironment, {
    message:
      'dgiiEnv es obligatorio y debe ser DEV, CERT o PROD. ' +
      'Elija el ambiente explícitamente: DEV es sandbox (no emite comprobantes reales).',
  })
  dgiiEnv: DgiiEnvironment;
}

// UpdateCompanyDto hereda todos los campos como OPCIONALES (PartialType), por lo que
// dgiiEnv vuelve a ser opcional en update — el cambio de ambiente ya se audita
// (companies.service.ts → action 'dgii_env_changed'). La decisión consciente se
// fuerza sólo en la CREACIÓN.
export class UpdateCompanyDto extends PartialType(CreateCompanyDto) {}
