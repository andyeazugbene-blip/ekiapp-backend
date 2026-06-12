import { sendPushToUser } from "./expo-push";

/**
 * Push notification triggers for key events.
 * All functions are fire-and-forget — never throw, never block transactions.
 */
export const pushNotifications = {
  /** Buyer: order paid */
  orderPaid(buyerId: string, orderCount: number): void {
    sendPushToUser(buyerId, {
      title: "Order Confirmed! 🎉",
      body: orderCount > 1
        ? `Your ${orderCount} orders have been confirmed.`
        : "Your order has been confirmed.",
      data: { type: "order_paid" },
    });
  },

  /** Vendor: new order received */
  vendorNewOrder(vendorUserId: string, orderId: string): void {
    sendPushToUser(vendorUserId, {
      title: "New Order! 🛒",
      body: "You have a new order to process.",
      data: { type: "new_order", orderId },
    });
  },

  /** Buyer/Vendor: order status updated */
  orderStatusUpdate(userId: string, orderNumber: string, status: string): void {
    sendPushToUser(userId, {
      title: "Order Update",
      body: `Order ${orderNumber} is now ${status.toLowerCase().replace("_", " ")}.`,
      data: { type: "order_status", orderNumber, status },
    });
  },

  /** Buyer/Vendor: new message */
  newMessage(userId: string, senderName: string): void {
    sendPushToUser(userId, {
      title: "New Message 💬",
      body: `${senderName} sent you a message.`,
      data: { type: "new_message" },
    });
  },

  /** Vendor: payout approved */
  payoutApproved(vendorUserId: string, amount: number, currency: string): void {
    sendPushToUser(vendorUserId, {
      title: "Payout Approved ✅",
      body: `Your payout of ${amount} ${currency} has been approved.`,
      data: { type: "payout_approved" },
    });
  },

  /** Vendor: store verified */
  vendorVerified(vendorUserId: string): void {
    sendPushToUser(vendorUserId, {
      title: "Store Verified! 🎉",
      body: "Your store has been verified. You can now list products.",
      data: { type: "vendor_verified" },
    });
  },

  /** Vendor: low stock alert */
  lowStockAlert(vendorUserId: string, productCount: number): void {
    sendPushToUser(vendorUserId, {
      title: "Low Stock Alert ⚠️",
      body: `${productCount} product(s) are running low on stock.`,
      data: { type: "low_stock" },
    });
  },

  /** Buyer: order delivered by vendor — ready to confirm */
  orderDelivered(buyerUserId: string, orderNumber: string): void {
    sendPushToUser(buyerUserId, {
      title: "Order Delivered! 📦",
      body: `Order ${orderNumber} has been marked as delivered. Please confirm you've received it.`,
      data: { type: "order_delivered", orderNumber },
    });
  },

  /** Vendor: earnings released after buyer confirms delivery */
  earningsReleased(vendorUserId: string, amount: number, currency: string): void {
    sendPushToUser(vendorUserId, {
      title: "Earnings Released ✅",
      body: `${amount / 100} ${currency} in earnings have been released to your wallet. You can now request a payout.`,
      data: { type: "earnings_released" },
    });
  },
};
