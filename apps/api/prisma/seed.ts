import {
  CampusLocationType,
  MerchantExposureState,
  PrismaClient,
  RiderStatus,
  UserRole,
} from '@prisma/client';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const seedIds = {
  customer: '00000000-0000-4000-8000-000000000001',
  merchantUser: '00000000-0000-4000-8000-000000000002',
  riderAUser: '00000000-0000-4000-8000-000000000003',
  riderBUser: '00000000-0000-4000-8000-000000000004',
  admin: '00000000-0000-4000-8000-000000000005',
  merchant: '10000000-0000-4000-8000-000000000001',
  riderA: '20000000-0000-4000-8000-000000000001',
  riderB: '20000000-0000-4000-8000-000000000002',
  merchantLocation: '30000000-0000-4000-8000-000000000001',
  dormLocation: '30000000-0000-4000-8000-000000000002',
  category: '40000000-0000-4000-8000-000000000001',
  productRice: '50000000-0000-4000-8000-000000000001',
  productTea: '50000000-0000-4000-8000-000000000002',
  subsidyAccount: '60000000-0000-4000-8000-000000000001',
  policyConfig: '70000000-0000-4000-8000-000000000001',
} as const;

export async function seedDatabase(client: PrismaClient) {
  await client.campusLocation.upsert({
    where: { id: seedIds.merchantLocation },
    update: { name: '第一食堂', type: CampusLocationType.CANTEEN },
    create: { id: seedIds.merchantLocation, name: '第一食堂', type: CampusLocationType.CANTEEN },
  });
  await client.campusLocation.upsert({
    where: { id: seedIds.dormLocation },
    update: { name: '学生宿舍 3 号楼', type: CampusLocationType.DORMITORY },
    create: { id: seedIds.dormLocation, name: '学生宿舍 3 号楼', type: CampusLocationType.DORMITORY },
  });

  const users = [
    [seedIds.customer, '演示用户', UserRole.CUSTOMER],
    [seedIds.merchantUser, '演示商家管理员', UserRole.MERCHANT],
    [seedIds.riderAUser, '演示骑手 A', UserRole.RIDER],
    [seedIds.riderBUser, '演示骑手 B', UserRole.RIDER],
    [seedIds.admin, '演示平台管理员', UserRole.ADMIN],
  ] as const;
  for (const [id, displayName, role] of users) {
    await client.user.upsert({
      where: { id },
      update: { displayName, role, active: true },
      create: { id, displayName, role, active: true },
    });
  }

  await client.merchant.upsert({
    where: { id: seedIds.merchant },
    update: {
      name: '校园饭堂演示店',
      ownerId: seedIds.merchantUser,
      campusLocationId: seedIds.merchantLocation,
      isOpen: true,
      exposureState: MerchantExposureState.NORMAL,
      maxConcurrentOrders: 20,
      deliveryContributionMinor: 100,
    },
    create: {
      id: seedIds.merchant,
      name: '校园饭堂演示店',
      description: '仅用于本地第一阶段演示',
      ownerId: seedIds.merchantUser,
      campusLocationId: seedIds.merchantLocation,
      isOpen: true,
      exposureState: MerchantExposureState.NORMAL,
      maxConcurrentOrders: 20,
      deliveryContributionMinor: 100,
    },
  });
  for (const [id, userId] of [[seedIds.riderA, seedIds.riderAUser], [seedIds.riderB, seedIds.riderBUser]] as const) {
    await client.rider.upsert({
      where: { id },
      update: { userId, status: RiderStatus.AVAILABLE },
      create: { id, userId, status: RiderStatus.AVAILABLE },
    });
  }
  await client.productCategory.upsert({
    where: { id: seedIds.category },
    update: { merchantId: seedIds.merchant, name: '主食', sortOrder: 1 },
    create: { id: seedIds.category, merchantId: seedIds.merchant, name: '主食', sortOrder: 1 },
  });
  await client.product.upsert({
    where: { id: seedIds.productRice },
    update: { merchantId: seedIds.merchant, categoryId: seedIds.category, name: '鸡腿饭', priceMinor: 1500, isAvailable: true },
    create: { id: seedIds.productRice, merchantId: seedIds.merchant, categoryId: seedIds.category, name: '鸡腿饭', priceMinor: 1500, isAvailable: true },
  });
  await client.product.upsert({
    where: { id: seedIds.productTea },
    update: { merchantId: seedIds.merchant, categoryId: seedIds.category, name: '柠檬茶', priceMinor: 500, isAvailable: true },
    create: { id: seedIds.productTea, merchantId: seedIds.merchant, categoryId: seedIds.category, name: '柠檬茶', priceMinor: 500, isAvailable: true },
  });
  await client.merchantSubsidyAccount.upsert({
    where: { id: seedIds.subsidyAccount },
    update: { merchantId: seedIds.merchant, subsidyLimitMinor: 1000 },
    create: { id: seedIds.subsidyAccount, merchantId: seedIds.merchant, subsidyLimitMinor: 1000 },
  });
  await client.businessConfig.upsert({
    where: { id: seedIds.policyConfig },
    update: { key: 'ORDER_POLICY', version: 1, isActive: true, payload: demoPolicy },
    create: { id: seedIds.policyConfig, key: 'ORDER_POLICY', version: 1, isActive: true, payload: demoPolicy },
  });
}

const demoPolicy = {
  customerDeliveryFeeMinor: 0,
  targetRiderPayoutMinor: 300,
  maxSubsidyPerOrderMinor: 200,
  platformCommissionBps: 500,
  subsidyEnabled: true,
  exposureThresholds: [
    { minUsageBps: 0, state: 'NORMAL' },
    { minUsageBps: 2500, state: 'REDUCED' },
    { minUsageBps: 5000, state: 'LIMITED' },
    { minUsageBps: 7500, state: 'SEVERELY_LIMITED' },
    { minUsageBps: 9000, state: 'HIDDEN' },
    { minUsageBps: 10000, state: 'SUSPENDED' },
  ],
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const client = new PrismaClient();
  seedDatabase(client)
    .then(() => console.log('Seed completed. Demo values are configuration examples, not production business rules.'))
    .finally(() => client.$disconnect());
}
