import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = 'https://ekiapp-backend.vercel.app';

const myFailRate = new Rate('failed_requests');
const walletTrend = new Trend('wallet_response_time');
const loginTrend = new Trend('login_response_time');
const orderTrend = new Trend('order_list_response_time');
const checkoutTrend = new Trend('checkout_response_time');

export const options = {
  stages: [
    { duration: '30s', target: 5 },   // ramp up
    { duration: '1m', target: 10 },   // moderate load
    { duration: '30s', target: 20 },  // peak
    { duration: '30s', target: 0 },   // ramp down
  ],
  thresholds: {
    failed_requests: ['rate<0.05'],       // < 5% failures
    http_req_duration: ['p(95)<3000'],    // 95% under 3s
  },
};

const VENDOR_EMAIL = 'vendor@eki.app';
const VENDOR_PASS = 'Abdou22314';
const BUYER_EMAIL = 'buyer@eki.app';
const BUYER_PASS = 'Abdou22314';

export default function () {
  // ─── AUTH ──────────────────────────────────────────────
  group('Authentication', () => {
    let t0 = Date.now();
    let loginRes = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({
      email: VENDOR_EMAIL, password: VENDOR_PASS,
    }), { headers: { 'Content-Type': 'application/json' } });
    loginTrend.add(Date.now() - t0);

    check(loginRes, {
      'vendor login OK': (r) => r.status === 200,
      'has token': (r) => JSON.parse(r.body).token !== undefined,
      'hasVendor true': (r) => JSON.parse(r.body).user?.hasVendor === true,
    });
    myFailRate.add(loginRes.status !== 200);

    const vendorToken = loginRes.status === 200 ? JSON.parse(loginRes.body).token : '';
    sleep(1);

    // Buyer login
    let bRes = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({
      email: BUYER_EMAIL, password: BUYER_PASS,
    }), { headers: { 'Content-Type': 'application/json' } });
    check(bRes, { 'buyer login OK': (r) => r.status === 200 });
    const buyerToken = bRes.status === 200 ? JSON.parse(bRes.body).token : '';
    sleep(1);

    // ─── VENDOR DASHBOARD & WALLET ───────────────────────
    if (vendorToken) {
      group('Vendor Dashboard & Wallet', () => {
        let t0 = Date.now();
        let dashRes = http.get(`${BASE_URL}/api/vendors/me/dashboard`, {
          headers: { 'Authorization': `Bearer ${vendorToken}` },
        });
        walletTrend.add(Date.now() - t0);
        check(dashRes, {
          'dashboard OK': (r) => r.status === 200,
          'has earnings': (r) => JSON.parse(r.body).earnings !== undefined,
          'pendingPayout is number': (r) => typeof JSON.parse(r.body).earnings?.pendingPayout === 'number',
        });
        myFailRate.add(dashRes.status !== 200);
        sleep(1);

        // Earnings
        let earnRes = http.get(`${BASE_URL}/api/vendors/me/earnings`, {
          headers: { 'Authorization': `Bearer ${vendorToken}` },
        });
        check(earnRes, {
          'earnings OK': (r) => r.status === 200,
          'has data': (r) => JSON.parse(r.body).totalEarnings !== undefined,
        });
        sleep(1);

        // Payout methods
        http.get(`${BASE_URL}/api/vendors/me/payout-methods`, {
          headers: { 'Authorization': `Bearer ${vendorToken}` },
        });
        sleep(1);

        // Subscription
        http.get(`${BASE_URL}/api/subscriptions/me`, {
          headers: { 'Authorization': `Bearer ${vendorToken}` },
        });
        sleep(1);

        // Payout requests
        http.get(`${BASE_URL}/api/payout-requests/me`, {
          headers: { 'Authorization': `Bearer ${vendorToken}` },
        });
        sleep(1);
      });
    }

    // ─── VENDOR ORDERS ──────────────────────────────────
    if (vendorToken) {
      group('Vendor Orders', () => {
        let t0 = Date.now();
        let ordersRes = http.get(`${BASE_URL}/api/orders/vendor/list?limit=5`, {
          headers: { 'Authorization': `Bearer ${vendorToken}` },
        });
        orderTrend.add(Date.now() - t0);
        check(ordersRes, {
          'orders OK': (r) => r.status === 200,
          'has items': (r) => Array.isArray(JSON.parse(r.body).items),
        });
        myFailRate.add(ordersRes.status !== 200);
        sleep(1);
      });
    }

    // ─── NOTIFICATIONS ──────────────────────────────────
    if (vendorToken) {
      group('Notifications', () => {
        let notifRes = http.get(`${BASE_URL}/api/notifications`, {
          headers: { 'Authorization': `Bearer ${vendorToken}` },
        });
        check(notifRes, {
          'notifications OK': (r) => r.status === 200,
        });
        sleep(1);
      });
    }

    // ─── BUYER FLOW ─────────────────────────────────────
    if (buyerToken) {
      group('Buyer Flow', () => {
        // Buyer orders
        let ordersRes = http.get(`${BASE_URL}/api/orders/me?limit=5`, {
          headers: { 'Authorization': `Bearer ${buyerToken}` },
        });
        check(ordersRes, { 'buyer orders OK': (r) => r.status === 200 });
        sleep(1);

        // Wallet
        let walletRes = http.get(`${BASE_URL}/api/wallet/me`, {
          headers: { 'Authorization': `Bearer ${buyerToken}` },
        });
        check(walletRes, { 'buyer wallet OK': (r) => r.status === 200 });
        sleep(1);

        // Addresses
        http.get(`${BASE_URL}/api/addresses`, {
          headers: { 'Authorization': `Bearer ${buyerToken}` },
        });
        sleep(1);

        // Cart
        http.get(`${BASE_URL}/api/cart/me`, {
          headers: { 'Authorization': `Bearer ${buyerToken}` },
        });
        sleep(1);

        // Gift cards
        http.get(`${BASE_URL}/api/gift-cards/me`, {
          headers: { 'Authorization': `Bearer ${buyerToken}` },
        });
        sleep(1);

        // Reviews
        http.get(`${BASE_URL}/api/reviews/eligible-products`, {
          headers: { 'Authorization': `Bearer ${buyerToken}` },
        });
        sleep(1);
      });
    }

    // ─── PUBLIC ENDPOINTS ───────────────────────────────
    group('Public Endpoints', () => {
      // Health
      let healthRes = http.get(`${BASE_URL}/api/health`);
      check(healthRes, { 'health OK': (r) => r.status === 200 });
      sleep(1);

      // Health detailed
      let detailedRes = http.get(`${BASE_URL}/api/health/detailed`);
      check(detailedRes, {
        'health detailed OK': (r) => r.status === 200,
        'stripe OK': (r) => JSON.parse(r.body).checks?.stripe?.status === 'ok',
        'db OK': (r) => JSON.parse(r.body).checks?.database?.status === 'ok',
      });
      sleep(1);

      // Public stores
      let storeRes = http.get(`${BASE_URL}/api/public/stores/queen-african-foods`);
      check(storeRes, { 'store OK': (r) => r.status === 200 });
      sleep(1);

      // Subscription plans
      http.get(`${BASE_URL}/api/subscriptions/plans`);
      sleep(1);

      // Gift cards
      http.get(`${BASE_URL}/api/gift-cards/active`);
      sleep(1);
    });

    // ─── MESSAGES ───────────────────────────────────────
    if (vendorToken) {
      group('Messaging', () => {
        let msgRes = http.get(`${BASE_URL}/api/conversations/me`, {
          headers: { 'Authorization': `Bearer ${vendorToken}` },
        });
        check(msgRes, { 'conversations OK': (r) => r.status === 200 });
        sleep(1);
      });
    }
  });
}
