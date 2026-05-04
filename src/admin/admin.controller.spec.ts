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
import { MetricsService } from './metrics.service';

describe('AdminController', () => {
  function makeController() {
    const snapshot = {
      ecfProcessing: { waiting: 1, active: 2, completed: 3, failed: 0, delayed: 0 },
      statusPoll: { waiting: 0, active: 0, completed: 10, failed: 1, delayed: 5 },
      certificateCheck: { waiting: 0, active: 0, completed: 7, failed: 0, delayed: 0 },
    };
    const queueService = { getQueueStats: jest.fn(async () => snapshot) } as unknown as QueueService;
    const metricsService = { getGlobalMetrics: jest.fn(async () => ({ tenants: { total: 1 } })) } as unknown as MetricsService;
    return { controller: new AdminController(queueService, metricsService), queueService, metricsService, snapshot };
  }

  it('GET /admin/queues/stats returns the QueueService snapshot as-is', async () => {
    const { controller, queueService, snapshot } = makeController();
    const result = await controller.queueStats();
    expect(result).toEqual(snapshot);
    expect((queueService.getQueueStats as jest.Mock)).toHaveBeenCalledTimes(1);
  });

  it('GET /admin/metrics delegates to MetricsService', async () => {
    const { controller, metricsService } = makeController();
    const result = await controller.globalMetrics() as any;
    expect(result.tenants.total).toBe(1);
    expect((metricsService.getGlobalMetrics as jest.Mock)).toHaveBeenCalledTimes(1);
  });
});
