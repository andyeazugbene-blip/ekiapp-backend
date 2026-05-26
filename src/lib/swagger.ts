import swaggerJSDoc from "swagger-jsdoc";

// Centralized OpenAPI 3.0 specification. The spec is defined as a single
// document here (instead of per-route JSDoc blocks) to avoid modifying any
// existing route/controller files.
export const swaggerSpec = swaggerJSDoc({
  apis: [],
  definition: {
    openapi: "3.0.3",
    info: {
      title: "Italian Marketplace API",
      version: "1.0.0",
      description:
        "Multi-vendor marketplace backend: auth, vendors, products, cart, delivery, payments, payouts, admin, notifications.",
    },
    servers: [
      { url: "/api", description: "Current host" },
    ],
    tags: [
      { name: "auth" },
      { name: "vendors" },
      { name: "products" },
      { name: "cart" },
      { name: "delivery" },
      { name: "payments" },
      { name: "wallet" },
      { name: "orders" },
      { name: "reviews" },
      { name: "promos" },
      { name: "referrals" },
      { name: "payouts" },
      { name: "admin" },
      { name: "notifications" },
      { name: "stripe" },
      { name: "health" },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            message: { type: "string", example: "Invalid request body" },
            details: { nullable: true, example: null },
          },
        },
        AuthUser: {
          type: "object",
          properties: {
            id: { type: "string" },
            email: { type: "string", format: "email" },
            name: { type: "string" },
            role: { type: "string", enum: ["BUYER", "VENDOR", "ADMIN"] },
          },
        },
        AuthResponse: {
          type: "object",
          properties: {
            user: { $ref: "#/components/schemas/AuthUser" },
            token: { type: "string", example: "eyJhbGciOiJIUzI1NiIs..." },
          },
        },
        Vendor: {
          type: "object",
          properties: {
            id: { type: "string" },
            userId: { type: "string" },
            storeName: { type: "string" },
            description: { type: "string", nullable: true },
            contactEmail: { type: "string", nullable: true },
            contactPhone: { type: "string", nullable: true },
            country: { type: "string", nullable: true },
            verificationStatus: {
              type: "string",
              enum: ["PENDING", "VERIFIED", "REJECTED"],
            },
          },
        },
        PayoutMethod: {
          type: "object",
          properties: {
            id: { type: "string" },
            vendorId: { type: "string" },
            type: {
              type: "string",
              enum: ["BANK_TRANSFER", "MOBILE_MONEY", "WISE", "PAYONEER", "OTHER"],
            },
            label: { type: "string", nullable: true },
            details: { type: "object", additionalProperties: true },
            isDefault: { type: "boolean" },
          },
        },
        Product: {
          type: "object",
          properties: {
            id: { type: "string" },
            vendorId: { type: "string" },
            title: { type: "string" },
            description: { type: "string", nullable: true },
            priceInCents: { type: "integer", example: 4999 },
            currency: { type: "string", example: "usd" },
            images: { type: "array", items: { type: "string" } },
            category: { type: "string", nullable: true },
            stock: { type: "integer", example: 10 },
            weightGrams: { type: "integer", nullable: true, example: 500 },
            isActive: { type: "boolean" },
          },
        },
        Cart: {
          type: "object",
          properties: {
            id: { type: "string" },
            buyerId: { type: "string" },
            vendorId: { type: "string", nullable: true },
            items: {
              type: "array",
              items: { $ref: "#/components/schemas/CartItem" },
            },
          },
        },
        CartItem: {
          type: "object",
          properties: {
            id: { type: "string" },
            cartId: { type: "string" },
            productId: { type: "string" },
            quantity: { type: "integer", example: 2 },
            product: { $ref: "#/components/schemas/Product" },
          },
        },
        DeliveryQuote: {
          type: "object",
          properties: {
            subtotalAmount: { type: "integer", example: 9998 },
            deliveryAmount: { type: "integer", example: 1500 },
            totalAmount: { type: "integer", example: 11498 },
            totalWeightGrams: { type: "integer", example: 1000 },
            currency: { type: "string", example: "usd" },
          },
        },
        CreatePaymentIntentResponse: {
          type: "object",
          description:
            "Returned by POST /api/payments/create-intent. Mobile Stripe PaymentSheet uses paymentIntentId + clientSecret. Wallet-only checkouts return clientSecret = \"wallet_paid\" and an empty paymentIntentId.",
          properties: {
            paymentIntentId: { type: "string", example: "pi_3...", description: "Stripe PaymentIntent id; empty string when fully wallet-paid" },
            clientSecret: { type: "string", example: "pi_3..._secret_..." },
            checkoutId: { type: "string" },
            orderIds: { type: "array", items: { type: "string" } },
            amount: { type: "integer", example: 11498 },
            currency: { type: "string", example: "usd" },
          },
        },
        PayoutRequest: {
          type: "object",
          properties: {
            id: { type: "string" },
            vendorId: { type: "string" },
            payoutMethodId: { type: "string" },
            amount: { type: "integer", example: 5000 },
            currency: { type: "string", example: "usd" },
            status: {
              type: "string",
              enum: ["PENDING", "APPROVED", "REJECTED", "PAID"],
            },
            notes: { type: "string", nullable: true },
            rejectionReason: { type: "string", nullable: true },
          },
        },
        Notification: {
          type: "object",
          properties: {
            id: { type: "string" },
            userId: { type: "string" },
            type: {
              type: "string",
              enum: [
                "ORDER_PAID",
                "BALANCE_CREDITED",
                "PAYOUT_REQUESTED",
                "PAYOUT_APPROVED",
                "PAYOUT_REJECTED",
                "PAYOUT_PAID",
              ],
            },
            title: { type: "string" },
            body: { type: "string", nullable: true },
            data: { type: "object", nullable: true, additionalProperties: true },
            readAt: { type: "string", format: "date-time", nullable: true },
            createdAt: { type: "string", format: "date-time" },
          },
        },
        Paginated: {
          type: "object",
          properties: {
            items: { type: "array", items: {} },
            nextCursor: { type: "string", nullable: true },
          },
        },
      },
      responses: {
        BadRequest: {
          description: "Invalid input",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        Unauthorized: {
          description: "Missing or invalid token",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        Forbidden: {
          description: "Authenticated but not allowed",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        NotFound: {
          description: "Resource not found",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
        Conflict: {
          description: "Conflicting state",
          content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
        },
      },
    },
    paths: {
      "/health": {
        get: {
          tags: ["health"],
          summary: "Health check",
          security: [],
          responses: {
            200: {
              description: "Service is up",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { status: { type: "string", example: "ok" } } },
                },
              },
            },
          },
        },
      },

      "/auth/register": {
        post: {
          tags: ["auth"],
          summary: "Register a new BUYER",
          description: "Always creates a BUYER. Vendor promotion happens via POST /vendors.",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password", "name"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string", minLength: 8 },
                    name: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: "Created",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } },
            },
            400: { $ref: "#/components/responses/BadRequest" },
            409: { $ref: "#/components/responses/Conflict" },
          },
        },
      },
      "/auth/login": {
        post: {
          tags: ["auth"],
          summary: "Log in",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email", "password"],
                  properties: {
                    email: { type: "string", format: "email" },
                    password: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AuthResponse" } } },
            },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/auth/me": {
        get: {
          tags: ["auth"],
          summary: "Current user",
          responses: {
            200: {
              description: "OK",
              content: { "application/json": { schema: { $ref: "#/components/schemas/AuthUser" } } },
            },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },

      "/vendors": {
        post: {
          tags: ["vendors"],
          summary: "Create own vendor profile (auto-creates wallet, promotes BUYER → VENDOR)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["storeName"],
                  properties: {
                    storeName: { type: "string" },
                    description: { type: "string" },
                    contactEmail: { type: "string", format: "email" },
                    contactPhone: { type: "string" },
                    country: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Vendor" } } } },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            409: { $ref: "#/components/responses/Conflict" },
          },
        },
      },
      "/vendors/me": {
        get: {
          tags: ["vendors"],
          summary: "Get own vendor profile (with wallet)",
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Vendor" } } } },
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
        patch: {
          tags: ["vendors"],
          summary: "Update own vendor profile",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    storeName: { type: "string" },
                    description: { type: "string", nullable: true },
                    contactEmail: { type: "string", nullable: true, format: "email" },
                    contactPhone: { type: "string", nullable: true },
                    country: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Vendor" } } } },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/vendors/me/payout-methods": {
        get: {
          tags: ["vendors"],
          summary: "List own payout methods",
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/PayoutMethod" } },
                },
              },
            },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
        post: {
          tags: ["vendors"],
          summary: "Create a payout method",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["type", "details"],
                  properties: {
                    type: {
                      type: "string",
                      enum: ["BANK_TRANSFER", "MOBILE_MONEY", "WISE", "PAYONEER", "OTHER"],
                    },
                    label: { type: "string" },
                    details: { type: "object", additionalProperties: true },
                    isDefault: { type: "boolean" },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/PayoutMethod" } } } },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },

      "/products": {
        get: {
          tags: ["products"],
          summary: "List active products",
          security: [],
          parameters: [
            { name: "category", in: "query", schema: { type: "string" } },
            { name: "vendorId", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: {
              description: "Paginated list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: { type: "array", items: { $ref: "#/components/schemas/Product" } },
                      nextCursor: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ["products"],
          summary: "Create a product (VENDOR only)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["title", "priceAmount"],
                  properties: {
                    title: { type: "string" },
                    description: { type: "string" },
                    priceAmount: { type: "integer", minimum: 1, example: 4999 },
                    currency: { type: "string", example: "usd" },
                    images: { type: "array", items: { type: "string" } },
                    category: { type: "string" },
                    stock: { type: "integer", minimum: 0 },
                    weightGrams: { type: "integer", minimum: 0 },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/products/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: {
          tags: ["products"],
          summary: "Get product by id (404 if missing or inactive)",
          security: [],
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
        patch: {
          tags: ["products"],
          summary: "Update own product (VENDOR; isActive cannot be modified here)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    description: { type: "string", nullable: true },
                    priceAmount: { type: "integer", minimum: 1 },
                    currency: { type: "string" },
                    images: { type: "array", items: { type: "string" } },
                    category: { type: "string", nullable: true },
                    stock: { type: "integer", minimum: 0 },
                    weightGrams: { type: "integer", nullable: true, minimum: 0 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
        delete: {
          tags: ["products"],
          summary: "Soft-disable own product (VENDOR)",
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Product" } } } },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },

      "/cart": {
        get: {
          tags: ["cart"],
          summary: "Get current user's cart (auto-creates if missing)",
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Cart" } } } },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
        delete: {
          tags: ["cart"],
          summary: "Clear cart",
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Cart" } } } },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/cart/items": {
        post: {
          tags: ["cart"],
          summary: "Add an item to the cart (single-vendor enforced, stock validated)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["productId", "quantity"],
                  properties: {
                    productId: { type: "string" },
                    quantity: { type: "integer", minimum: 1, example: 1 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Cart" } } } },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/cart/items/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["cart"],
          summary: "Update an item's quantity",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["quantity"],
                  properties: { quantity: { type: "integer", minimum: 1 } },
                },
              },
            },
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Cart" } } } },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
        delete: {
          tags: ["cart"],
          summary: "Remove an item from the cart",
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Cart" } } } },
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },

      "/delivery/calculate": {
        post: {
          tags: ["delivery"],
          summary: "Quote delivery fee for a cart and destination zone",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["cartId", "destinationZoneId"],
                  properties: {
                    cartId: { type: "string" },
                    destinationZoneId: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/DeliveryQuote" } } } },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },

      "/payments/create-intent": {
        post: {
          tags: ["payments"],
          summary: "Create order + Stripe PaymentIntent from cart",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["cartId", "destinationZoneId"],
                  properties: {
                    cartId: { type: "string" },
                    destinationZoneId: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            201: {
              description: "Created",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CreatePaymentIntentResponse" },
                },
              },
            },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
            502: { description: "Stripe failure", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          },
        },
      },

      "/stripe/webhook": {
        post: {
          tags: ["stripe"],
          summary: "Stripe webhook (signature-verified, raw body)",
          description:
            "Public endpoint. Verifies the `Stripe-Signature` header against `STRIPE_WEBHOOK_SECRET`. Handles `payment_intent.succeeded`. Idempotent.",
          security: [],
          requestBody: {
            required: true,
            content: { "application/json": { schema: { type: "string", format: "binary" } } },
          },
          parameters: [
            { name: "Stripe-Signature", in: "header", required: true, schema: { type: "string" } },
          ],
          responses: {
            200: { description: "Acknowledged" },
            400: { description: "Invalid signature or payload" },
          },
        },
      },

      "/payout-requests": {
        post: {
          tags: ["payouts"],
          summary: "Create a payout request (VENDOR; amount ≤ availableBalance)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["payoutMethodId", "amount"],
                  properties: {
                    payoutMethodId: { type: "string" },
                    amount: { type: "integer", minimum: 1 },
                    notes: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: "Created", content: { "application/json": { schema: { $ref: "#/components/schemas/PayoutRequest" } } } },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/payout-requests/me": {
        get: {
          tags: ["payouts"],
          summary: "List own payout requests (VENDOR)",
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: { type: "array", items: { $ref: "#/components/schemas/PayoutRequest" } },
                },
              },
            },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
          },
        },
      },

      "/notifications": {
        get: {
          tags: ["notifications"],
          summary: "List current user's notifications (newest first, cursor-paginated)",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
            { name: "unreadOnly", in: "query", schema: { type: "boolean" } },
          ],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: { type: "array", items: { $ref: "#/components/schemas/Notification" } },
                      nextCursor: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/notifications/{id}/read": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["notifications"],
          summary: "Mark a notification as read (idempotent)",
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Notification" } } } },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },

      "/admin/users": {
        get: {
          tags: ["admin"],
          summary: "List users (ADMIN)",
          parameters: [
            { name: "role", in: "query", schema: { type: "string", enum: ["BUYER", "VENDOR", "ADMIN"] } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "OK" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/admin/vendors": {
        get: {
          tags: ["admin"],
          summary: "List vendors (ADMIN)",
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["PENDING", "VERIFIED", "REJECTED"] } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" } },
        },
      },
      "/admin/vendors/{id}/approve": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["admin"],
          summary: "Approve a vendor (ADMIN)",
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" }, 404: { $ref: "#/components/responses/NotFound" } },
        },
      },
      "/admin/vendors/{id}/reject": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["admin"],
          summary: "Reject a vendor (ADMIN)",
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" }, 404: { $ref: "#/components/responses/NotFound" } },
        },
      },
      "/admin/products": {
        get: {
          tags: ["admin"],
          summary: "List products (ADMIN)",
          parameters: [
            { name: "isActive", in: "query", schema: { type: "boolean" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" } },
        },
      },
      "/admin/products/{id}/approve": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["admin"],
          summary: "Approve / re-enable a product (ADMIN)",
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" }, 404: { $ref: "#/components/responses/NotFound" } },
        },
      },
      "/admin/products/{id}/disable": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["admin"],
          summary: "Disable a product (ADMIN)",
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" }, 404: { $ref: "#/components/responses/NotFound" } },
        },
      },
      "/admin/orders": {
        get: {
          tags: ["admin"],
          summary: "List orders (ADMIN)",
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["PENDING", "PAID", "COMPLETED", "FAILED"] } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" } },
        },
      },
      "/admin/orders/{id}/complete": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["admin"],
          summary: "Complete an order: PAID → COMPLETED, releases pending → available (ADMIN)",
          responses: {
            200: { description: "OK" },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
            409: { $ref: "#/components/responses/Conflict" },
          },
        },
      },
      "/admin/payments": {
        get: {
          tags: ["admin"],
          summary: "List payments (ADMIN)",
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["PENDING", "SUCCEEDED", "FAILED"] } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" } },
        },
      },
      "/admin/wallet-transactions": {
        get: {
          tags: ["admin"],
          summary: "List wallet ledger entries (ADMIN)",
          parameters: [
            { name: "type", in: "query", schema: { type: "string", enum: ["PAYMENT_PENDING_CREDIT", "PENDING_TO_AVAILABLE", "PAYOUT_DEBIT", "ADJUSTMENT_CREDIT", "ADJUSTMENT_DEBIT"] } },
            { name: "vendorId", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" } },
        },
      },
      "/admin/payout-requests": {
        get: {
          tags: ["admin"],
          summary: "List payout requests (ADMIN)",
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["PENDING", "APPROVED", "REJECTED", "PAID"] } },
          ],
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" } },
        },
      },
      "/admin/payout-requests/{id}/approve": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["admin"],
          summary: "Approve a payout request (ADMIN)",
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/PayoutRequest" } } } },
            401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" }, 404: { $ref: "#/components/responses/NotFound" }, 409: { $ref: "#/components/responses/Conflict" },
          },
        },
      },
      "/admin/payout-requests/{id}/reject": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["admin"],
          summary: "Reject a payout request (ADMIN)",
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object", properties: { reason: { type: "string" } } },
              },
            },
          },
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/PayoutRequest" } } } },
            401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" }, 404: { $ref: "#/components/responses/NotFound" }, 409: { $ref: "#/components/responses/Conflict" },
          },
        },
      },
      "/admin/payout-requests/{id}/mark-paid": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["admin"],
          summary: "Mark payout paid: APPROVED → PAID, debits availableBalance (ADMIN)",
          responses: {
            200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/PayoutRequest" } } } },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" }, 404: { $ref: "#/components/responses/NotFound" }, 409: { $ref: "#/components/responses/Conflict" },
          },
        },
      },
    // ─── Wallet ──────────────────────────────────────────────────────────
      "/wallet/me": {
        get: {
          tags: ["wallet"],
          summary: "Get buyer wallet balance",
          responses: {
            200: { description: "OK" },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/wallet/me/top-up": {
        post: {
          tags: ["wallet"],
          summary: "Start a wallet top-up (returns Stripe clientSecret, credits on webhook)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["amount"],
                  properties: {
                    amount: { type: "integer", minimum: 100, description: "Amount in cents", example: 5000 },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: "PaymentIntent created",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      clientSecret: { type: "string" },
                      paymentIntentId: { type: "string" },
                      amount: { type: "integer" },
                      currency: { type: "string" },
                    },
                  },
                },
              },
            },
            401: { $ref: "#/components/responses/Unauthorized" },
            502: { description: "Stripe unavailable" },
          },
        },
      },
      "/wallet/me/apply": {
        post: {
          tags: ["wallet"],
          summary: "Apply wallet balance to an order (atomic deduction)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["orderId", "amount"],
                  properties: {
                    orderId: { type: "string" },
                    amount: { type: "integer", minimum: 1 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Wallet deduction applied" },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/wallet/me/transactions": {
        get: {
          tags: ["wallet"],
          summary: "List wallet transaction history",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "OK" },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },

      // ─── Auth (new) ─────────────────────────────────────────────────────
      "/auth/forgot-password": {
        post: {
          tags: ["auth"],
          summary: "Request a password reset email",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["email"],
                  properties: { email: { type: "string", format: "email" } },
                },
              },
            },
          },
          responses: {
            200: { description: "If the email exists, a reset link is sent" },
            400: { $ref: "#/components/responses/BadRequest" },
          },
        },
      },
      "/auth/reset-password": {
        post: {
          tags: ["auth"],
          summary: "Reset password with token",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["token", "password"],
                  properties: {
                    token: { type: "string" },
                    password: { type: "string", minLength: 8, description: "Must contain uppercase, lowercase, and digit" },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Password reset successfully" },
            400: { $ref: "#/components/responses/BadRequest" },
          },
        },
      },
      "/auth/verify-email": {
        post: {
          tags: ["auth"],
          summary: "Verify email address with token",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["token"],
                  properties: { token: { type: "string" } },
                },
              },
            },
          },
          responses: {
            200: { description: "Email verified" },
            400: { $ref: "#/components/responses/BadRequest" },
          },
        },
      },

      // ─── Reviews ────────────────────────────────────────────────────────
      "/reviews": {
        get: {
          tags: ["reviews"],
          summary: "List public approved reviews (vendorId or productId filter)",
          security: [],
          parameters: [
            { name: "vendorId", in: "query", schema: { type: "string" } },
            { name: "productId", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: {
              description: "List + summary",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            vendorId: { type: "string" },
                            productId: { type: "string", nullable: true },
                            rating: { type: "integer", minimum: 1, maximum: 5 },
                            comment: { type: "string", nullable: true },
                            buyerDisplayName: { type: "string", description: "Privacy-preserving display name (e.g. 'Jane D.')" },
                            buyerName: { type: "string", description: "Deprecated alias of buyerDisplayName" },
                            createdAt: { type: "string", format: "date-time" },
                          },
                        },
                      },
                      nextCursor: { type: "string", nullable: true },
                      averageRating: { type: "number", nullable: true },
                      totalReviews: { type: "integer" },
                    },
                  },
                },
              },
            },
          },
        },
        post: {
          tags: ["reviews"],
          summary: "Create a review (BUYER role only; one per buyer+order+product)",
          description: "Order must be PAID/CONFIRMED/PROCESSING/DISPATCHED/IN_TRANSIT/DELIVERED/COMPLETED. VENDOR/ADMIN roles → 403.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["orderId", "vendorId", "rating"],
                  properties: {
                    orderId: { type: "string" },
                    vendorId: { type: "string" },
                    productId: { type: "string" },
                    rating: { type: "integer", minimum: 1, maximum: 5 },
                    comment: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            201: { description: "Review created" },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
            409: { $ref: "#/components/responses/Conflict" },
          },
        },
      },
      "/admin/reviews": {
        get: {
          tags: ["admin"],
          summary: "List all reviews (ADMIN, optional status filter)",
          parameters: [
            { name: "status", in: "query", schema: { type: "string", enum: ["APPROVED", "HIDDEN", "REJECTED", "PENDING"] } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: { 200: { description: "OK" }, 401: { $ref: "#/components/responses/Unauthorized" }, 403: { $ref: "#/components/responses/Forbidden" } },
        },
      },
      "/admin/reviews/{id}/moderate": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["admin"],
          summary: "Moderate a review: APPROVED, HIDDEN, or REJECTED (ADMIN)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status"],
                  properties: { status: { type: "string", enum: ["APPROVED", "HIDDEN", "REJECTED"] } },
                },
              },
            },
          },
          responses: {
            200: { description: "OK" },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },

      // ─── Promo Codes ────────────────────────────────────────────────────
      "/promo-codes/validate": {
        post: {
          tags: ["promos"],
          summary: "Validate a promo code (check eligibility, returns discount amount)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["code", "orderAmount"],
                  properties: {
                    code: { type: "string" },
                    orderAmount: { type: "integer", minimum: 1 },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Promo valid" },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            404: { $ref: "#/components/responses/NotFound" },
            409: { $ref: "#/components/responses/Conflict" },
          },
        },
      },
      "/promo-codes/redeem": {
        post: {
          tags: ["promos"],
          summary: "Redeem a promo code (atomic, one per order, race-safe)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["code", "orderAmount"],
                  properties: {
                    code: { type: "string" },
                    orderAmount: { type: "integer", minimum: 1 },
                    orderId: { type: "string" },
                  },
                },
              },
            },
          },
          responses: {
            200: { description: "Discount applied" },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            409: { $ref: "#/components/responses/Conflict" },
          },
        },
      },

      // ─── Referrals ──────────────────────────────────────────────────────
      "/referrals/stats": {
        get: {
          tags: ["referrals"],
          summary: "Get referral stats (code, total referred, total earned)",
          responses: {
            200: { description: "OK" },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },
      "/referrals/apply": {
        post: {
          tags: ["referrals"],
          summary: "Apply a referral code (credits on first paid order, not on signup)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["code"],
                  properties: { code: { type: "string" } },
                },
              },
            },
          },
          responses: {
            200: { description: "Referral applied (bonus credited on first paid order)" },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            409: { $ref: "#/components/responses/Conflict" },
          },
        },
      },

      // ─── Orders (vendor) ────────────────────────────────────────────────
      "/orders/vendor/list": {
        get: {
          tags: ["orders"],
          summary: "List vendor's orders",
          parameters: [
            { name: "status", in: "query", schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "OK" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/orders/vendor/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: {
          tags: ["orders"],
          summary: "Get a single vendor order",
          responses: {
            200: { description: "OK" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },
      "/orders/vendor/{id}/status": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        patch: {
          tags: ["orders"],
          summary: "Update vendor order status (e.g. PROCESSING, SHIPPED)",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["status"],
                  properties: { status: { type: "string" } },
                },
              },
            },
          },
          responses: {
            200: { description: "OK" },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            404: { $ref: "#/components/responses/NotFound" },
          },
        },
      },

      // ─── Reviews (additions for Round 6) ──────────────────────────────
      "/reviews/me": {
        get: {
          tags: ["reviews"],
          summary: "List the authenticated buyer's own reviews",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: { description: "OK" },
            401: { $ref: "#/components/responses/Unauthorized" },
          },
        },
      },

      // ─── Subscriptions ────────────────────────────────────────────────
      "/subscriptions/activate": {
        post: {
          tags: ["subscriptions"],
          summary: "Activate a subscription plan",
          description:
            "Soft-launch policy: only FREE activates without payment. Paid plans (BASIC/GROWTH/PREMIUM/PRO) return 409 SUBSCRIPTIONS_NOT_AVAILABLE. Use POST /api/subscriptions/checkout for paid plans; activation happens after the Stripe webhook confirms payment.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["plan"],
                  properties: { plan: { type: "string", enum: ["free", "growth", "pro"] } },
                },
              },
            },
          },
          responses: {
            200: {
              description: "Activated (FREE only)",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      subscription: { type: "object" },
                      limits: { type: "object" },
                    },
                  },
                },
              },
            },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
            409: {
              description: "SUBSCRIPTIONS_NOT_AVAILABLE — paid plans require checkout",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      message: { type: "string" },
                      code: { type: "string", example: "SUBSCRIPTIONS_NOT_AVAILABLE" },
                    },
                  },
                },
              },
            },
          },
        },
      },

      // ─── Vendors: Buyers ──────────────────────────────────────────────
      "/vendors/me/buyers": {
        get: {
          tags: ["vendors"],
          summary: "List buyers who purchased from this vendor",
          parameters: [
            { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            { name: "cursor", in: "query", schema: { type: "string" } },
          ],
          responses: {
            200: {
              description: "OK",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      items: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            buyerId: { type: "string" },
                            name: { type: "string" },
                            country: { type: "string", nullable: true },
                            totalOrders: { type: "integer" },
                            totalSpent: { type: "integer" },
                            lastOrderAt: { type: "string", format: "date-time" },
                          },
                        },
                      },
                      nextCursor: { type: "string", nullable: true },
                    },
                  },
                },
              },
            },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
          },
        },
      },

      // ─── Revenue Endpoints ─────────────────────────────────────────────
      "/vendors/me/analytics/revenue": {
        get: {
          tags: ["vendors"],
          summary: "Vendor revenue summary + daily series (canonical path)",
          parameters: [
            { name: "range", in: "query", schema: { type: "string", enum: ["7d", "30d", "90d"], default: "30d" } },
          ],
          responses: {
            200: {
              description: "Revenue summary",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      range: { type: "string" },
                      currency: { type: "string" },
                      totalRevenue: { type: "integer" },
                      pendingBalance: { type: "integer" },
                      availableBalance: { type: "integer" },
                      orderCount: { type: "integer" },
                      averageOrderValue: { type: "integer" },
                      series: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            date: { type: "string" },
                            revenue: { type: "integer" },
                            orders: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/vendors/me/revenue": {
        get: {
          tags: ["vendors"],
          summary: "Alias of /vendors/me/analytics/revenue (kept for back-compat)",
          parameters: [
            { name: "range", in: "query", schema: { type: "string", enum: ["7d", "30d", "90d"], default: "30d" } },
          ],
          responses: {
            200: { description: "Same shape as /vendors/me/analytics/revenue" },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/admin/analytics/revenue": {
        get: {
          tags: ["admin"],
          summary: "Platform-wide revenue with Stripe vs Paystack split (canonical path)",
          parameters: [
            { name: "range", in: "query", schema: { type: "string", enum: ["7d", "30d", "90d"], default: "30d" } },
          ],
          responses: {
            200: {
              description: "Revenue summary",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      range: { type: "string" },
                      currency: { type: "string" },
                      totalRevenue: { type: "integer" },
                      stripeRevenue: { type: "integer" },
                      paystackRevenue: { type: "integer" },
                      orderCount: { type: "integer" },
                      averageOrderValue: { type: "integer" },
                      series: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            date: { type: "string" },
                            revenue: { type: "integer" },
                            stripeRevenue: { type: "integer" },
                            paystackRevenue: { type: "integer" },
                            orders: { type: "integer" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
      "/admin/revenue": {
        get: {
          tags: ["admin"],
          summary: "Alias of /admin/analytics/revenue (kept for back-compat)",
          parameters: [
            { name: "range", in: "query", schema: { type: "string", enum: ["7d", "30d", "90d"], default: "30d" } },
          ],
          responses: {
            200: { description: "Same shape as /admin/analytics/revenue" },
            400: { $ref: "#/components/responses/BadRequest" },
            401: { $ref: "#/components/responses/Unauthorized" },
            403: { $ref: "#/components/responses/Forbidden" },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
});
