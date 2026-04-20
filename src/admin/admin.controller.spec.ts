/**
 * AdminController tests — GET /admin/queues/stats
 *
 * The controller is a thin passthrough to `QueueService.getQueueStats`;
 * the guard / scope wiring is covered at the module metadata level and
 * through the ApiKeyGuard unit tests. Here we assert the contract that
 * the endpoint returns whatever the service produces, and that
 * instantiation requires a QueueService.
 */
import { AdminController } from './admin.controller';
import { QueueService } from '../queue/queue.service';

describe('AdminController', () => {
  it('GET /admin/queues/stats returns the QueueService snapshot as-is', async () => {
    const snapshot = {
      ecfProcessing: { waiting: 1, active: 2, completed: 3, failed: 0, delayed: 0 },
      statusPoll: { waiting: 0, active: 0, completed: 10, failed: 1, delayed: 5 },
      certificateCheck: { waiting: 0, active: 0, completed: 7, failed: 0, delayed: 0 },
    };
    const queueService = {
      getQueueStats: jest.fn(async () => snapshot),
    } as unknown as QueueService;

    const controller = new AdminController(queueService);
    const result = await controller.queueStats();

    expect(result).toEqual(snapshot);
    expect((queueService.getQueueStats as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});
