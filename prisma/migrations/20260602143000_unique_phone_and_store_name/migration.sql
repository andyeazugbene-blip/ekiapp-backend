ALTER TABLE "User"
ADD CONSTRAINT "User_phone_key" UNIQUE ("phone");

ALTER TABLE "Vendor"
ADD CONSTRAINT "Vendor_storeName_key" UNIQUE ("storeName");
