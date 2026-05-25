import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class PurchaseTopupDto {
  @ApiProperty({ example: 'TOPUP_500' })
  @IsString()
  topupPackCode: string;
}
