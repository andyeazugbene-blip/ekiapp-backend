# Frontend Testing Guide - QA Seed Data

## 🎯 Quick Start

Your QA data is ready! Use these credentials to test the frontend/mobile app.

## 🔑 Test Credentials

### Admin
- **Email:** `seed_qa_admin@example.com`
- **Password:** `SeedQA123!`
- **Use for:** Admin dashboard, disputes, refunds, vendor management

### Buyer (Primary Test Account)
- **Email:** `seed_qa_buyer001@example.com`
- **Password:** `SeedQA123!`
- **Country:** United Kingdom (GBP)
- **Wallet Balance:** Empty
- **Use for:** Shopping, cart, checkout, orders, reviews

### Buyer (With Wallet Balance)
- **Email:** `seed_qa_buyer002@example.com`
- **Password:** `SeedQA123!`
- **Country:** Nigeria (NGN)
- **Wallet Balance:** 50 NGN
- **Use for:** Wallet checkout, partial payment

### Buyer (Large Wallet Balance)
- **Email:** `seed_qa_buyer003@example.com`
- **Password:** `SeedQA123!`
- **Country:** Ghana (GHS)
- **Wallet Balance:** 500 GHS
- **Use for:** Full wallet checkout

### Vendor (Primary Test Account)
- **Email:** `seed_qa_vendor001@example.com`
- **Password:** `SeedQA123!`
- **Store:** SEED_QA_Store 001
- **Currency:** GBP
- **Products:** 4 products
- **Use for:** Vendor dashboard, orders, wallet, buyers

### Vendor (Nigerian - Escrow)
- **Email:** `seed_qa_vendor002@example.com`
- **Password:** `SeedQA123!`
- **Store:** SEED_QA_Store 002
- **Currency:** NGN
- **Products:** 4 products
- **Use for:** Escrow flows, Paystack testing

### Vendor (Ghanaian)
- **Email:** `seed_qa_vendor003@example.com`
- **Password:** `SeedQA123!`
- **Store:** SEED_QA_Store 003
- **Currency:** GHS
- **Products:** 4 products

## 🛒 Test Scenarios

### Scenario 1: Browse and Add to Cart
**Account:** `seed_qa_buyer001@example.com`

1. Login to the app
2. Browse products - you should see products starting with "SEED_QA_"
3. Filter by category (food, spices, oils, etc.)
4. View product detail
5. Add "SEED_QA_Extra Virgin Olive Oil" to cart
6. View cart
7. Update quantity
8. Continue shopping

**Expected:**
- ✅ Products display correctly
- ✅ Images load (or show placeholder)
- ✅ Prices show in correct currency (GBP for UK products)
- ✅ Cart updates correctly

### Scenario 2: Apply Coupon
**Account:** `seed_qa_buyer001@example.com`

1. Add products to cart
2. Go to cart
3. Apply coupon: `SEED_QA_10OFF`
4. Verify 10% discount applied
5. Try expired coupon: `SEED_QA_EXPIRED`
6. Verify error message

**Expected:**
- ✅ Valid coupon applies discount
- ✅ Expired coupon shows error
- ✅ Discount calculation correct

### Scenario 3: Checkout (Card Payment)
**Account:** `seed_qa_buyer001@example.com`

1. Add products to cart
2. Proceed to checkout
3. Select delivery address
4. Choose payment method: Card
5. Complete payment (use Stripe test card if in test mode)
6. View order confirmation

**Expected:**
- ✅ Checkout flow smooth
- ✅ Payment processes
- ✅ Order created with PAID status

### Scenario 4: View Orders
**Account:** `seed_qa_buyer001@example.com`

1. Go to Orders screen
2. View list of orders (should see seeded orders)
3. Tap on a DELIVERED order
4. View order details
5. Check order status, items, total

**Expected:**
- ✅ Orders display with correct statuses
- ✅ Order details accurate
- ✅ Can see PENDING, PAID, DELIVERED orders

### Scenario 5: Leave Review
**Account:** `seed_qa_buyer001@example.com`

1. Go to Orders
2. Find a DELIVERED order
3. Tap "Leave Review"
4. Rate 5 stars
5. Write comment: "Great product!"
6. Submit review

**Expected:**
- ✅ Review form appears for delivered orders only
- ✅ Review submits successfully
- ✅ Review appears on product page

### Scenario 6: Out of Stock Product
**Account:** `seed_qa_buyer001@example.com`

1. Browse products
2. Find "SEED_QA_Fresh Yam Flour" (stock=0)
3. Try to add to cart
4. Verify error message

**Expected:**
- ✅ Out of stock products show "Out of Stock"
- ✅ Cannot add to cart
- ✅ Clear error message

### Scenario 7: Low Stock Warning
**Account:** `seed_qa_buyer001@example.com`

1. Browse products
2. Find "SEED_QA_Extra Virgin Olive Oil" (stock=1)
3. Add to cart
4. Try to add quantity > 1
5. Verify warning

**Expected:**
- ✅ Low stock warning displayed
- ✅ Cannot exceed available stock
- ✅ Clear messaging

### Scenario 8: Vendor Dashboard
**Account:** `seed_qa_vendor001@example.com`

1. Login as vendor
2. View dashboard
3. Check:
   - Total orders
   - Pending orders
   - Revenue
   - Wallet balance

**Expected:**
- ✅ Dashboard shows correct stats
- ✅ Orders count matches seeded data
- ✅ Wallet balance correct

### Scenario 9: Vendor Orders
**Account:** `seed_qa_vendor001@example.com`

1. Go to Orders screen
2. View list of orders
3. Filter by status (PENDING, PAID, etc.)
4. Tap on a PAID order
5. Accept order
6. Mark as shipped

**Expected:**
- ✅ Orders display correctly
- ✅ Can filter by status
- ✅ Can accept and ship orders
- ✅ Status updates correctly

### Scenario 10: Vendor Wallet
**Account:** `seed_qa_vendor001@example.com`

1. Go to Wallet/Earnings screen
2. View pending balance
3. View available balance
4. View transaction history

**Expected:**
- ✅ Balances display correctly
- ✅ Pending balance shows held funds
- ✅ Available balance shows releasable funds
- ✅ Transaction history accurate

### Scenario 11: Vendor Buyers
**Account:** `seed_qa_vendor001@example.com`

1. Go to Buyers screen
2. View list of buyers who purchased
3. View buyer details
4. Check order history per buyer

**Expected:**
- ✅ Buyers list displays
- ✅ Shows buyers who made purchases
- ✅ Order history per buyer accurate

### Scenario 12: Admin Dashboard
**Account:** `seed_qa_admin@example.com`

1. Login as admin
2. View dashboard
3. Check:
   - Total orders
   - Total revenue
   - Active vendors
   - Disputes

**Expected:**
- ✅ Dashboard shows all marketplace stats
- ✅ Numbers accurate
- ✅ Charts/graphs display

### Scenario 13: Admin Disputes
**Account:** `seed_qa_admin@example.com`

1. Go to Disputes screen
2. View list of disputes (should see 1 disputed order from escrow seed)
3. Tap on dispute
4. View details
5. Resolve dispute (refund or vendor favor)

**Expected:**
- ✅ Disputes list displays
- ✅ Can view dispute details
- ✅ Can resolve disputes
- ✅ Resolution updates order status

### Scenario 14: Admin Refunds
**Account:** `seed_qa_admin@example.com`

1. Go to Orders screen
2. Find a PAID order
3. Tap on order
4. Issue refund
5. Enter amount and reason
6. Confirm refund

**Expected:**
- ✅ Refund form appears
- ✅ Can enter amount and reason
- ✅ Refund processes
- ✅ Order status updates to REFUNDED

### Scenario 15: Escrow Flow (Nigerian Vendor)
**Account:** `seed_qa_escrow_buyer@example.com` / `SeedQA123!`

1. Login as escrow buyer
2. View orders (should see 9 escrow scenario orders)
3. Check different statuses:
   - PENDING (no payment)
   - PAID (funds held)
   - VENDOR_CONFIRMED (vendor accepted)
   - DISPATCHED (shipped)
   - DELIVERED (delivered)
   - DISPUTED (dispute open)
   - REFUNDED (refunded)
   - COMPLETED (funds released)

**Expected:**
- ✅ All escrow statuses display correctly
- ✅ Escrow indicator shows for NGN orders
- ✅ Can confirm delivery
- ✅ Can open dispute

## 🎫 Test Coupons

| Code | Type | Value | Status | Use Case |
|------|------|-------|--------|----------|
| `SEED_QA_10OFF` | Percentage | 10% | Active | Valid coupon test |
| `SEED_QA_FIXED5` | Fixed | 5 units | Active | Fixed discount test |
| `SEED_QA_EXPIRED` | Percentage | 20% | Expired | Expired coupon test |
| `SEED_QA_LIMIT1` | Percentage | 15% | Limited | Max uses test |

## 📦 Test Products

### Low Stock (stock=1)
- SEED_QA_Extra Virgin Olive Oil (GBP)
- SEED_QA_Nigerian Garri (NGN)
- SEED_QA_Jollof Rice Spice Mix (GHS)

### Out of Stock (stock=0)
- SEED_QA_Fresh Yam Flour (GBP)
- SEED_QA_Kenyan Tea Leaves (NGN)
- SEED_QA_Peri Peri Sauce (GHS)

### Expensive (500+ currency units)
- SEED_QA_Ghanaian Shito Sauce (GBP 500)
- SEED_QA_Italian Balsamic Vinegar (NGN 500)
- SEED_QA_Cassava Flour (GHS 500)

## 🔐 OTP Testing

If your app has OTP verification, use these codes from `OTP_SEED_REPORT.md`:

**Valid OTP:**
- Email: `seed_qa_otp001@example.com`
- Code: `748449`

**Expired OTP:**
- Email: `seed_qa_otp002@example.com`
- Code: `195926` (should fail)

**Delivery OTP:**
- Order: `cmps8fo42000fufxg8h9hxi30`
- Code: `142709`

## 📱 Screen-by-Screen Checklist

### Buyer Screens
- [ ] Login/Register
- [ ] Home/Product Catalog
- [ ] Product Detail
- [ ] Search/Filter
- [ ] Shopping Cart
- [ ] Apply Coupon
- [ ] Checkout
- [ ] Payment
- [ ] Order History
- [ ] Order Detail
- [ ] Leave Review
- [ ] Wallet/Balance
- [ ] Profile/Settings

### Vendor Screens
- [ ] Login
- [ ] Dashboard
- [ ] Products List
- [ ] Add/Edit Product
- [ ] Orders List
- [ ] Order Detail
- [ ] Accept Order
- [ ] Mark Shipped
- [ ] Buyers List
- [ ] Wallet/Earnings
- [ ] Transaction History
- [ ] Analytics/Revenue
- [ ] Profile/Settings

### Admin Screens
- [ ] Login
- [ ] Dashboard
- [ ] Orders Management
- [ ] Order Detail
- [ ] Issue Refund
- [ ] Disputes List
- [ ] Dispute Detail
- [ ] Resolve Dispute
- [ ] Vendors List
- [ ] Vendor Detail
- [ ] Approve/Suspend Vendor
- [ ] Products Moderation
- [ ] Analytics/Reports

## 🐛 Common Issues & Solutions

### Issue: No products showing
**Solution:** Check that products are active and match your currency filter

### Issue: Cannot add to cart
**Solution:** Check product stock > 0

### Issue: Coupon not applying
**Solution:** Check coupon code spelling (case-sensitive) and expiry

### Issue: Order not showing
**Solution:** Check you're logged in as correct buyer/vendor

### Issue: Cannot leave review
**Solution:** Order must be DELIVERED or COMPLETED status

### Issue: Wallet balance not showing
**Solution:** Check buyer002 or buyer003 for accounts with balance

## 🔄 Reset Test Data

If you need to reset and start fresh:

```powershell
# Windows PowerShell
npm run cleanup:qa -- --confirm
npm run seed:qa
npm run seed:escrow
npm run seed:otp
```

## 📊 Expected Data Counts

After seeding (small scale):
- **Buyers:** 5
- **Vendors:** 3
- **Products:** 12
- **Orders:** 10 (various statuses)
- **Reviews:** 3
- **Coupons:** 4
- **Escrow Orders:** 9 (if seeded)
- **OTP Scenarios:** 7 (if seeded)

## 🎯 Success Criteria

Your frontend is working correctly if:
- ✅ Can login with all test accounts
- ✅ Products display with correct data
- ✅ Cart operations work
- ✅ Coupons apply correctly
- ✅ Checkout completes
- ✅ Orders display with correct statuses
- ✅ Reviews can be submitted
- ✅ Vendor dashboard shows correct data
- ✅ Admin can manage orders and disputes
- ✅ Escrow flows work (for NGN orders)
- ✅ OTP verification works

## 📞 Support

If you encounter issues:
1. Check backend is running
2. Check API endpoint URLs
3. Check network requests in browser/app
4. Verify credentials are correct
5. Run validation: `npm run validate:qa`
6. Check backend logs

## 🚀 Next Steps

1. **Start testing** with buyer001 account
2. **Test each scenario** from the list above
3. **Document bugs** you find
4. **Test edge cases** (out of stock, expired coupons, etc.)
5. **Test all user roles** (buyer, vendor, admin)
6. **Test escrow flows** if applicable
7. **Test OTP flows** if applicable

---

**Happy Testing!** 🎉

All test data is prefixed with `SEED_QA_` for easy identification.
Use `npm run cleanup:qa -- --confirm` when done to clean up.
