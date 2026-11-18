// Backend: Orders history & Home products logic
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PAYMENT_PENDING_TTL_MS } from '../common/constants';
import { POINT_VALUE, calcUnitPrice, earnedPoints } from '../common/pricing';
import { PrismaService } from '../prisma/prisma.service';
import { PromotionsService } from '../promotions/promotions.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { ListOrdersQuery, UpdateOrderStatusDto } from './dto/order-query.dto';
import { releaseStock, reserveStock } from './inventory';
import { ORDER_INCLUDE, mapOrder, paidCancelDeadline } from './order.mapper';
import { canTransition } from './order-state-machine';
import { transitionOrder } from './order-transitions';

/** Đơn kèm các trường cần để hủy / hoàn tài nguyên. */
interface CancellableOrder {
  id: number;
  userId: number;
  status: 'PENDING' | 'PAID' | 'PREPARING' | 'READY' | 'COMPLETED' | 'PAYMENT_FAILED' | 'CANCELLED';
  version: number;
  couponCode: string | null;
  pointsUsed: number;
  pointsEarned: number;
  pointsAwarded: boolean;
  items: { productId: number; qty: number }[];
}

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly promotions: PromotionsService,
  ) {}

  /**
   * POST /orders — tạo đơn PENDING.
   * Giá luôn được tính lại ở server (không tin giá từ client).
   * Toàn bộ trong 1 transaction: giữ hàng + dùng mã + trừ điểm + tạo đơn.
   */
  async create(userId: number, dto: CreateOrderDto) {
    const orderId = await this.prisma.$transaction(
      async (tx) => {
        const productIds = [...new Set(dto.items.map((i) => i.productId))];
        const products = await tx.product.findMany({
          where: { id: { in: productIds }, isActive: true },
        });
        if (products.length !== productIds.length) {
          throw new BadRequestException(
            'Có sản phẩm không tồn tại hoặc đã ngừng bán',
          );
        }

        const toppingIds = [
          ...new Set(dto.items.flatMap((i) => i.toppingIds ?? [])),
        ];
        const toppings = toppingIds.length
          ? await tx.topping.findMany({
              where: { id: { in: toppingIds }, isActive: true },
            })
          : [];
        if (toppings.length !== toppingIds.length) {
          throw new BadRequestException('Có topping không hợp lệ');
        }

        const productMap = new Map(products.map((p) => [p.id, p]));
        const toppingMap = new Map(toppings.map((t) => [t.id, t]));

        const needs = new Map<number, number>();
        const itemsData: Prisma.OrderItemUncheckedCreateWithoutOrderInput[] =
          [];
        let subtotal = 0;

        for (const item of dto.items) {
          const product = productMap.get(item.productId)!;
          const chosen = [...new Set(item.toppingIds ?? [])].map(
            (id) => toppingMap.get(id)!,
          );
          const unitPrice = calcUnitPrice(
            product.price,
            item.size,
            chosen.map((t) => t.price),
          );
          const lineTotal = unitPrice * item.qty;
          subtotal += lineTotal;
          needs.set(product.id, (needs.get(product.id) ?? 0) + item.qty);

          itemsData.push({
            productId: product.id,
            productName: product.name,
            imageUrl: product.imageUrl,
            size: item.size,
            sugar: item.sugar ?? '100%',
            ice: item.ice ?? 'Đá bình thường',
            toppings: chosen.map((t) => ({
              id: t.id,
              name: t.name,
              price: t.price,
            })) as Prisma.InputJsonValue,
            unitPrice,
            qty: item.qty,
            lineTotal,
          });
        }

        // Kiểm soát tồn kho (optimistic locking)
        await reserveStock(tx, needs);

        // Mã khuyến mãi
        let discount = 0;
        let couponCode: string | null = null;
        if (dto.couponCode?.trim()) {
          const ev = await this.promotions.evaluate(
            tx,
            dto.couponCode,
            subtotal,
          );
          await this.promotions.consume(tx, ev.promotion);
          discount = ev.discount;
          couponCode = ev.promotion.code;
        }

        // Dùng điểm thưởng
        const pointsUsed = dto.pointsToUse ?? 0;
        if (pointsUsed > 0) {
          const maxPoints = Math.floor((subtotal - discount) / POINT_VALUE);
          if (pointsUsed > maxPoints) {
            throw new BadRequestException(
              'Số điểm sử dụng vượt quá giá trị đơn hàng',
            );
          }
          const res = await tx.user.updateMany({
            where: { id: userId, loyaltyPoints: { gte: pointsUsed } },
            data: { loyaltyPoints: { decrement: pointsUsed } },
          });
          if (res.count !== 1) {
            throw new BadRequestException('Bạn không đủ điểm thưởng');
          }
        }

        const total = subtotal - discount - pointsUsed * POINT_VALUE;

        const order = await tx.order.create({
          data: {
            userId,
            subtotal,
            discount,
            pointsUsed,
            total,
            couponCode,
            note: dto.note?.trim() || null,
            pointsEarned: earnedPoints(total),
            items: { create: itemsData },
            statusLogs: { create: [{ status: 'PENDING' }] },
          },
          select: { id: true },
        });
        return order.id;
      },
      { timeout: 15000, maxWait: 10000 },
    );

    return this.findOneForUser(userId, orderId);
  }

  /** GET /orders/me — lịch sử đơn (lọc + phân trang) */
  async listForUser(userId: number, q: ListOrdersQuery) {
    const page = q.page ?? 1;
    const pageSize = q.pageSize ?? 10;

    const where: Prisma.OrderWhereInput = { userId };
    if (q.status) where.status = q.status;
    if (q.month) {
      const [y, m] = q.month.split('-').map(Number);
      where.createdAt = { gte: new Date(y, m - 1, 1), lt: new Date(y, m, 1) };
    }
    if (q.search?.trim()) {
      const id = Number(q.search.replace('#', '').trim());
      where.id = Number.isInteger(id) && id > 0 ? id : -1; // -1: không khớp đơn nào
    }

    const [total, orders] = await this.prisma.$transaction([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: ORDER_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);

    return {
      items: orders.map(mapOrder),
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  /** GET /orders/:id */
  async findOneForUser(userId: number, id: number) {
    const order = await this.prisma.order.findFirst({
      where: { id, userId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
    return mapOrder(order);
  }

  /**
   * Chuyển CANCELLED + hoàn tồn kho, lượt mã, điểm đã dùng;
   * nếu đơn đã thanh toán thì thu hồi điểm đã cộng và đánh dấu hoàn tiền.
   */
  private async cancelInTx(
    tx: Prisma.TransactionClient,
    order: CancellableOrder,
  ) {
    await transitionOrder(tx, order, 'CANCELLED');

    await releaseStock(tx, order.items);
    if (order.couponCode) {
      await this.promotions.release(tx, order.couponCode);
    }

    // Hoàn điểm đã dùng; thu hồi điểm đã cộng (nếu có)
    let pointsDelta = order.pointsUsed;
    if (order.pointsAwarded) pointsDelta -= order.pointsEarned;
    if (pointsDelta !== 0) {
      const user = await tx.user.findUniqueOrThrow({
        where: { id: order.userId },
        select: { loyaltyPoints: true },
      });
      await tx.user.update({
        where: { id: order.userId },
        data: { loyaltyPoints: Math.max(0, user.loyaltyPoints + pointsDelta) },
      });
    }

    await tx.payment.updateMany({
      where: { orderId: order.id, status: 'SUCCESS' },
      data: { status: 'REFUNDED' },
    });
  }

  /** Đơn đang có giao dịch PENDING còn hạn thì không được tự hủy. */
  private async hasLivePendingPayment(
    tx: Prisma.TransactionClient,
    orderId: number,
  ) {
    const n = await tx.payment.count({
      where: {
        orderId,
        status: 'PENDING',
        createdAt: { gt: new Date(Date.now() - PAYMENT_PENDING_TTL_MS) },
      },
    });
    return n > 0;
  }

  /**
   * POST /orders/:id/cancel — khách hủy đơn khi cửa hàng chưa pha chế.
   * Đơn chưa thanh toán: hủy được ngay.
   * Đơn đã thanh toán (PAID): chỉ hủy được trong REFUND_WINDOW_MINUTES kể từ lúc thanh toán.
   * Hoàn kho, hoàn mã, hoàn điểm; nếu đã thanh toán thì đánh dấu hoàn tiền.
   */
  async cancel(userId: number, id: number) {
    await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findFirst({
        where: { id, userId },
        include: { items: true, statusLogs: { orderBy: { id: 'asc' } } },
      });
      if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');

      if (!canTransition(order.status, 'CANCELLED')) {
        throw new BadRequestException(
          order.status === 'CANCELLED'
            ? 'Đơn hàng đã được hủy trước đó'
            : 'Đơn đang được pha chế nên không thể hủy',
        );
      }

      // Ràng buộc thời gian: đơn đã thanh toán chỉ được hủy trong thời hạn cho phép
      if (order.status === 'PAID') {
        const deadline = paidCancelDeadline(order);
        if (!deadline || deadline.getTime() <= Date.now()) {
          throw new BadRequestException(
            'Đơn đã thanh toán quá thời hạn cho phép hủy, vui lòng liên hệ quầy',
          );
        }
      }

      await this.cancelInTx(tx, order);
    });

    return this.findOneForUser(userId, id);
  }

  /**
   * Tự hủy đơn PENDING / PAYMENT_FAILED quá `minutes` phút để trả lại tồn kho, lượt mã, điểm.
   * Bỏ qua đơn đang có giao dịch thanh toán đang xử lý. Trả về số đơn đã hủy.
   */
  async expireStale(minutes: number, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - minutes * 60_000);
    const candidates = await this.prisma.order.findMany({
      where: {
        status: { in: ['PENDING', 'PAYMENT_FAILED'] },
        createdAt: { lt: cutoff },
      },
      select: { id: true },
      take: 100,
    });

    let cancelled = 0;
    for (const { id } of candidates) {
      try {
        const done = await this.prisma.$transaction(async (tx) => {
          const order = await tx.order.findUnique({
            where: { id },
            include: { items: true },
          });
          if (
            !order ||
            (order.status !== 'PENDING' && order.status !== 'PAYMENT_FAILED')
          ) {
            return false;
          }
          if (await this.hasLivePendingPayment(tx, id)) return false;
          await this.cancelInTx(tx, order);
          return true;
        });
        if (done) cancelled++;
      } catch {
        // Đơn vừa được cập nhật ở nơi khác (khách thanh toán / hủy): thử lại ở lượt sau
      }
    }
    return cancelled;
  }

  /** PATCH /orders/:id/status — barista cập nhật tiến độ (STAFF) */
  async updateStatus(id: number, dto: UpdateOrderStatusDto) {
    const userId = await this.prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({ where: { id } });
      if (!order) throw new NotFoundException('Không tìm thấy đơn hàng');
      await transitionOrder(tx, order, dto.status);
      return order.userId;
    });
    return this.findOneForUser(userId, id);
  }
}
