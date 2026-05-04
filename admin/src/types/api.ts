// ============================================================
// Shared API response wrapper
// ============================================================

export interface ApiSuccess<T> {
  success: true;
  data: T;
  meta?: PaginationMeta;
}

export interface ApiError {
  success: false;
  error: {
    code: number;
    type: string;
    message: string;
    timestamp: string;
    path: string;
  };
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============================================================
// Auth
// ============================================================

export interface LoginResponse {
  /** Backend returns 'token', not 'accessToken' — match auth.service.ts exactly. */
  token: string;
  tenant: { id: string; name: string };
}

// ============================================================
// Tenant
// ============================================================

export type Plan = 'STARTER' | 'BUSINESS' | 'ENTERPRISE' | 'PLATFORM';

export interface Tenant {
  id: string;
  name: string;
  email: string;
  plan: Plan;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: { companies: number; apiKeys: number; invoices: number };
  metrics?: { invoiceTotal: number; invoiceThisMonth: number };
}

export interface TenantDetail extends Tenant {
  companies: Company[];
  apiKeys: ApiKey[];
  webhooks: WebhookSubscription[];
  metrics: { invoiceTotal: number; invoiceThisMonth: number };
}

// ============================================================
// Company
// ============================================================

export type DgiiEnvironment = 'DEV' | 'CERT' | 'PROD';

export interface Company {
  id: string;
  tenantId: string;
  rnc: string;
  businessName: string;
  tradeName?: string;
  address?: string;
  phone?: string;
  email?: string;
  dgiiEnv: DgiiEnvironment;
  isActive: boolean;
  createdAt: string;
}

// ============================================================
// Certificate
// ============================================================

export interface Certificate {
  id: string;
  companyId: string;
  isActive: boolean;
  validFrom: string;
  validTo: string;
  fingerprint: string;
  signerName?: string;
  createdAt: string;
}

// ============================================================
// Invoice
// ============================================================

export type InvoiceStatus =
  | 'DRAFT' | 'QUEUED' | 'PROCESSING' | 'SENT'
  | 'ACCEPTED' | 'REJECTED' | 'CONDITIONAL'
  | 'VOIDED' | 'CONTINGENCY' | 'ERROR';

export type EcfType = 'E31' | 'E32' | 'E33' | 'E34' | 'E41' | 'E43' | 'E44' | 'E45' | 'E46' | 'E47';

export interface Invoice {
  id: string;
  tenantId: string;
  companyId: string;
  ecfType: EcfType;
  encf?: string;
  status: InvoiceStatus;
  trackId?: string;
  buyerRnc?: string;
  buyerName?: string;
  subtotal: number;
  totalDiscount: number;
  totalItbis: number;
  totalAmount: number;
  currency: string;
  exchangeRate?: number;
  createdAt: string;
  updatedAt: string;
  company?: { businessName: string; rnc: string };
}

// ============================================================
// API Key
// ============================================================

export interface ApiKey {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  isLive: boolean;
  isActive: boolean;
  lastUsedAt?: string;
  createdAt: string;
}

// ============================================================
// Webhook
// ============================================================

export interface WebhookSubscription {
  id: string;
  tenantId: string;
  url: string;
  events: string[];
  isActive: boolean;
  createdAt: string;
  _count?: { deliveries: number };
}

export interface WebhookDelivery {
  id: string;
  tenantId: string;
  subscriptionId: string;
  url?: string;
  event: string;
  payload: string;
  statusCode?: number;
  responseBody?: string;
  attempts: number;
  maxAttempts: number;
  nextRetryAt?: string;
  deliveredAt?: string;
  createdAt: string;
}

// ============================================================
// Audit
// ============================================================

export interface AuditLog {
  id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  action: string;
  actor?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  createdAt: string;
  tenant?: { name: string };
}

// ============================================================
// Metrics & Health
// ============================================================

export interface GlobalMetrics {
  tenants: { total: number; active: number; newThisMonth: number };
  companies: { total: number; active: number };
  invoices: {
    total: number; today: number; thisMonth: number;
    byStatus: Record<string, number>;
    byEcfType: Record<string, number>;
  };
  certificates: { total: number; active: number; expiringSoon: number; expired: number };
  webhooks: { totalSubscriptions: number; activeSubscriptions: number; deliveriesToday: number; failedToday: number };
  queues: Record<string, { waiting: number; active: number; completed: number; failed: number; delayed: number }>;
  system: { version: string; uptime: number; nodeEnv: string; dgiiEnvironment: string };
}

type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface AdminHealth {
  status: HealthStatus;
  timestamp: string;
  checks: {
    database: { status: 'ok' | 'error'; responseTimeMs: number; error?: string };
    redis:    { status: 'ok' | 'error'; responseTimeMs: number; error?: string };
    queues:   Record<string, { waiting: number; active: number; failed: number }>;
    scheduler: { lastContingencyRun: string | null; lastTokenCleanup: string | null; lastCertificateCheck: string | null };
    system:   { memoryUsage: { rss: number; heapTotal: number; heapUsed: number; external: number }; uptime: number; version: string; nodeEnv: string };
  };
}
