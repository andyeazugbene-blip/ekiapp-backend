const fs = require('fs');
let c = fs.readFileSync('src/modules/admin/admin-reset.controller.ts', 'utf8');

// Find the delete section boundary - between logger("All data deleted") and the user creation
const start = c.indexOf('logger.info("All data deleted");');
const end = c.indexOf('  // User -", start);
const end2 = c.indexOf('  const vu = await prisma.user.create({');
if (end2 < 0) {
  console.log('Could not find boundary');
  process.exit(1);
}

const disable = `  // Disable triggers to bypass FK constraints during delete
  const tables = ["WalletTransaction","Payment","OrderItem","Order","Checkout","DeliveryOtp","PaystackTransaction","Dispute","Shipment","Product","Vendor","PromoRedemption","PromoCode","PayoutRequest","PayoutMethod","VendorBankAccount","VerificationDocument","VendorSubscription","Wallet","Cart","CartItem","Conversation","Message","Notification","PushToken","Review","BuyerWallet","BuyerWalletTransaction","PurchasedGiftCard","UserReward","Referral","BuyerAddress","EmailOtp","User","GiftCard","DeliveryMethod","DeliveryZone","Reward","CommissionTier","SellerPlan","SubscriptionPlanConfig","AdminTwoFactor","AdminRoleAssignment","AdminRole","WebhookEvent","AuditLog","UploadAsset","SmsDelivery","PasswordResetToken","EmailVerificationToken"];
  for (const t of tables) {
    try { await prisma.$executeRawUnsafe(\`DELETE FROM "\${t}"\`); }
    catch (e) { /* table might not exist or no data */ }
  }`;

const before = c.substring(0, end2);
const after = c.substring(end2);
c = before + disable + '\n\n' + after;

fs.writeFileSync('src/modules/admin/admin-reset.controller.ts', c, 'utf8');
console.log('Done');
