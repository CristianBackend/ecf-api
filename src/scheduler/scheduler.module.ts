import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { ContingencyModule } from '../contingency/contingency.module';

@Module({
  imports: [ContingencyModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
