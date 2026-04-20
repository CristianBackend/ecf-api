import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { QueueModule } from '../queue/queue.module';

@Module({
  imports: [QueueModule],
  controllers: [AdminController],
})
export class AdminModule {}
