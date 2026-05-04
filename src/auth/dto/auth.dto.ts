import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsBoolean,
  IsOptional,
  IsArray,
  IsEnum,
  IsEmail,
  MinLength,
  MaxLength,
} from 'class-validator';
import { ApiKeyScope } from '@prisma/client';

export class LoginDto {
  @ApiProperty({ description: 'Email de la cuenta', example: 'admin@miempresa.com' })
  @IsEmail()
  email: string;

  @ApiProperty({ description: 'Contraseña', example: 'MiClave123!' })
  @IsString()
  @MinLength(1)
  password: string;
}

export class CreateApiKeyDto {
  @ApiProperty({ description: 'Nombre descriptivo para la API key', example: 'Odoo Integration' })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  name: string;

  @ApiProperty({ description: 'true = producción, false = sandbox', example: false })
  @IsBoolean()
  isLive: boolean;

  @ApiPropertyOptional({
    description: 'Permisos de la API key',
    enum: ApiKeyScope,
    isArray: true,
    example: [ApiKeyScope.FULL_ACCESS],
  })
  @IsOptional()
  @IsArray()
  @IsEnum(ApiKeyScope, { each: true })
  scopes?: ApiKeyScope[];
}

export class ChangePasswordDto {
  @ApiProperty({ description: 'Contraseña actual', example: 'OldPass123' })
  @IsString()
  @MinLength(1)
  currentPassword: string;

  @ApiProperty({
    description: 'Nueva contraseña (min 8 chars, al menos 1 mayúscula, 1 minúscula, 1 número)',
    example: 'NewPass456!',
  })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}

export class RevokeApiKeyDto {
  @ApiProperty({ description: 'ID de la API key a revocar' })
  @IsString()
  apiKeyId: string;
}
