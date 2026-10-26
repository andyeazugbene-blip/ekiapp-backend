-- Monotonic marker for product stock transitions. Existing rows start at 0;
-- writers increment it whenever the stock value actually changes.
ALTER TABLE "Product" ADD COLUMN "stockVersion" INTEGER NOT NULL DEFAULT 0;
