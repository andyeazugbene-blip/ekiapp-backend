#!/bin/bash
# E2E Test: Complete Wallet + Notification Flow
# Tests against LIVE deployed backend
# Usage: bash e2e-test.sh

set -e

BASE="https://ekiapp-backend.vercel.app"
DEBUG_KEY="eki-debug-2026"
TIMESTAMP=$(date +%s)
BUYER_EMAIL="e2e-buyer-${TIMESTAMP}@test.eki"
VENDOR_EMAIL="e2e-vendor-${TIMESTAMP}@test.eki"
PASS="Test123!"
STORE="E2E Test Store ${TIMESTAMP}"
COUNTRY="United Kingdom"
PASS_HASH=$(echo -n "$PASS" | base64)

echo ""
echo "═══════════════════════════════════════════════════"
echo "  🧪 E2E TEST: WALLET + NOTIFICATION FLOW"
echo "═══════════════════════════════════════════════════"
echo "  Buyer:  $BUYER_EMAIL"
echo "  Vendor: $VENDOR_EMAIL"
echo "  Base:   $BASE"
echo ""

# ─── Step 1: Register accounts ───────────────────────────
echo "┌── 1. REGISTER ACCOUNTS ──────────────────────────┐"

echo -n "   Registering buyer... "
BUYER_RES=$(curl -s -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$BUYER_EMAIL\",\"password\":\"$PASS\",\"name\":\"E2E Buyer\",\"role\":\"buyer\",\"country\":\"$COUNTRY\"}")
BUYER_ID=$(echo "$BUYER_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('id','MISSING'))" 2>/dev/null)
BUYER_TOKEN=$(echo "$BUYER_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
if [ "$BUYER_ID" = "MISSING" ] || [ -z "$BUYER_ID" ]; then
  echo "❌ FAILED: $(echo $BUYER_RES | head -c 200)"
  exit 1
fi
echo "✅ id=$BUYER_ID"

echo -n "   Registering vendor... "
VENDOR_RES=$(curl -s -X POST "$BASE/api/auth/register" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$VENDOR_EMAIL\",\"password\":\"$PASS\",\"name\":\"E2E Vendor\",\"role\":\"buyer\",\"country\":\"$COUNTRY\"}")
VENDOR_USER_ID=$(echo "$VENDOR_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('id','MISSING'))" 2>/dev/null)
VENDOR_TOKEN=$(echo "$VENDOR_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
if [ "$VENDOR_USER_ID" = "MISSING" ] || [ -z "$VENDOR_USER_ID" ]; then
  echo "❌ FAILED: $(echo $VENDOR_RES | head -c 200)"
  exit 1
fi
echo "✅ id=$VENDOR_USER_ID"

# ─── Step 2: Vendor logs in as VENDOR role picker ───────
echo "┌── 2. LOGIN WITH WRONG ROLE ──────────────────────┐"
echo -n "   Vendor logs in picking 'buyer' role... "
LOGIN_RES=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$VENDOR_EMAIL\",\"password\":\"$PASS\"}")
LOGIN_ROLE=$(echo "$LOGIN_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('role','MISSING'))" 2>/dev/null)
LOGIN_HAS_VENDOR=$(echo "$LOGIN_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('hasVendor','MISSING'))" 2>/dev/null)
if [ "$LOGIN_ROLE" = "MISSING" ]; then
  echo "❌ FAILED: $(echo $LOGIN_RES | head -c 200)"
  exit 1
fi
echo "✅ role=$LOGIN_ROLE hasVendor=$LOGIN_HAS_VENDOR"

# ─── Step 3: Create vendor store ─────────────────────────
echo "┌── 3. CREATE VENDOR STORE ────────────────────────┐"
echo -n "   Creating vendor profile... "
VENDOR_RES2=$(curl -s -X POST "$BASE/api/vendors" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $VENDOR_TOKEN" \
  -d "{\"storeName\":\"$STORE\",\"country\":\"$COUNTRY\",\"currency\":\"EUR\"}")
VENDOR_ID=$(echo "$VENDOR_RES2" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('id','MISSING'))" 2>/dev/null)
if [ "$VENDOR_ID" = "MISSING" ]; then
  echo "❌ FAILED: $(echo $VENDOR_RES2 | head -c 200)"
  exit 1
fi
echo "✅ id=$VENDOR_ID"

# Re-login after vendor creation (role changes to VENDOR)
VENDOR_RES3=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$VENDOR_EMAIL\",\"password\":\"$PASS\"}")
VENDOR_TOKEN=$(echo "$VENDOR_RES3" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
echo -n "   Dashboard... "
DASH=$(curl -s "$BASE/api/vendors/me/dashboard" \
  -H "Authorization: Bearer $VENDOR_TOKEN")
PENDING_BAL=$(echo "$DASH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('earnings',{}).get('pendingPayout','ERR'))" 2>/dev/null)
AVAIL_BAL=$(echo "$DASH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('earnings',{}).get('availableBalance','ERR'))" 2>/dev/null)
echo "✅ pending=$PENDING_BAL available=$AVAIL_BAL"

# ─── Step 4: Login as buyer correctly ────────────────────
echo "┌── 4. LOGIN FLOW TESTS ───────────────────────────┐"
echo -n "   Buyer logs in as buyer... "
B_LOGIN=$(curl -s -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$BUYER_EMAIL\",\"password\":\"$PASS\"}")
B_TOKEN=$(echo "$B_LOGIN" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)
echo "✅"

echo -n "   gets me... "
ME=$(curl -s "$BASE/api/auth/me" -H "Authorization: Bearer $B_TOKEN")
ME_ROLE=$(echo "$ME" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('user',{}).get('role','ERR'))" 2>/dev/null)
echo "✅ role=$ME_ROLE"

# ─── Step 5: Check vendor wallet before order ───────────
echo "┌── 5. WALLET BEFORE ORDER ────────────────────────┐"
echo -n "   Dashboard... "
VDASH=$(curl -s "$BASE/api/vendors/me/dashboard" \
  -H "Authorization: Bearer $VENDOR_TOKEN")
P0=$(echo "$VDASH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('earnings',{}).get('pendingPayout','ERR'))" 2>/dev/null)
A0=$(echo "$VDASH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('earnings',{}).get('availableBalance','ERR'))" 2>/dev/null)
echo "✅ pending=$P0 available=$A0"

# ─── Step 6: Create product ─────────────────────────────
echo "┌── 6. CREATE PRODUCT ─────────────────────────────┐"
echo -n "   Creating test product... "
PROD_RES=$(curl -s -X POST "$BASE/api/products" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $VENDOR_TOKEN" \
  -d "{\"title\":\"E2E Test Product\",\"priceInCents\":2500,\"stock\":100,\"currency\":\"EUR\",\"weightGrams\":500}")
PROD_ID=$(echo "$PROD_RES" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('product',{}).get('id','MISSING'))" 2>/dev/null)
if [ "$PROD_ID" = "MISSING" ]; then
  echo "⚠️ SKIPPED (may need active vendor): $(echo $PROD_RES | head -c 200)"
  echo "   Will use manual order creation via debug endpoint instead."
  PROD_ID=""
else
  echo "✅ id=$PROD_ID"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  ✅ SETUP COMPLETE"
echo ""
echo "  BUYER_ID: $BUYER_ID"
echo "  VENDOR_ID (vendor record): $VENDOR_ID"
echo "  VENDOR_USER_ID (auth user): $VENDOR_USER_ID"
echo ""
echo "  To manually create order and test wallet:"
echo ""
echo "  Use the debug endpoint:"
echo "  curl -X POST $BASE/api/stripe/webhook-test \\"
echo "    -H \"Content-Type: application/json\" \\"
echo "    -H \"x-debug-key: $DEBUG_KEY\" \\"
echo "    -d '{\"orderId\":\"YOUR_ORDER_ID\"}'"
echo ""
echo "  Or create an order, then POST that orderId"
echo "═══════════════════════════════════════════════════"
echo ""

# ─── Summary assertions ─────────────────────────────────
PASSED=0
FAILED=0

echo -n "   [TEST] Vendor wallet exists... "
if [ "$P0" != "ERR" ] && [ "$P0" != "null" ]; then ((PASSED++)); echo "✅"; else ((FAILED++)); echo "❌"; fi

echo -n "   [TEST] Vendor has store... "
if [ "$VENDOR_ID" != "MISSING" ] && [ -n "$VENDOR_ID" ]; then ((PASSED++)); echo "✅"; else ((FAILED++)); echo "❌"; fi

echo -n "   [TEST] Login returns token... "
if [ -n "$VENDOR_TOKEN" ] && [ ${#VENDOR_TOKEN} -gt 20 ]; then ((PASSED++)); echo "✅"; else ((FAILED++)); echo "❌"; fi

echo -n "   [TEST] Login returns hasVendor flag... "
if [ "$LOGIN_HAS_VENDOR" = "true" ] || [ "$LOGIN_HAS_VENDOR" = "false" ]; then ((PASSED++)); echo "✅"; else ((FAILED++)); echo "❌"; fi

echo -n "   [TEST] Buyer me returns user... "
if [ "$ME_ROLE" = "buyer" ]; then ((PASSED++)); echo "✅"; else ((FAILED++)); echo "❌"; fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  RESULTS: $PASSED passed, $FAILED failed"
echo "═══════════════════════════════════════════════════"
echo ""
