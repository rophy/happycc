-- Refresh reuse grace window: ordering and one-retry-per-rotation.
ALTER TABLE "RetiredRefreshToken" ADD COLUMN "seq" SERIAL NOT NULL;
ALTER TABLE "RetiredRefreshToken" ADD COLUMN "graceEligible" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "RetiredRefreshToken_deviceId_seq_idx" ON "RetiredRefreshToken"("deviceId", "seq");
