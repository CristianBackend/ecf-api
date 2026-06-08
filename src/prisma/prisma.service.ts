import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    super({
      log:
        process.env.NODE_ENV === 'development'
          ? ['query', 'info', 'warn', 'error']
          : ['error'],
    });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Validate that a value is a real UUID before it is used as the RLS tenant key.
   * `SET` / `set_config` cannot bind the *name*, and a malformed tenantId is a
   * sign of a bug or an injection attempt — fail fast rather than trust it.
   */
  private assertTenantId(tenantId: string): void {
    const UUID_RE =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!UUID_RE.test(tenantId)) {
      throw new Error('Invalid tenantId for RLS context (must be a UUID)');
    }
  }

  /**
   * Set the current tenant context for RLS policies.
   * Call this before any query that should be tenant-scoped.
   *
   * FIX 2 (P5): the value is passed as a BOUND parameter via set_config(), not
   * string-interpolated, so a hostile tenantId cannot break out of the RLS
   * boundary. `is_local = false` → session-scoped, matching the previous `SET`.
   */
  async setTenantContext(tenantId: string): Promise<void> {
    this.assertTenantId(tenantId);
    await this.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, false)`;
  }

  /**
   * Execute a callback within a tenant context.
   * Uses a transaction to ensure the tenant setting persists.
   *
   * FIX 2 (P5): parameterized set_config with `is_local = true` (transaction
   * scoped, matching the previous `SET LOCAL`).
   */
  async withTenant<T>(tenantId: string, callback: (prisma: PrismaClient) => Promise<T>): Promise<T> {
    this.assertTenantId(tenantId);
    return this.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return callback(tx as PrismaClient);
    });
  }

  /**
   * Clean database for testing
   */
  async cleanDatabase() {
    if (process.env.NODE_ENV !== 'development' && process.env.NODE_ENV !== 'test') {
      throw new Error('cleanDatabase only allowed in dev/test');
    }

    const models = Reflect.ownKeys(this).filter(
      (key) => typeof key === 'string' && !key.startsWith('_') && !key.startsWith('$'),
    );

    return Promise.all(
      models.map((modelKey) => {
        const model = (this as any)[modelKey];
        if (model && typeof model.deleteMany === 'function') {
          return model.deleteMany();
        }
      }),
    );
  }
}
