import { IsString, IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AssignPlanDto {
  @ApiProperty({ example: 'TIER_2' })
  @IsString()
  planCode: string;

  @ApiPropertyOptional({ default: true })
  @IsBoolean()
  @IsOptional()
  autoRenew?: boolean;
}
