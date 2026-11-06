-- Handbook 8.5: first sale diagnostic and post-sale transition.
ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'FIRST_SALE_DIAGNOSTIC';
ALTER TYPE "AutomationType" ADD VALUE IF NOT EXISTS 'POST_SALE_TRANSITION';
