import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsBoolean, IsOptional, MaxLength } from 'class-validator';

export class ApproveReceptionDto {
  @ApiProperty({ description: 'Aprobar (true) o rechazar (false) el documento recibido' })
  @IsBoolean()
  approved: boolean;

  @ApiPropertyOptional({ description: 'Motivo de rechazo (obligatorio al rechazar)' })
  @IsOptional()
  @IsString()
  // DetalleMotivoRechazo es AlfaNum250Validation (max 250) en el XSD oficial ACECF v1.0
  @MaxLength(250)
  rejectionReason?: string;
}
