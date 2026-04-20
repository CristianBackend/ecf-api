-- ADMIN scope for API keys that need to introspect platform-level state
-- (queue depths, scheduled jobs, etc). Must be granted explicitly; not
-- inherited by FULL_ACCESS because FULL_ACCESS was originally tenant-level
-- "full" and we don't want to silently escalate old keys to admin.
ALTER TYPE "ApiKeyScope" ADD VALUE 'ADMIN' BEFORE 'FULL_ACCESS';
