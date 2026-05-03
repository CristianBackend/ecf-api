import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class UploadCertificateDto {
  @ApiProperty({
    description: 'ID de la empresa a la que pertenece el certificado',
    example: 'uuid-de-la-empresa',
  })
  @IsString()
  companyId: string;

  @ApiProperty({
    description: 'Contenido del archivo .p12 en Base64. Usar: `base64 -i certificado.p12` (macOS/Linux) o `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cert.p12"))` (PowerShell)',
    example: 'MIIKDgIBAzCCCcoGCSqGSIb3DQEHAaCCCbsEggm3MIIJszCCBW8GCSqGSIb3...',
  })
  @IsString()
  p12Base64: string;

  @ApiProperty({
    description: 'Contraseña del certificado .p12',
    example: 'mi-password-seguro',
  })
  @IsString()
  @MinLength(1)
  passphrase: string;
}
