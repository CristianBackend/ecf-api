import { Module } from '@nestjs/common';
import { SchedulerService } from './scheduler.service';
import { ContingencyModule } from '../contingency/contingency.module';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [ContingencyModule, QueueModule],
  providers: [SchedulerService],
})
export class SchedulerModule {}
