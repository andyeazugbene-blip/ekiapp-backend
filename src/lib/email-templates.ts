// Transactional email templates.
// All amounts are in cents — format before rendering.

function formatAmount(cents: number, currency: string): string {
  const symbols: Record<string, string> = { usd: "$", gbp: "£", eur: "€" };
  const symbol = symbols[currency.toLowerCase()] ?? currency.toUpperCase() + " ";
  return `${symbol}${(cents / 100).toFixed(2)}`;
}

function baseLayout(content: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f9fafb; padding: 40px 20px;">
  <div style="max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 12px; padding: 32px; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
    ${content}
    <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;">
    <p style="font-size: 12px; color: #9ca3af; text-align: center;">Eki Marketplace</p>
  </div>
</body>
</html>`.trim();
}

export const emailTemplates = {
  passwordReset(params: { name: string; resetUrl: string }): { subject: string; html: string } {
    return {
      subject: "Reset your password",
      html: baseLayout(`
        <h2 style="color: #111827; margin: 0 0 16px;">Reset your password</h2>
        <p style="color: #374151;">Hi ${params.name},</p>
        <p style="color: #374151;">We received a request to reset your password. Click the button below to choose a new one:</p>
        <a href="${params.resetUrl}" style="display: inline-block; background: #2D6654; color: #ffffff; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: 600; margin: 16px 0;">Reset Password</a>
        <p style="color: #6b7280; font-size: 14px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email.</p>
      `),
    };
  },

  orderConfirmation(params: {
    name: string;
    orderNumber: string;
    totalAmount: number;
    currency: string;
    itemCount: number;
  }): { subject: string; html: string } {
    return {
      subject: `Order confirmed: ${params.orderNumber}`,
      html: baseLayout(`
        <h2 style="color: #111827; margin: 0 0 16px;">Order Confirmed! 🎉</h2>
        <p style="color: #374151;">Hi ${params.name},</p>
        <p style="color: #374151;">Your order <strong>${params.orderNumber}</strong> has been confirmed.</p>
        <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="margin: 0; color: #374151;"><strong>Items:</strong> ${params.itemCount}</p>
          <p style="margin: 8px 0 0; color: #374151;"><strong>Total:</strong> ${formatAmount(params.totalAmount, params.currency)}</p>
        </div>
        <p style="color: #6b7280; font-size: 14px;">We'll notify you when your order ships.</p>
      `),
    };
  },

  orderShipped(params: {
    name: string;
    orderNumber: string;
    trackingNumber?: string;
    carrier?: string;
  }): { subject: string; html: string } {
    const trackingInfo = params.trackingNumber
      ? `<p style="color: #374151;"><strong>Tracking:</strong> ${params.trackingNumber}${params.carrier ? ` (${params.carrier})` : ""}</p>`
      : "";
    return {
      subject: `Your order ${params.orderNumber} has shipped`,
      html: baseLayout(`
        <h2 style="color: #111827; margin: 0 0 16px;">Your order is on its way! 📦</h2>
        <p style="color: #374151;">Hi ${params.name},</p>
        <p style="color: #374151;">Great news — your order <strong>${params.orderNumber}</strong> has been dispatched.</p>
        ${trackingInfo}
        <p style="color: #6b7280; font-size: 14px;">You'll receive another email when it's delivered.</p>
      `),
    };
  },

  vendorNewOrder(params: {
    storeName: string;
    orderNumber: string;
    totalAmount: number;
    currency: string;
    buyerName: string;
  }): { subject: string; html: string } {
    return {
      subject: `New order: ${params.orderNumber}`,
      html: baseLayout(`
        <h2 style="color: #111827; margin: 0 0 16px;">New Order Received! 🛒</h2>
        <p style="color: #374151;">Hi ${params.storeName},</p>
        <p style="color: #374151;">You have a new order from <strong>${params.buyerName}</strong>.</p>
        <div style="background: #f3f4f6; border-radius: 8px; padding: 16px; margin: 16px 0;">
          <p style="margin: 0; color: #374151;"><strong>Order:</strong> ${params.orderNumber}</p>
          <p style="margin: 8px 0 0; color: #374151;"><strong>Amount:</strong> ${formatAmount(params.totalAmount, params.currency)}</p>
        </div>
        <p style="color: #6b7280; font-size: 14px;">Please confirm and process this order promptly.</p>
      `),
    };
  },

  payoutApproved(params: {
    name: string;
    amount: number;
    currency: string;
  }): { subject: string; html: string } {
    return {
      subject: "Your payout has been approved",
      html: baseLayout(`
        <h2 style="color: #111827; margin: 0 0 16px;">Payout Approved ✅</h2>
        <p style="color: #374151;">Hi ${params.name},</p>
        <p style="color: #374151;">Your payout of <strong>${formatAmount(params.amount, params.currency)}</strong> has been approved and will be processed shortly.</p>
      `),
    };
  },

  lowStockAlert(params: {
    storeName: string;
    products: { title: string; stock: number }[];
  }): { subject: string; html: string } {
    const productList = params.products
      .map((p) => `<li style="color: #374151;">${p.title} — <strong>${p.stock} left</strong></li>`)
      .join("");
    return {
      subject: `Low stock alert: ${params.products.length} product(s)`,
      html: baseLayout(`
        <h2 style="color: #111827; margin: 0 0 16px;">Low Stock Alert ⚠️</h2>
        <p style="color: #374151;">Hi ${params.storeName},</p>
        <p style="color: #374151;">The following products are running low:</p>
        <ul style="padding-left: 20px;">${productList}</ul>
        <p style="color: #6b7280; font-size: 14px;">Consider restocking to avoid missed sales.</p>
      `),
    };
  },

  welcomeBuyer(params: { name: string }): { subject: string; html: string } {
    return {
      subject: "Welcome to Eki Marketplace!",
      html: baseLayout(`
        <h2 style="color: #111827; margin: 0 0 16px;">Welcome, ${params.name}! 🎉</h2>
        <p style="color: #374151;">Thanks for joining Eki Marketplace. You can now browse authentic African foodstuff from verified vendors and have it delivered to your door.</p>
        <p style="color: #374151;">Happy shopping!</p>
      `),
    };
  },

  welcomeVendor(params: { name: string }): { subject: string; html: string } {
    return {
      subject: "Welcome to Eki Seller",
      html: baseLayout(`
        <h2 style="color: #111827; margin: 0 0 16px;">Welcome, ${params.name}!</h2>
        <p style="color: #374151;">Thanks for joining Eki as a vendor. Your seller account is ready for store setup, product listings, delivery zones, verification, and public store sharing.</p>
        <p style="color: #374151;">Open the app to complete your store profile and start selling securely.</p>
      `),
    };
  },

  vendorVerified(params: { storeName: string }): { subject: string; html: string } {
    return {
      subject: "Your store has been verified!",
      html: baseLayout(`
        <h2 style="color: #111827; margin: 0 0 16px;">You're Verified! ✅</h2>
        <p style="color: #374151;">Hi ${params.storeName},</p>
        <p style="color: #374151;">Congratulations! Your store has been verified. You can now list products and start selling on Eki Marketplace.</p>
      `),
    };
  },

  otpVerification(params: { code: string }): { subject: string; html: string } {
    return {
      subject: "Your Eki verification code",
      html: baseLayout(`
        <h2 style="color: #111827; margin: 0 0 16px;">Verification Code</h2>
        <p style="color: #374151;">Use the code below to verify your email address:</p>
        <div style="background: #f3f4f6; border-radius: 8px; padding: 24px; margin: 16px 0; text-align: center;">
          <span style="font-size: 32px; font-weight: 700; letter-spacing: 6px; color: #111827;">${params.code}</span>
        </div>
        <p style="color: #6b7280; font-size: 14px;">This code expires in 10 minutes. If you didn't request this, you can safely ignore this email.</p>
      `),
    };
  },
};
