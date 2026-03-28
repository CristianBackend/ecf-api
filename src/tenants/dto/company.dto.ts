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

  @ApiPropertyOptional({
    description: 'Ambiente DGII',
    enum: DgiiEnvironment,
    example: DgiiEnvironment.DEV,
  })
  @IsOptional()
  @IsEnum(DgiiEnvironment)
  dgiiEnv?: DgiiEnvironment;
}

export class UpdateCompanyDto extends PartialType(CreateCompanyDto) {}
