DROP TABLE "TerminalAuthRequest";
DROP TABLE "AccountAuthRequest";

ALTER TABLE "Account"
    ADD COLUMN "oidcIssuer" TEXT,
    ADD COLUMN "oidcSubject" TEXT,
    ADD COLUMN "email" TEXT,
    ADD COLUMN "wrappedRootSecret" TEXT,
    ADD COLUMN "disabledAt" TIMESTAMP(3),
    ADD COLUMN "idpRefreshToken" TEXT,
    ADD COLUMN "idpCheckedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "Account_oidcIssuer_oidcSubject_key" ON "Account"("oidcIssuer", "oidcSubject");

CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT,
    "refreshTokenHash" TEXT NOT NULL,
    "sessionStartedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Device_refreshTokenHash_key" ON "Device"("refreshTokenHash");
CREATE INDEX "Device_accountId_idx" ON "Device"("accountId");
ALTER TABLE "Device" ADD CONSTRAINT "Device_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RetiredRefreshToken" (
    "tokenHash" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "retiredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RetiredRefreshToken_pkey" PRIMARY KEY ("tokenHash")
);
CREATE INDEX "RetiredRefreshToken_deviceId_idx" ON "RetiredRefreshToken"("deviceId");
ALTER TABLE "RetiredRefreshToken" ADD CONSTRAINT "RetiredRefreshToken_deviceId_fkey"
    FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "DeviceAuthRequest" (
    "id" TEXT NOT NULL,
    "deviceCodeHash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedAccountId" TEXT,
    "ephemeralPublicKey" TEXT NOT NULL,
    "clientInfo" JSONB NOT NULL,
    "lastPolledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DeviceAuthRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeviceAuthRequest_deviceCodeHash_key" ON "DeviceAuthRequest"("deviceCodeHash");
CREATE UNIQUE INDEX "DeviceAuthRequest_userCode_key" ON "DeviceAuthRequest"("userCode");
ALTER TABLE "DeviceAuthRequest" ADD CONSTRAINT "DeviceAuthRequest_approvedAccountId_fkey"
    FOREIGN KEY ("approvedAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "OidcExchangeCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "clientKind" TEXT NOT NULL,
    "pkceChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OidcExchangeCode_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "OidcExchangeCode_codeHash_key" ON "OidcExchangeCode"("codeHash");
ALTER TABLE "OidcExchangeCode" ADD CONSTRAINT "OidcExchangeCode_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
