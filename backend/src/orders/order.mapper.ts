import type { Prisma } from '@prisma/client';
import { POINT_VALUE } from '../common/pricing';
import { refundWindowMs } from '../common/constants';
import { CANCELLABLE_STATUSES } from './order-state-machine';

export const ORDER_INCLUDE = {
  items: { orderBy: { id: 'asc' } },
  payments: { orderBy: { id: 'desc' }, take: 1 },
  statusLogs: { orderBy: { id: 'asc' } },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;

interface ToppingSnapshot {
  id: number;
  name: string;
  price: number;
}

/** Hạn hủy đơn đã thanh toán: tính từ lúc đơn chuyển sang PAID. Đơn chưa thanh toán thì null. */
export function paidCancelDeadline(order: {
  status: string;
  statusLogs: { status: string; createdAt: Date }[];
}): Date | null {
  if (order.status !== 'PAID') return null;
  const paidAt = [...order.statusLogs]
    .reverse()
    .find((l) => l.status === 'PAID')?.createdAt;
  return paidAt ? new Date(paidAt.getTime() + refundWindowMs()) : null;
}

/** Chuyển bản ghi DB sang JSON trả về cho frontend. */
export function mapOrder(order: OrderWithRelations) {
  const payment = order.payments[0] ?? null;

  // PENDING / PAYMENT_FAILED: hủy được ngay. PAID: chỉ hủy được trong thời hạn.
  const cancelUntil = paidCancelDeadline(order);
  const canCancel =
    order.status === 'PAID'
      ? cancelUntil !== null && cancelUntil.getTime() > Date.now()
      : CANCELLABLE_STATUSES.includes(order.status);

  return {
    id: order.id,
    code: `#${order.id}`,
    status: order.status,
    subtotal: order.subtotal,
    discount: order.discount,
    couponCode: order.couponCode,
    pointsUsed: order.pointsUsed,
    pointsDiscount: order.pointsUsed * POINT_VALUE,
    total: order.total,
    note: order.note,
    pointsEarned: order.pointsEarned,
    pointsAwarded: order.pointsAwarded,
    canCancel,
    cancelUntil,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    items: order.items.map((i) => ({
      id: i.id,
      productId: i.productId,
      name: i.productName,
      imageUrl: i.imageUrl,
      size: i.size,
      sugar: i.sugar,
      ice: i.ice,
      toppings: (i.toppings as unknown as ToppingSnapshot[]) ?? [],
      unitPrice: i.unitPrice,
      qty: i.qty,
      lineTotal: i.lineTotal,
    })),
    payment: payment && {
      id: payment.id,
      method: payment.method,
      provider: payment.provider,
      status: payment.status,
      amount: payment.amount,
      transactionId: payment.transactionId,
      failureReason: payment.failureReason,
      createdAt: payment.createdAt,
    },
    timeline: order.statusLogs.map((l) => ({
      status: l.status,
      at: l.createdAt,
    })),
  };
}
