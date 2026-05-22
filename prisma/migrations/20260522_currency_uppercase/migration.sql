-- Normalize all currency fields to uppercase ISO 4217 (EUR, GBP, NGN, etc.)
-- Fixes inconsistency between old rows (lowercase "eur") and new rows (uppercase "EUR").

UPDATE "Product"      SET currency = UPPER(currency) WHERE currency != UPPER(currency);
UPDATE "Wallet"       SET currency = UPPER(currency) WHERE currency != UPPER(currency);
UPDATE "BuyerWallet"  SET currency = UPPER(currency) WHERE currency != UPPER(currency);
UPDATE "Order"        SET currency = UPPER(currency) WHERE currency != UPPER(currency);
UPDATE "Payment"      SET currency = UPPER(currency) WHERE currency != UPPER(currency);
UPDATE "DeliveryZone" SET currency = UPPER(currency) WHERE currency != UPPER(currency);
UPDATE "Vendor"       SET currency = UPPER(currency) WHERE currency != UPPER(currency);
UPDATE "PaystackTransaction" SET currency = UPPER(currency) WHERE currency != UPPER(currency);
UPDATE "PayoutRequest" SET currency = UPPER(currency) WHERE currency != UPPER(currency);
UPDATE "WalletTransaction" SET currency = UPPER(currency) WHERE currency != UPPER(currency);
UPDATE "BuyerWalletTransaction" SET currency = UPPER(currency) WHERE currency != UPPER(currency);
