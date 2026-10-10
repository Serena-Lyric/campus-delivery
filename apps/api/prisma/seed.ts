import {
  CampusLocationType,
  DeliveryAssignmentStatus,
  DeliveryMethod,
  DeliveryTaskStatus,
  DeliveryVerificationMode,
  EvidenceType,
  ExceptionType,
  MerchantExposureState,
  OrderEventActorType,
  OrderEventType,
  OrderStatus,
  PickupVerificationMode,
  PrismaClient,
  RiderSettlementStatus,
  RiderStatus,
  SettlementStatus,
  UserRole,
  VerificationPurpose,
} from '@prisma/client';
import { scryptSync } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { pricingConfigLock } from '../src/pricing/config.js';

export const seedIds = {
  customer: '00000000-0000-4000-8000-000000000001',
  merchantUser: '00000000-0000-4000-8000-000000000002',
  riderAUser: '00000000-0000-4000-8000-000000000003',
  riderBUser: '00000000-0000-4000-8000-000000000004',
  admin: '00000000-0000-4000-8000-000000000005',
  operator: '00000000-0000-4000-8000-000000000006',
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
  adminProfile: '71000000-0000-4000-8000-000000000001',
  operatorProfile: '71000000-0000-4000-8000-000000000002',
} as const;

const scenarioIds = {
  normal: '80000000-0000-4000-8000-000000000001',
  cooling: '80000000-0000-4000-8000-000000000002',
  waitingRider: '80000000-0000-4000-8000-000000000003',
  delivering: '80000000-0000-4000-8000-000000000004',
  requiresCode: '80000000-0000-4000-8000-000000000005',
  unreachable: '80000000-0000-4000-8000-000000000006',
  evidence: '80000000-0000-4000-8000-000000000007',
  dispute: '80000000-0000-4000-8000-000000000008',
} as const;

export const demoPolicy = {
  fragilePickupRecommendedMinor: 1500,
  fragilePickupRequiredMinor: 5000,
  deliveryPricingDefaultCustomerFeeMinor: 300,
  deliveryPricingDefaultRiderBasePayoutMinor: 200,
  deliveryPricingAdditionalItemCustomerFeeMinor: 20,
  deliveryPricingAdditionalItemRiderPayoutMinor: 20,
  deliveryPricingMerchantOverrides: [],
  platformCommissionBps: 0,
  subsidyEnabled: true,
  coolingOffSeconds: 60,
  verificationCodeTtlSeconds: 600,
  riderSettlementPendingSeconds: 432000,
  platformMaxConcurrentOrdersPerRider: 10,
  customerUnreachableWaitSeconds: 300,
  riderTipWindowSeconds: 86400,
  merchantRepriceCooldownSeconds: 15,
  orderClaimWindowSeconds: 2400,
  defaultNaturalClaimBaselineSeconds: 600,
  finalUserWarningSecondsBeforeClaimDeadline: 300,
  platformSubsidyStepMinor: 50,
  platformSubsidyMaxStepMinor: 100,
  platformSubsidyMaxPerOrderMinor: 300,
  platformSubsidyMinIntervalSeconds: 300,
  merchantSubsidyBudgetMaxUsageBpsPerOrder: 2000,
  unattendedDeliveryMethods: ['DESIGNATED_POINT', 'DOOR'],
  handoffCodeDeliveryMethods: ['FACE_TO_FACE'],
  requireHandoffCodeForAllOrders: false,
  merchantRiskWindowOrderCount: 50,
  merchantRiskMinimumSampleSize: 10,
  merchantTrialExposureBps: 2500,
  merchantExposureRecoveryMinimumSampleSize: 10,
  merchantExposureRecoveryWindowOrderCount: 20,
  slowFulfillmentThresholdSeconds: 2700,
  completionRiskElevatedThresholdBps: 1500,
  completionRiskHighThresholdBps: 3000,
  exposureReducedThresholdBps: 1500,
  exposureLimitedThresholdBps: 3000,
  exposureSeverelyLimitedThresholdBps: 5000,
  exposureNormalRecoveryThresholdBps: 800,
  exposureReducedRecoveryThresholdBps: 2000,
  exposureLimitedRecoveryThresholdBps: 3500,
  subsidyDependencyThresholdBps: 5000,
  subsidyRescueThresholdBps: 5000,
  riderDailyFreeCancelLimit: 2,
  riderCancellationRollingWindowDays: 7,
  riderCancellationCooldownThreshold: 4,
  riderWarningCooldownThreshold: 2,
  riderCancellationCooldownSeconds: 172800,
  riderWarningCooldownSeconds: 172800,
};

async function seedScenarioOrders(client: PrismaClient) {
  const createdScenarioIds = new Set<string>();
  const now = new Date();
  const day = new Date('2026-09-22T00:00:00.000Z');
  const scenarios = [
    [scenarioIds.normal, 'DAAA', OrderStatus.MERCHANT_PENDING, DeliveryMethod.DESIGNATED_POINT, DeliveryVerificationMode.DELIVERY_PHOTO],
    [scenarioIds.cooling, 'DAAB', OrderStatus.CREATED, DeliveryMethod.DOOR, DeliveryVerificationMode.DELIVERY_PHOTO],
    [scenarioIds.waitingRider, 'DAAC', OrderStatus.READY_FOR_RIDER, DeliveryMethod.DESIGNATED_POINT, DeliveryVerificationMode.DELIVERY_PHOTO],
    [scenarioIds.delivering, 'DAAD', OrderStatus.PICKED_UP, DeliveryMethod.DOOR, DeliveryVerificationMode.DELIVERY_PHOTO],
    [scenarioIds.requiresCode, 'DAAE', OrderStatus.PICKED_UP, DeliveryMethod.FACE_TO_FACE, DeliveryVerificationMode.HANDOFF_CODE],
    [scenarioIds.unreachable, 'DAAF', OrderStatus.PICKED_UP, DeliveryMethod.DESIGNATED_POINT, DeliveryVerificationMode.DELIVERY_PHOTO],
    [scenarioIds.evidence, 'DAAG', OrderStatus.DELIVERED, DeliveryMethod.DOOR, DeliveryVerificationMode.DELIVERY_PHOTO],
    [scenarioIds.dispute, 'DAAH', OrderStatus.DELIVERED, DeliveryMethod.DOOR, DeliveryVerificationMode.DELIVERY_PHOTO],
  ] as const;

  for (const [id, shortCode, status, deliveryMethod, deliveryVerificationMode] of scenarios) {
    // Demo scenarios are insert-only: rerunning seed must not rewrite historical prices or workflow facts.
    if (await client.order.findUnique({ where: { id }, select: { id: true } })) continue;
    createdScenarioIds.add(id);
    await client.order.upsert({
      where: { id },
      update: {
        shortCode,
        shortCodeDay: day,
        coolingOffEndsAt: status === OrderStatus.CREATED ? new Date(now.getTime() + 60_000) : new Date(now.getTime() - 60_000),
        tipDeadline: new Date(now.getTime() + demoPolicy.riderTipWindowSeconds * 1000),
        status,
        deliveryMethod,
        deliveryVerificationMode,
        pickupVerificationMode: PickupVerificationMode.CONFIRMATION,
        pickupMerchantNameSnapshot: '校园饭堂演示店',
        pickupLocationNameSnapshot: '第一食堂',
        pickupRegionSnapshot: '东门片区',
        destinationRegionSnapshot: '一期',
      },
      create: {
        id,
        shortCode,
        shortCodeDay: day,
        coolingOffEndsAt: status === OrderStatus.CREATED ? new Date(now.getTime() + 60_000) : new Date(now.getTime() - 60_000),
        tipDeadline: new Date(now.getTime() + demoPolicy.riderTipWindowSeconds * 1000),
        customerId: seedIds.customer,
        merchantId: seedIds.merchant,
        destinationLocationId: seedIds.dormLocation,
        destinationLabelSnapshot: '学生宿舍 3 号楼',
        destinationRegionSnapshot: '一期',
        pickupMerchantNameSnapshot: '校园饭堂演示店',
        pickupLocationNameSnapshot: '第一食堂',
        pickupRegionSnapshot: '东门片区',
        status,
        deliveryMethod,
        deliveryVerificationMode,
        pickupVerificationMode: PickupVerificationMode.CONFIRMATION,
      },
    });
    const seededPlatformSubsidyMinor = id === scenarioIds.requiresCode ? 50 : 0;
    const seededCustomerTipMinor = id === scenarioIds.delivering ? 20 : 0;
    const seededPayoutMinor = 200 + seededPlatformSubsidyMinor + seededCustomerTipMinor;
    await client.orderPricing.upsert({
      where: { orderId: id },
      update: {
        merchantDeliveryContributionMinor: 0,
        merchantBaseDeliveryPriceMinor: 100,
        riderBasePayoutMinor: 200,
        merchantRescueContributionMinor: 0,
        customerDeliveryFeeMinor: 300,
        customerRiderTipMinor: seededCustomerTipMinor,
        platformSubsidyMinor: seededPlatformSubsidyMinor,
        riderGuaranteedPayoutMinor: seededPayoutMinor,
        riderPayoutMinor: seededPayoutMinor,
        deliveryPlatformContributionMinor: 300 - 200 - seededPlatformSubsidyMinor,
        pricingPolicyVersion: 1,
        pricingInputsSnapshot: { source: 'SEED_DEMO' },
        pricingReason: 'SEED_DEMO',
        platformCommissionMinor: 0,
        merchantSettlementMinor: 1500,
        merchantRescueContributionVersion: 0,
        merchantRescueUpdatedAt: now,
        merchantQuoteVersion: 0,
        merchantQuoteUpdatedAt: null,
      },
      create: {
        orderId: id,
        itemSubtotalMinor: 1500,
        merchantDeliveryContributionMinor: 0,
        merchantBaseDeliveryPriceMinor: 100,
        riderBasePayoutMinor: 200,
        merchantRescueContributionMinor: 0,
        customerDeliveryFeeMinor: 300,
        customerRiderTipMinor: seededCustomerTipMinor,
        platformSubsidyMinor: seededPlatformSubsidyMinor,
        riderGuaranteedPayoutMinor: seededPayoutMinor,
        riderPayoutMinor: seededPayoutMinor,
        deliveryPlatformContributionMinor: 300 - 200 - seededPlatformSubsidyMinor,
        pricingPolicyVersion: 1,
        pricingInputsSnapshot: { source: 'SEED_DEMO' },
        pricingReason: 'SEED_DEMO',
        platformCommissionMinor: 0,
        merchantSettlementMinor: 1500,
        merchantRescueContributionVersion: 0,
        merchantRescueUpdatedAt: now,
        merchantQuoteVersion: 0,
        merchantQuoteUpdatedAt: null,
      },
    });
    await client.settlement.upsert({
      where: { orderId: id },
      update: {},
      create: { orderId: id },
    });
    const eventId = id.replace(/^8/, '9');
    await client.orderEvent.upsert({
      where: { id: eventId },
      update: { toStatus: status },
      create: {
        id: eventId,
        orderId: id,
        eventType: OrderEventType.STATUS_CHANGED,
        actorType: OrderEventActorType.SYSTEM,
        toStatus: status,
        reason: 'Seed demonstration state',
      },
    });
  }

  const taskScenarios = [
    [scenarioIds.waitingRider, 'a0000000-0000-4000-8000-000000000003', DeliveryTaskStatus.OPEN, null],
    [scenarioIds.delivering, 'a0000000-0000-4000-8000-000000000004', DeliveryTaskStatus.PICKED_UP, seedIds.riderA],
    [scenarioIds.requiresCode, 'a0000000-0000-4000-8000-000000000005', DeliveryTaskStatus.PICKED_UP, seedIds.riderB],
    [scenarioIds.unreachable, 'a0000000-0000-4000-8000-000000000006', DeliveryTaskStatus.PICKED_UP, seedIds.riderB],
    [scenarioIds.evidence, 'a0000000-0000-4000-8000-000000000007', DeliveryTaskStatus.COMPLETED, seedIds.riderA],
    [scenarioIds.dispute, 'a0000000-0000-4000-8000-000000000008', DeliveryTaskStatus.COMPLETED, seedIds.riderA],
  ] as const;

  for (const [orderId, taskId, status, riderId] of taskScenarios) {
    if (!createdScenarioIds.has(orderId)) continue;
    const firstPublishedAt = new Date(now.getTime() - 600_000);
    const claimDeadline = new Date(firstPublishedAt.getTime() + demoPolicy.orderClaimWindowSeconds * 1000);
    const platformSubsidyMinor = orderId === scenarioIds.requiresCode ? 50 : 0;
    const customerTipMinor = orderId === scenarioIds.delivering ? 20 : 0;
    const payoutMinor = 200 + platformSubsidyMinor + customerTipMinor;
    await client.deliveryTask.upsert({
      where: { id: taskId },
      update: {
        status,
        riderId,
        payoutMinor,
        firstPublishedAt,
        claimDeadline,
        finalUserWarningAt: new Date(claimDeadline.getTime() - demoPolicy.finalUserWarningSecondsBeforeClaimDeadline * 1000),
        marketPolicyVersion: 1,
        merchantRepriceCooldownSeconds: demoPolicy.merchantRepriceCooldownSeconds,
        riderSettlementPendingSeconds: demoPolicy.riderSettlementPendingSeconds,
      },
      create: {
        id: taskId,
        orderId,
        status,
        riderId,
        payoutMinor,
        firstPublishedAt,
        claimDeadline,
        finalUserWarningAt: new Date(claimDeadline.getTime() - demoPolicy.finalUserWarningSecondsBeforeClaimDeadline * 1000),
        marketPolicyVersion: 1,
        merchantRepriceCooldownSeconds: demoPolicy.merchantRepriceCooldownSeconds,
        riderSettlementPendingSeconds: demoPolicy.riderSettlementPendingSeconds,
        claimedAt: riderId ? now : null,
        pickedUpAt: status === DeliveryTaskStatus.PICKED_UP || status === DeliveryTaskStatus.COMPLETED ? now : null,
        deliveredAt: status === DeliveryTaskStatus.COMPLETED ? now : null,
      },
    });
    if (riderId) {
      const assignmentId = taskId.replace(/^a/, 'b');
      await client.deliveryAssignment.upsert({
        where: { id: assignmentId },
        update: {
          status: status === DeliveryTaskStatus.COMPLETED ? DeliveryAssignmentStatus.COMPLETED : DeliveryAssignmentStatus.ACTIVE,
          merchantQuoteMinorAtClaim: 0,
          customerTipMinorAtClaim: customerTipMinor,
          platformSubsidyMinorAtClaim: platformSubsidyMinor,
          riderPayoutMinorAtClaim: payoutMinor,
          riderGuaranteedPayoutMinorAtClaim: payoutMinor,
          quoteVersionAtClaim: 0,
          customerDeliveryFeeMinorAtClaim: 300,
          riderBasePayoutMinorAtClaim: 200,
          merchantRescueContributionMinorAtClaim: 0,
          deliveryPlatformContributionMinorAtClaim: 300 - 200 - platformSubsidyMinor,
          pricingPolicyVersionAtClaim: 1,
          pricingInputsSnapshotAtClaim: { source: 'SEED_DEMO' },
          claimSampleType: platformSubsidyMinor > 0 ? 'SUBSIDIZED' : 'NATURAL',
          claimLatencySeconds: 600,
        },
        create: {
          id: assignmentId,
          taskId,
          orderId,
          riderId,
          status: status === DeliveryTaskStatus.COMPLETED ? DeliveryAssignmentStatus.COMPLETED : DeliveryAssignmentStatus.ACTIVE,
          claimedAt: now,
          endedAt: status === DeliveryTaskStatus.COMPLETED ? now : null,
          merchantQuoteMinorAtClaim: 0,
          customerTipMinorAtClaim: customerTipMinor,
          platformSubsidyMinorAtClaim: platformSubsidyMinor,
          riderPayoutMinorAtClaim: payoutMinor,
          riderGuaranteedPayoutMinorAtClaim: payoutMinor,
          quoteVersionAtClaim: 0,
          customerDeliveryFeeMinorAtClaim: 300,
          riderBasePayoutMinorAtClaim: 200,
          merchantRescueContributionMinorAtClaim: 0,
          deliveryPlatformContributionMinorAtClaim: 300 - 200 - platformSubsidyMinor,
          pricingPolicyVersionAtClaim: 1,
          pricingInputsSnapshotAtClaim: { source: 'SEED_DEMO' },
          claimSampleType: platformSubsidyMinor > 0 ? 'SUBSIDIZED' : 'NATURAL',
          claimLatencySeconds: 600,
        },
      });
    }
  }

  if (createdScenarioIds.has(scenarioIds.requiresCode)) await client.subsidyRecord.upsert({
    where: { id: '61000000-0000-4000-8000-000000000005' },
    update: {
      previousPlatformSubsidyMinor: 0,
      addedMinor: 50,
      newPlatformSubsidyMinor: 50,
      trigger: 'SEED_DEMO_INCREMENT',
    },
    create: {
      id: '61000000-0000-4000-8000-000000000005',
      merchantId: seedIds.merchant,
      orderId: scenarioIds.requiresCode,
      previousPlatformSubsidyMinor: 0,
      addedMinor: 50,
      newPlatformSubsidyMinor: 50,
      policyVersion: 1,
      trigger: 'SEED_DEMO_INCREMENT',
      createdAt: now,
    },
  });

  if (createdScenarioIds.has(scenarioIds.evidence)) await client.evidence.upsert({
    where: { id: 'c0000000-0000-4000-8000-000000000007' },
    update: {},
    create: {
      id: 'c0000000-0000-4000-8000-000000000007',
      orderId: scenarioIds.evidence,
      actorId: seedIds.riderAUser,
      actorRole: UserRole.RIDER,
      evidenceType: EvidenceType.DELIVERY_PHOTO,
      orderStage: OrderStatus.PICKED_UP,
      mediaReference: 'mock://seed/delivery-photo.jpg',
      note: 'Seed现场证据',
      metadata: { authenticityVerified: false, source: 'CAMERA' },
    },
  });

  if (createdScenarioIds.has(scenarioIds.unreachable)) await client.exceptionEvent.upsert({
    where: { id: 'd0000000-0000-4000-8000-000000000006' },
    update: {},
    create: {
      id: 'd0000000-0000-4000-8000-000000000006',
      orderId: scenarioIds.unreachable,
      reporterId: seedIds.riderBUser,
      reporterRole: UserRole.RIDER,
      orderStatus: OrderStatus.PICKED_UP,
      type: ExceptionType.CUSTOMER_UNREACHABLE,
      description: 'Seed 用户失联事实',
    },
  });

  if (createdScenarioIds.has(scenarioIds.dispute)) await client.exceptionEvent.upsert({
    where: { id: 'd0000000-0000-4000-8000-000000000008' },
    update: {},
    create: {
      id: 'd0000000-0000-4000-8000-000000000008',
      orderId: scenarioIds.dispute,
      reporterId: seedIds.customer,
      reporterRole: UserRole.CUSTOMER,
      orderStatus: OrderStatus.DELIVERED,
      type: ExceptionType.DELIVERY_DISPUTE,
      description: 'Seed 配送争议',
    },
  });

  if (createdScenarioIds.has(scenarioIds.dispute)) await client.riderSettlement.upsert({
    where: { orderId: scenarioIds.dispute },
    update: { status: RiderSettlementStatus.HELD, holdReason: ExceptionType.DELIVERY_DISPUTE },
    create: {
      id: 'e0000000-0000-4000-8000-000000000008',
      orderId: scenarioIds.dispute,
      riderId: seedIds.riderA,
      amountMinor: 300,
      status: RiderSettlementStatus.HELD,
      pendingUntil: now,
      heldAt: now,
      holdReason: ExceptionType.DELIVERY_DISPUTE,
    },
  });

  const salt = 'seed-delivery-code';
  if (createdScenarioIds.has(scenarioIds.requiresCode)) await client.verificationCode.upsert({
    where: { id: 'f0000000-0000-4000-8000-000000000005' },
    update: {
      salt,
      codeHash: scryptSync('246810', salt, 32).toString('hex'),
      expiresAt: new Date(now.getTime() + 86_400_000),
      verifiedAt: null,
      invalidatedAt: null,
    },
    create: {
      id: 'f0000000-0000-4000-8000-000000000005',
      orderId: scenarioIds.requiresCode,
      purpose: VerificationPurpose.DELIVERY,
      salt,
      codeHash: scryptSync('246810', salt, 32).toString('hex'),
      issuerId: seedIds.customer,
      expiresAt: new Date(now.getTime() + 86_400_000),
    },
  });
}

export async function seedDatabase(client: PrismaClient) {
  await client.campusLocation.upsert({
    where: { id: seedIds.merchantLocation },
    update: {
      name: '第一食堂',
      type: CampusLocationType.CANTEEN,
      supportedDeliveryMethods: [DeliveryMethod.DESIGNATED_POINT, DeliveryMethod.DOOR, DeliveryMethod.FACE_TO_FACE],
      regionLabel: '东门片区',
    },
    create: {
      id: seedIds.merchantLocation,
      name: '第一食堂',
      type: CampusLocationType.CANTEEN,
      supportedDeliveryMethods: [DeliveryMethod.DESIGNATED_POINT, DeliveryMethod.DOOR, DeliveryMethod.FACE_TO_FACE],
      regionLabel: '东门片区',
    },
  });
  await client.campusLocation.upsert({
    where: { id: seedIds.dormLocation },
    update: {
      name: '学生宿舍 3 号楼',
      type: CampusLocationType.DORMITORY,
      supportedDeliveryMethods: [DeliveryMethod.DESIGNATED_POINT, DeliveryMethod.DOOR, DeliveryMethod.FACE_TO_FACE],
      regionLabel: '一期',
    },
    create: {
      id: seedIds.dormLocation,
      name: '学生宿舍 3 号楼',
      type: CampusLocationType.DORMITORY,
      supportedDeliveryMethods: [DeliveryMethod.DESIGNATED_POINT, DeliveryMethod.DOOR, DeliveryMethod.FACE_TO_FACE],
      regionLabel: '一期',
    },
  });

  const users = [
    [seedIds.customer, '演示用户', UserRole.CUSTOMER],
    [seedIds.merchantUser, '演示商家管理员', UserRole.MERCHANT],
    [seedIds.riderAUser, '演示骑手 A', UserRole.RIDER],
    [seedIds.riderBUser, '演示骑手 B', UserRole.RIDER],
    [seedIds.admin, '演示平台管理员', UserRole.ADMIN],
    [seedIds.operator, '演示普通管理员', UserRole.ADMIN],
  ] as const;
  for (const [id, displayName, role] of users) {
    await client.user.upsert({
      where: { id },
      update: { displayName, role, active: true },
      create: { id, displayName, role, active: true },
    });
  }

  await client.adminProfile.upsert({
    where: { userId: seedIds.admin },
    update: { level: 'SUPER_ADMIN' },
    create: { id: seedIds.adminProfile, userId: seedIds.admin, level: 'SUPER_ADMIN' },
  });
  await client.adminProfile.upsert({
    where: { userId: seedIds.operator },
    update: { level: 'OPERATOR' },
    create: { id: seedIds.operatorProfile, userId: seedIds.operator, level: 'OPERATOR' },
  });

  await client.merchant.upsert({
    where: { id: seedIds.merchant },
    update: {
      name: '校园饭堂演示店',
      ownerId: seedIds.merchantUser,
      campusLocationId: seedIds.merchantLocation,
      isOpen: true,
      exposureState: MerchantExposureState.NORMAL,
      trialExposureOverrideBps: 10_000,
      maxConcurrentOrders: 20,
      deliveryContributionMinor: 0,
      supportedDeliveryMethods: [DeliveryMethod.DESIGNATED_POINT, DeliveryMethod.DOOR, DeliveryMethod.FACE_TO_FACE],
      pickupVerificationMode: PickupVerificationMode.CONFIRMATION,
    },
    create: {
      id: seedIds.merchant,
      name: '校园饭堂演示店',
      description: '仅用于本地阶段演示',
      ownerId: seedIds.merchantUser,
      campusLocationId: seedIds.merchantLocation,
      isOpen: true,
      exposureState: MerchantExposureState.NORMAL,
      trialExposureOverrideBps: 10_000,
      maxConcurrentOrders: 20,
      deliveryContributionMinor: 0,
      baseDeliveryPriceMinor: 100,
      supportedDeliveryMethods: [DeliveryMethod.DESIGNATED_POINT, DeliveryMethod.DOOR, DeliveryMethod.FACE_TO_FACE],
      pickupVerificationMode: PickupVerificationMode.CONFIRMATION,
    },
  });
  for (const [id, userId] of [[seedIds.riderA, seedIds.riderAUser], [seedIds.riderB, seedIds.riderBUser]] as const) {
    await client.rider.upsert({
      where: { id },
      update: {
        userId,
        status: RiderStatus.AVAILABLE,
        currentConcurrentOrderLimit: id === seedIds.riderA ? 5 : 1,
        firstNormalDeliveredAt: id === seedIds.riderA ? new Date('2026-09-20T04:00:00.000Z') : null,
        capacityOverride: null,
      },
      create: {
        id,
        userId,
        status: RiderStatus.AVAILABLE,
        currentConcurrentOrderLimit: id === seedIds.riderA ? 5 : 1,
        firstNormalDeliveredAt: id === seedIds.riderA ? new Date('2026-09-20T04:00:00.000Z') : null,
      },
    });
  }
  await client.productCategory.upsert({
    where: { id: seedIds.category },
    update: { merchantId: seedIds.merchant, name: '主食', sortOrder: 1 },
    create: { id: seedIds.category, merchantId: seedIds.merchant, name: '主食', sortOrder: 1 },
  });
  await client.product.upsert({
    where: { id: seedIds.productRice },
    update: { merchantId: seedIds.merchant, categoryId: seedIds.category, name: '鸡腿饭', deliveryCategoryCode: 'ORDINARY_MEAL', priceMinor: 1500, isAvailable: true },
    create: { id: seedIds.productRice, merchantId: seedIds.merchant, categoryId: seedIds.category, name: '鸡腿饭', deliveryCategoryCode: 'ORDINARY_MEAL', priceMinor: 1500, isAvailable: true },
  });
  await client.product.upsert({
    where: { id: seedIds.productTea },
    update: { merchantId: seedIds.merchant, categoryId: seedIds.category, name: '柠檬茶', deliveryCategoryCode: 'DRINK', priceMinor: 500, isAvailable: true },
    create: { id: seedIds.productTea, merchantId: seedIds.merchant, categoryId: seedIds.category, name: '柠檬茶', deliveryCategoryCode: 'DRINK', priceMinor: 500, isAvailable: true },
  });
  await client.merchantSubsidyAccount.upsert({
    where: { id: seedIds.subsidyAccount },
    update: { merchantId: seedIds.merchant, subsidyUsedMinor: 50, subsidyLimitMinor: 1000, subsidyUsageBps: 500 },
    create: {
      id: seedIds.subsidyAccount,
      merchantId: seedIds.merchant,
      subsidyUsedMinor: 50,
      subsidyLimitMinor: 1000,
      subsidyUsageBps: 500,
    },
  });
  await client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${pricingConfigLock})`;
    if (!await tx.businessConfig.findFirst({ where: { key: 'ORDER_POLICY' }, select: { id: true } })) {
      await tx.businessConfig.create({ data: { id: seedIds.policyConfig, key: 'ORDER_POLICY', version: 1, isActive: true, payload: demoPolicy } });
    }
  });

  await seedScenarioOrders(client);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const client = new PrismaClient();
  seedDatabase(client)
    .then(() => console.log('Seed completed. Demo values are configuration examples, not production business rules.'))
    .finally(() => client.$disconnect());
}
