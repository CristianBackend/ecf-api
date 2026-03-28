import { Module, Global } from '@nestjs/common';
import { ValidationService } from './validation.service';
import { XsdValidationService } from './xsd-validation.service';

@Global()
@Module({
  providers: [ValidationService, XsdValidationService],
  exports: [ValidationService, XsdValidationService],
})
export class ValidationModule {}
