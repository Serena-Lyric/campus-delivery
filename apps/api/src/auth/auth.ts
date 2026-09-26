import type { AdminLevel, PrismaClient, UserRole } from '@prisma/client';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import { forbidden, unauthorized } from '../shared/errors.js';

export type Actor = {
  id: string;
  role: UserRole;
  merchantId?: string;
  riderId?: string;
  adminLevel?: AdminLevel;
};

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor | null;
  }
}

export function authGuard(prisma: PrismaClient, config: AppConfig, roles?: UserRole[]) {
  return async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!config.enableDevAuth) throw unauthorized('No production authentication adapter is configured');

    const header = request.headers['x-user-id'];
    const userId = Array.isArray(header) ? header[0] : header;
    if (!userId) throw unauthorized('x-user-id is required in development mode');

    const user = await prisma.user.findUnique({
      where: { id: userId },
      include: {
        merchant: { select: { id: true } },
        rider: { select: { id: true } },
        adminProfile: { select: { level: true } },
      },
    });
    if (!user?.active) throw unauthorized('User is missing or inactive');
    if (roles && !roles.includes(user.role)) throw forbidden();

    request.actor = {
      id: user.id,
      role: user.role,
      ...(user.merchant ? { merchantId: user.merchant.id } : {}),
      ...(user.rider ? { riderId: user.rider.id } : {}),
      ...(user.adminProfile ? { adminLevel: user.adminProfile.level } : {}),
    };
  };
}

export function adminGuard(
  prisma: PrismaClient,
  config: AppConfig,
  levels: AdminLevel[] = ['OPERATOR', 'SUPER_ADMIN'],
) {
  const authenticate = authGuard(prisma, config, ['ADMIN']);
  return async function authorizeAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    await authenticate(request, reply);
    if (!request.actor?.adminLevel || !levels.includes(request.actor.adminLevel)) throw forbidden();
  };
}

export function requireAdminLevel(actor: Actor, levels: AdminLevel[]): void {
  if (actor.role !== 'ADMIN' || !actor.adminLevel || !levels.includes(actor.adminLevel)) throw forbidden();
}

export function actorOf(request: FastifyRequest): Actor {
  if (!request.actor) throw unauthorized();
  return request.actor;
}
