/**
 * AuthService — Tarea 17.3 (getMe) + 17.5 (changePassword)
 */
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ApiKeyScope } from '@prisma/client';
import { AuthService } from './auth.service';

const S = ApiKeyScope;

jest.mock('bcrypt', () => ({ compare: jest.fn(), hash: jest.fn() }));
const bcrypt = require('bcrypt') as { compare: jest.Mock; hash: jest.Mock };

function makeService(tenantRow: any, updateMock?: jest.Mock) {
  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue(tenantRow),
      update: updateMock ?? jest.fn().mockResolvedValue({}),
    },
  } as any;
  const config = { get: jest.fn((k: string) => (k === 'JWT_SECRET' ? 'test-secret' : undefined)) } as any;
  const logger = { info: jest.fn(), warn: jest.fn() } as any;
  return new AuthService(prisma, config, logger);
}

describe('AuthService.getMe()', () => {
  it('17.3-1: no ADMIN key → isSuperAdmin false', async () => {
    const svc = makeService({
      id: 'tid', name: 'T', email: 'e@x.com', plan: 'STARTER', isActive: true,
      apiKeys: [{ scopes: [S.FULL_ACCESS] }],
    });
    const result = await svc.getMe('tid');
    expect(result.isSuperAdmin).toBe(false);
    expect(result.scopes).toContain(S.FULL_ACCESS);
    expect(result.scopes).not.toContain(S.ADMIN);
  });

  it('17.3-2: ADMIN key → isSuperAdmin true', async () => {
    const svc = makeService({
      id: 'tid', name: 'T', email: 'e@x.com', plan: 'STARTER', isActive: true,
      apiKeys: [{ scopes: [S.ADMIN, S.FULL_ACCESS] }],
    });
    const result = await svc.getMe('tid');
    expect(result.isSuperAdmin).toBe(true);
    expect(result.scopes).toContain(S.ADMIN);
  });

  it('17.3-3: multiple keys → scope union returned', async () => {
    const svc = makeService({
      id: 'tid', name: 'T', email: 'e@x.com', plan: 'STARTER', isActive: true,
      apiKeys: [
        { scopes: [S.INVOICES_READ, S.INVOICES_WRITE] },
        { scopes: [S.COMPANIES_READ] },
      ],
    });
    const result = await svc.getMe('tid');
    expect(result.scopes).toContain(S.INVOICES_READ);
    expect(result.scopes).toContain(S.INVOICES_WRITE);
    expect(result.scopes).toContain(S.COMPANIES_READ);
  });

  it('17.3-4: no active keys → scopes empty, isSuperAdmin false', async () => {
    const svc = makeService({
      id: 'tid', name: 'T', email: 'e@x.com', plan: 'STARTER', isActive: true,
      apiKeys: [],
    });
    const result = await svc.getMe('tid');
    expect(result.scopes).toHaveLength(0);
    expect(result.isSuperAdmin).toBe(false);
  });

  it('17.3-5: tenant not found → UnauthorizedException', async () => {
    const svc = makeService(null);
    await expect(svc.getMe('tid')).rejects.toThrow(UnauthorizedException);
  });

  it('17.3-6: mustChangePassword reflects DB value (17.4)', async () => {
    const svc = makeService({
      id: 'tid', name: 'T', email: 'e@x.com', plan: 'STARTER', isActive: true,
      mustChangePassword: true,
      apiKeys: [],
    });
    const result = await svc.getMe('tid');
    expect(result.mustChangePassword).toBe(true);
  });
});

// ── 17.5 — changePassword ────────────────────────────────────────────────────

describe('AuthService.changePassword()', () => {
  beforeEach(() => jest.clearAllMocks());

  const tenantRow = { id: 'tid', passwordHash: 'hashed' };

  it('17.5-1: valid change → updates hash and clears mustChangePassword', async () => {
    bcrypt.compare
      .mockResolvedValueOnce(true)  // currentPassword matches
      .mockResolvedValueOnce(false); // newPassword != old
    bcrypt.hash.mockResolvedValue('new_hashed');
    const updateMock = jest.fn().mockResolvedValue({});
    const svc = makeService(tenantRow, updateMock);

    await expect(svc.changePassword('tid', 'OldPass1', 'NewPass2A')).resolves.toBeUndefined();
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tid' } }),
    );
    const updateData = updateMock.mock.calls[0][0].data;
    expect(updateData.passwordHash).toBe('new_hashed');
    expect(updateData.mustChangePassword).toBe(false);
  });

  it('17.5-2: wrong currentPassword → BadRequestException', async () => {
    bcrypt.compare.mockResolvedValueOnce(false); // currentPassword wrong
    const svc = makeService(tenantRow);
    await expect(svc.changePassword('tid', 'WrongPass1', 'NewPass2A')).rejects.toThrow(BadRequestException);
  });

  it('17.5-3: newPassword same as current → BadRequestException', async () => {
    bcrypt.compare
      .mockResolvedValueOnce(true)  // currentPassword matches
      .mockResolvedValueOnce(true); // newPassword same as old
    const svc = makeService(tenantRow);
    await expect(svc.changePassword('tid', 'OldPass1', 'OldPass1')).rejects.toThrow(BadRequestException);
  });

  it('17.5-4: newPassword too short → BadRequestException', async () => {
    bcrypt.compare
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const svc = makeService(tenantRow);
    await expect(svc.changePassword('tid', 'OldPass1', 'Ab1')).rejects.toThrow(BadRequestException);
  });

  it('17.5-5: newPassword no uppercase → BadRequestException', async () => {
    bcrypt.compare
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const svc = makeService(tenantRow);
    await expect(svc.changePassword('tid', 'OldPass1', 'newpass1nouppercase')).rejects.toThrow(BadRequestException);
  });

  it('17.5-6: newPassword no digit → BadRequestException', async () => {
    bcrypt.compare
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const svc = makeService(tenantRow);
    await expect(svc.changePassword('tid', 'OldPass1', 'NoDigitHere')).rejects.toThrow(BadRequestException);
  });
});
