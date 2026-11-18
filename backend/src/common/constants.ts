/** Đơn chưa thanh toán quá số phút này sẽ tự hủy. Có thể đổi bằng ORDER_EXPIRE_MINUTES. */
export const ORDER_EXPIRE_MINUTES_DEFAULT = 15;

/**
 * Khách chỉ được tự hủy đơn ĐÃ thanh toán trong số phút này kể từ lúc thanh toán
 * (tránh hủy khi ly đã được pha xong). Có thể đổi bằng REFUND_WINDOW_MINUTES.
 */
export const REFUND_WINDOW_MINUTES_DEFAULT = 5;

/** Giao dịch PENDING quá thời hạn này được xem là treo, không còn chặn việc hủy/tự hủy đơn. */
export const PAYMENT_PENDING_TTL_MS = 2 * 60 * 1000;

export function refundWindowMs(): number {
  const minutes = Number(process.env.REFUND_WINDOW_MINUTES);
  return (
    (Number.isFinite(minutes) && minutes > 0
      ? minutes
      : REFUND_WINDOW_MINUTES_DEFAULT) * 60_000
  );
}
